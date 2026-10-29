import { AxiError } from "axi-sdk-js";
import { randomUUID } from "node:crypto";
import { request, type Agent } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import { REGIONS } from "./regions.js";
import type { SelectedProfile } from "./profiles.js";
import type { SecretRedactor } from "./redact.js";
import { consumeWriteAuthorization, type WriteAuthorization } from "./writes.js";
import { responseInvalid } from "./response-invalid.js";

export const READ_LIMITS = { requests: 10, rows: 1_000, milliseconds: 60_000, bytes: 8 * 1024 * 1024 } as const;
export const DOWNLOAD_LIMIT = 50 * 1024 * 1024;
export type DownloadRequest = { entityId: string; attachmentId?: string; all?: boolean; original?: boolean; scope?: string };
export type ExceptionPath = `/exceptions/${"whitelist" | "blacklist" | "spam_whitelist"}${"" | `/${string}`}`
  | `/sectools/${"anomaly" | "click_time_protection"}/exceptions${"" | `/${string}`}`
  | `/sectool-exceptions/${"checkpoint2" | "avanan_url" | "avanan_dlp"}/exceptions/${string}`;
export type ReadRequest =
  | { path: "/search/query"; body: { entityFilter: { saas: string; saasEntity?: string; startDate: string; endDate: string }; entityExtendedFilter?: { saasAttrName: string; saasAttrOp: string; saasAttrValue: string }[]; scrollId?: string } }
  | { path: `/search/entity/${string}`; body?: never }
  | { path: "/event/query"; body: { startDate?: string; endDate?: string; saas?: string[]; eventTypes?: string[]; eventStates?: string[]; severities?: string[]; eventIds?: string[]; confidenceIndicator?: string; description?: string; scrollId?: string } }
  | { path: `/event/${string}` | `/task/${string}`; body?: never }
  | { path: ExceptionPath; body?: never };
export type Page = { records: unknown[]; dataIsArray: boolean; scrollId?: string; total?: number };
type Dependencies = { agent?: Agent; now?: () => number; wait?: (milliseconds: number) => Promise<unknown> };
const failure = (code: string, message: string) => new AxiError(message, code, ["Check the selected region and credentials; run checkpoint-axi doctor"]);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

// Object/array responseData inconsistency is documented on guide pages 35-37.
export function decodePage(value: unknown, unverified = false): Page {
  // These exception families publish no response schema (guide pages 83-123).
  if (unverified && (!object(value) || !Object.hasOwn(value, "responseEnvelope"))) {
    return { records: Array.isArray(value) ? value : [value], dataIsArray: Array.isArray(value) };
  }
  if (!object(value)) throw responseInvalid("Missing API response envelope", value, [[]]);
  if (!object(value.responseEnvelope)) throw responseInvalid("Missing API response envelope", value, [["responseEnvelope"]]);
  const envelope = value.responseEnvelope;
  if (envelope.responseCode !== 0 && envelope.responseCode !== "0" && envelope.responseCode !== 200 && envelope.responseCode !== "200") {
    throw failure("API_ERROR", "API response envelope did not report success");
  }
  const data = value.responseData;
  if ((!unverified && !Array.isArray(data) && !object(data)) || data === undefined) throw responseInvalid("Expected responseData", value, [["responseData"]]);
  if (envelope.scrollId !== undefined && envelope.scrollId !== null && typeof envelope.scrollId !== "string") {
    throw responseInvalid("Invalid API scrollId", value, [["responseEnvelope", "scrollId"]]);
  }
  if (envelope.totalRecordsNumber !== undefined && (!Number.isSafeInteger(envelope.totalRecordsNumber) || Number(envelope.totalRecordsNumber) < 0)) {
    throw responseInvalid("Invalid API totalRecordsNumber", value, [["responseEnvelope", "totalRecordsNumber"]]);
  }
  return { records: Array.isArray(data) ? data : [data], dataIsArray: Array.isArray(data), scrollId: typeof envelope.scrollId === "string" && envelope.scrollId ? envelope.scrollId : undefined,
    total: envelope.totalRecordsNumber as number | undefined };
}

// No field name or lifetime is commissioned yet (guide page 8).
function tokenFrom(value: unknown, redactor: SecretRedactor): string {
  const register = (child: unknown): void => {
    if (typeof child === "string") redactor.add(child);
    else if (Array.isArray(child)) child.forEach(register);
    else if (object(child)) Object.values(child).forEach(register);
  };
  register(value);
  const tokens = new Set<string>();
  let invalid = false;
  if (object(value)) for (const container of [value, value.data, value.responseData]) {
    if (!object(container)) continue;
    for (const key of ["token", "access_token", "accessToken"]) {
      const candidate = container[key];
      if (candidate === undefined) continue;
      if (typeof candidate === "string" && candidate.length > 0 && /^[\x21-\x7E]+$/.test(candidate)) tokens.add(candidate);
      else invalid = true;
    }
  }
  if (invalid || tokens.size !== 1) throw failure("AUTH_SHAPE_UNVERIFIED", "Unverified auth token response shape; owner commissioning is required (API guide page 8 does not specify the shape)");
  return [...tokens][0]!;
}

export function gateway(profile: SelectedProfile, credentials: { clientId: string; clientSecret: string }, redactor: SecretRedactor, dependencies: Dependencies = {}, mutation = false, requestLimit: number = READ_LIMITS.requests) {
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.wait ?? delay;
  const deadline = now() + READ_LIMITS.milliseconds;
  let bytes = 0;
  let requests = 0;
  let token: string | undefined;
  let refreshed = false;
  const nextException = new Map<string, number>();
  redactor.add(credentials.clientSecret);
  redactor.add(JSON.stringify({ clientId: credentials.clientId, accessKey: credentials.clientSecret }));

  async function pause(milliseconds: number) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0 || now() + milliseconds >= deadline) throw failure("TIME_BUDGET", "Read time budget exhausted");
    await wait(milliseconds);
  }
  async function send(path: string, body?: unknown, bearer?: string, method = body === undefined ? "GET" : "POST", allowEmpty = false, binary = false, scopes?: string) {
    const remaining = deadline - now();
    if (remaining <= 0) throw failure("TIME_BUDGET", "Read time budget exhausted");
    if (++requests > (mutation ? 44 : Math.min(requestLimit, READ_LIMITS.requests))) throw failure("REQUEST_BUDGET", "Request budget exhausted");
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (bearer) redactor.add(`Bearer ${bearer}`);
    return new Promise<{ status: number; retryAfter?: string; value: unknown; sha256?: string }>((resolve, reject) => {
      const req = request(new URL(path, REGIONS[profile.region]), {
        method, agent: dependencies.agent,
        headers: { "x-av-req-id": randomUUID(), accept: "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          ...(scopes === undefined ? {} : { scopes }),
          ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }) },
      }, (response) => {
        const chunks: Buffer[] = [];
        let received = 0;
        response.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (!binary) bytes += chunk.length;
          if (binary ? received > DOWNLOAD_LIMIT : bytes > READ_LIMITS.bytes) req.destroy(failure("RESPONSE_TOO_LARGE", "Response byte budget exhausted"));
          else chunks.push(chunk);
        });
        response.on("error", () => {
          clearTimeout(timer);
          reject(failure("NETWORK_ERROR", "API response stream failed"));
        });
        response.on("end", () => {
          clearTimeout(timer);
          const status = response.statusCode ?? 0;
          // Error bodies are untrusted and may echo credentials. Never render them.
          if (status < 200 || status >= 300) return resolve({ status, retryAfter: response.headers["retry-after"], value: undefined });
          if (binary) return resolve({ status, value: Buffer.concat(chunks), sha256: typeof response.headers["x-av-sha256"] === "string" ? response.headers["x-av-sha256"] : undefined });
          const json = Buffer.concat(chunks).toString("utf8");
          if (allowEmpty && status === 204 && !json) return resolve({ status, value: null });
          try { resolve({ status, value: JSON.parse(json) as unknown }); }
          catch { reject(responseInvalid("API returned invalid JSON", json, [[]])); }
        });
      });
      const timer = setTimeout(() => req.destroy(failure("TIME_BUDGET", "Read time budget exhausted")), remaining);
      req.on("error", (error) => {
        clearTimeout(timer);
        reject(error instanceof AxiError ? error : failure("NETWORK_ERROR", "Cannot reach the regional API with verified TLS"));
      });
      req.end(payload);
    });
  }
  async function authenticate() {
    if (token) return;
    const response = await send("/auth/external", { clientId: credentials.clientId, accessKey: credentials.clientSecret });
    if (response.status < 200 || response.status >= 300) throw failure("AUTH_FAILED", "Regional API authentication failed");
    token = tokenFrom(response.value, redactor);
  }
  async function spaceException(path: string) {
    const group = /^\/exceptions\/(whitelist|blacklist)(\/|$)/.test(path) ? "phishing"
      : /^\/(exceptions|sectools|sectool-exceptions)\//.test(path) ? "other" : undefined;
    if (group) {
      const remaining = (nextException.get(group) ?? 0) - now();
      if (remaining > 0) await pause(remaining);
      nextException.set(group, now() + (group === "phishing" ? 1_000 : 100));
    }
  }
  async function read(query: ReadRequest): Promise<Page> {
    await authenticate();
    for (let retries = 0; ;) {
      await spaceException(query.path);
      const response = await send(`/app/hec-api/v1.0${query.path}`, query.body === undefined ? undefined : { requestData: query.body }, token);
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        token = undefined;
        await authenticate();
        continue;
      }
      if (response.status === 429 && retries++ < 2) {
        const header = response.retryAfter;
        const milliseconds = header === undefined ? 1_000 : /^\d+$/.test(header) ? Number(header) * 1_000 : Math.max(0, Date.parse(header) - now());
        await pause(Number.isFinite(milliseconds) ? milliseconds : 1_000);
        continue;
      }
      if (response.status === 401) throw failure("AUTH_FAILED", "API rejected authentication after one re-exchange");
      if (response.status === 429) throw failure("RATE_LIMITED", "API rate limit remains after two read retries");
      if (response.status < 200 || response.status >= 300) throw failure("HTTP_ERROR", `Regional API returned HTTP ${response.status}`);
      return decodePage(response.value, /^\/(sectools|sectool-exceptions)\//.test(query.path));
    }
  }
  async function download(query: DownloadRequest): Promise<{ content: Buffer; sha256: string }> {
    if (!profile.downloads.allow) throw failure("DOWNLOADS_DISABLED", "Enable downloads.allow in the selected file profile");
    const validId = (value: string) => /^[A-Za-z0-9_-]{1,256}$/.test(value);
    if (!validId(query.entityId) || query.attachmentId !== undefined && !validId(query.attachmentId)
      || query.all && query.attachmentId !== undefined || (query.all || query.attachmentId !== undefined) && query.original !== undefined
      || query.scope !== undefined && !/^[\x21-\x7E]+$/.test(query.scope)
      || profile.scope !== undefined && !/^[\x21-\x7E]+$/.test(profile.scope)) throw failure("VALIDATION_ERROR", "Invalid download selectors or scopes");
    const attachment = query.all || query.attachmentId !== undefined;
    if (!attachment && !profile.scope) throw failure("DOWNLOAD_SCOPE_REQUIRED", "Email downloads require the profile scope for the scopes header");
    const params = new URLSearchParams();
    if (attachment && query.scope) params.set("scope", query.scope);
    if (!attachment) params.set("original", String(query.original ?? false));
    const path = `/app/hec-api/v1.0/download/entity/${encodeURIComponent(query.entityId)}${query.all ? "/attachments" : query.attachmentId ? `/attachment/${encodeURIComponent(query.attachmentId)}` : ""}${params.size ? `?${params}` : ""}`;
    await authenticate();
    for (let retries = 0; ;) {
      const response = await send(path, undefined, token, "GET", false, true, attachment ? undefined : profile.scope);
      if (response.status === 401 && !refreshed) {
        refreshed = true; token = undefined; await authenticate(); continue;
      }
      if (response.status === 429 && retries++ < 2) {
        const header = response.retryAfter;
        const milliseconds = header === undefined ? 1_000 : /^\d+$/.test(header) ? Number(header) * 1_000 : Math.max(0, Date.parse(header) - now());
        await pause(Number.isFinite(milliseconds) ? milliseconds : 1_000);
        continue;
      }
      if (response.status === 401) throw failure("AUTH_FAILED", "API rejected authentication after one re-exchange");
      if (response.status === 429) throw failure("RATE_LIMITED", "API rate limit remains after two download retries");
      if (response.status !== 200) throw failure("HTTP_ERROR", `Regional API returned HTTP ${response.status}`);
      if (!response.sha256 || !/^[a-fA-F0-9]{64}$/.test(response.sha256)) throw failure("DOWNLOAD_HASH_INVALID", "Download SHA-256 header is missing or invalid; commissioning may be required");
      return { content: response.value as Buffer, sha256: response.sha256.toLowerCase() };
    }
  }
  // Closed entity-action route; mutations never enter the read retry loop.
  async function emailAction(authorization: WriteAuthorization, action: "quarantine" | "restore", targets: readonly string[]): Promise<Page> {
    if (!mutation || !consumeWriteAuthorization(authorization, `email.${action}`, targets, profile.name, profile.region)) {
      throw failure("WRITES_DISABLED", "A one-use coordinator authorization is required");
    }
    await authenticate();
    try {
      const response = await send("/app/hec-api/v1.0/action/entity", { requestData: {
        entityIds: targets, entityActionName: [action], entityActionParam: [""],
      } }, token);
      if (response.status < 200 || response.status >= 300) throw new Error("Action response requires reconciliation");
      return decodePage(response.value);
    } catch {
      throw new AxiError("Email action outcome is unknown; never replay automatically", "OUTCOME_UNKNOWN", [
        "Inspect the write journal and read back every target before deciding what to do next",
      ]);
    }
  }
  // Closed event-action route; authorization cannot be reused or supplied by argv.
  async function eventAction(authorization: WriteAuthorization, action: string, targets: readonly string[]): Promise<Page> {
    if (!mutation || !consumeWriteAuthorization(authorization, `event.action.${action}`, targets, profile.name, profile.region)) {
      throw failure("WRITES_DISABLED", "A one-use coordinator authorization is required");
    }
    await authenticate();
    const response = await send("/app/hec-api/v1.0/action/event", { requestData: {
      eventIds: targets, eventActionName: [action], eventActionParam: [""],
    } }, token);
    if (response.status < 200 || response.status >= 300) throw failure("OUTCOME_UNKNOWN", "Event action outcome requires reconciliation; never replay automatically");
    return decodePage(response.value);
  }
  // Guide pp.61-69, 75-82: closed C8 routes; deletion is a bodyless POST.
  async function exceptionWrite(authorization: WriteAuthorization, kind: "phishing-allow" | "phishing-block" | "spam-allow",
    action: "create" | "update" | "remove", target: string, checkScopeBeforeSend: () => void, data?: Record<string, unknown>): Promise<void> {
    const routes = { "phishing-allow": "whitelist", "phishing-block": "blacklist", "spam-allow": "spam_whitelist" };
    if (!mutation || !Object.hasOwn(routes, kind) || !["create", "update", "remove"].includes(action)
      || !consumeWriteAuthorization(authorization, `exception.${kind}.${action}`, [target], profile.name, profile.region)) {
      throw failure("WRITES_DISABLED", "A one-use coordinator authorization is required");
    }
    await authenticate();
    const path = `/exceptions/${routes[kind]}${action === "create" ? "" : action === "remove" ? `/delete/${encodeURIComponent(target)}` : `/${encodeURIComponent(target)}`}`;
    await spaceException(path);
    checkScopeBeforeSend();
    const response = await send(`/app/hec-api/v1.0${path}`, action === "remove" ? undefined : { requestData: data }, token, action === "update" ? "PUT" : "POST");
    if (response.status < 200 || response.status >= 300 || !object(response.value) || !object(response.value.responseEnvelope)
      || ![0, "0", 200, "200", ...(action === "remove" ? [204, "204"] : [])].includes(response.value.responseEnvelope.responseCode as number | string)) {
      throw failure("OUTCOME_UNKNOWN", "Exception write acknowledgement requires reconciliation; never replay automatically");
    }
  }
  // Guide pp.84-99,102-127: closed routes; request bodies distinguish shared POSTs.
  // Response schemas are unpublished; preserve JSON, interpreting only HTTP/envelope status.
  async function sectoolsWrite(authorization: WriteAuthorization, kind: "anomaly" | "click-time" | "malware" | "url" | "dlp",
    action: "create" | "update" | "remove" | "remove-items", targets: readonly string[],
    checkScopeBeforeSend: () => void, data?: Record<string, unknown>, specific = false): Promise<unknown> {
    const sectools = { malware: "checkpoint2", url: "avanan_url", dlp: "avanan_dlp" };
    const sectool = Object.hasOwn(sectools, kind);
    if (sectool && action !== "create" && action !== "update") throw failure("ENDPOINT_UNVERIFIED", "Sectool deletes require commissioning; nothing was sent");
    if (!mutation || !["anomaly", "click-time", "malware", "url", "dlp"].includes(kind) || !["create", "update", "remove", "remove-items"].includes(action)
      || kind === "anomaly" && action !== "create" && action !== "remove"
      || specific && (!sectool || action !== "create")
      || action !== "remove-items" && targets.length !== 1
      || !consumeWriteAuthorization(authorization, `exception.${kind}.${action}`, targets, profile.name, profile.region)) {
      throw failure("WRITES_DISABLED", "A one-use coordinator authorization is required");
    }
    const path = sectool ? `/sectool-exceptions/${sectools[kind as keyof typeof sectools]}${specific ? "/exceptions" : ""}`
      : kind === "anomaly" ? "/sectools/anomaly/exceptions"
      : `/sectools/click_time_protection/exceptions/items${action === "update" || action === "remove" ? `/${encodeURIComponent(targets[0]!)}` : ""}`;
    await authenticate();
    await spaceException(path);
    checkScopeBeforeSend();
    const response = await send(`/app/hec-api/v1.0${path}`, kind === "click-time" && action === "remove" ? undefined : { requestData: data },
      token, action === "update" ? "PUT" : "POST", true);
    if (response.status < 200 || response.status >= 300 || object(response.value) && Object.hasOwn(response.value, "responseEnvelope")
      && (!object(response.value.responseEnvelope) || ![0, "0", 200, "200", 204, "204"].includes(response.value.responseEnvelope.responseCode as string | number))) {
      throw failure("OUTCOME_UNKNOWN", "Exception write status requires reconciliation; never replay automatically");
    }
    return response.value;
  }
  return { authenticate, read, download, emailAction, eventAction, exceptionWrite, sectoolsWrite };
}
