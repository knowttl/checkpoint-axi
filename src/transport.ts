import { AxiError } from "axi-sdk-js";
import { randomUUID } from "node:crypto";
import { request, type Agent } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import { REGIONS } from "./regions.js";
import type { SelectedProfile } from "./profiles.js";
import type { SecretRedactor } from "./redact.js";

export const READ_LIMITS = { requests: 10, rows: 1_000, milliseconds: 60_000, bytes: 8 * 1024 * 1024 } as const;
export type ExceptionPath = `/exceptions/${"whitelist" | "blacklist" | "spam_whitelist"}${"" | `/${string}`}`
  | `/sectools/${"anomaly" | "click_time_protection"}/exceptions${"" | `/${string}`}`
  | `/sectool-exceptions/${"checkpoint2" | "avanan_url" | "avanan_dlp"}/exceptions/${string}`;
export type ReadRequest =
  | { path: "/search/query"; body: { entityFilter: { saas: string; saasEntity?: string; startDate: string; endDate: string }; entityExtendedFilter?: { saasAttrName: string; saasAttrOp: string; saasAttrValue: string }[]; scrollId?: string } }
  | { path: `/search/entity/${string}`; body?: never }
  | { path: "/event/query"; body: { startDate?: string; endDate?: string; saas?: string[]; eventTypes?: string[]; eventStates?: string[]; severities?: string[]; eventIds?: string[]; confidenceIndicator?: string; description?: string; scrollId?: string } }
  | { path: `/event/${string}` | `/task/${string}`; body?: never }
  | { path: ExceptionPath; body?: never };
export type Page = { records: unknown[]; scrollId?: string; total?: number };
type Dependencies = { agent?: Agent; now?: () => number; wait?: (milliseconds: number) => Promise<unknown> };
const failure = (code: string, message: string) => new AxiError(message, code, ["Check the selected region and credentials; run checkpoint-axi doctor"]);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

// Object/array responseData inconsistency is documented on guide pages 35-37.
export function decodePage(value: unknown, unverified = false): Page {
  // These exception families publish no response schema (guide pages 83-123).
  if (unverified && (!object(value) || !Object.hasOwn(value, "responseEnvelope"))) {
    return { records: Array.isArray(value) ? value : [value] };
  }
  if (!object(value) || !object(value.responseEnvelope)) throw failure("RESPONSE_INVALID", "Missing API response envelope");
  const envelope = value.responseEnvelope;
  if (envelope.responseCode !== 0 && envelope.responseCode !== "0" && envelope.responseCode !== 200 && envelope.responseCode !== "200") {
    throw failure("API_ERROR", "API response envelope did not report success");
  }
  const data = value.responseData;
  if ((!unverified && !Array.isArray(data) && !object(data)) || data === undefined) throw failure("RESPONSE_INVALID", "Expected responseData");
  if (envelope.scrollId !== undefined && envelope.scrollId !== null && typeof envelope.scrollId !== "string") {
    throw failure("RESPONSE_INVALID", "Invalid API scrollId");
  }
  if (envelope.totalRecordsNumber !== undefined && (!Number.isSafeInteger(envelope.totalRecordsNumber) || Number(envelope.totalRecordsNumber) < 0)) {
    throw failure("RESPONSE_INVALID", "Invalid API totalRecordsNumber");
  }
  return { records: Array.isArray(data) ? data : [data], scrollId: typeof envelope.scrollId === "string" && envelope.scrollId ? envelope.scrollId : undefined,
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

export function gateway(profile: SelectedProfile, credentials: { clientId: string; clientSecret: string }, redactor: SecretRedactor, dependencies: Dependencies = {}) {
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
  async function send(path: string, body?: unknown, bearer?: string) {
    const remaining = deadline - now();
    if (remaining <= 0) throw failure("TIME_BUDGET", "Read time budget exhausted");
    if (++requests > READ_LIMITS.requests) throw failure("REQUEST_BUDGET", "Read request budget exhausted");
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (bearer) redactor.add(`Bearer ${bearer}`);
    return new Promise<{ status: number; retryAfter?: string; value: unknown }>((resolve, reject) => {
      const req = request(new URL(path, REGIONS[profile.region]), {
        method: payload === undefined ? "GET" : "POST", agent: dependencies.agent,
        headers: { "x-av-req-id": randomUUID(), accept: "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }) },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > READ_LIMITS.bytes) req.destroy(failure("RESPONSE_TOO_LARGE", "Read response byte budget exhausted"));
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
          try { resolve({ status, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown }); }
          catch { reject(failure("RESPONSE_INVALID", "API returned invalid JSON")); }
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
  async function read(query: ReadRequest): Promise<Page> {
    await authenticate();
    const group = /^\/exceptions\/(whitelist|blacklist)(\/|$)/.test(query.path) ? "phishing"
      : /^\/(exceptions|sectools|sectool-exceptions)\//.test(query.path) ? "other" : undefined;
    for (let retries = 0; ;) {
      if (group) {
        const remaining = (nextException.get(group) ?? 0) - now();
        if (remaining > 0) await pause(remaining);
        nextException.set(group, now() + (group === "phishing" ? 1_000 : 100));
      }
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
  return { authenticate, read };
}
