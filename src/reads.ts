import { AxiError } from "axi-sdk-js";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { credentialStore } from "./profiles.js";
import { REGIONS } from "./regions.js";
import { gateway, READ_LIMITS, type ReadRequest } from "./transport.js";
import { responseInvalid } from "./response-invalid.js";

const day = 86_400_000;
const timestamp = z.iso.datetime({ offset: true });
const filters = z.array(z.strictObject({ saasAttrName: z.string().min(1),
  saasAttrOp: z.enum(["is", "contains", "startsWith", "isEmpty", "isNot", "notContains", "isNotEmpty", "greaterThan", "lessThan"]),
  saasAttrValue: z.string() }));
const continuation = z.strictObject({ version: z.literal(1), binding: z.string(), start: timestamp, end: timestamp,
  scroll: z.string().optional(), offset: z.number().int().nonnegative(), replayRisk: z.literal(true).optional() });
// The guide's prose/table (pp.11,14) says security-result array; its JSON examples use an object.
const securityResults = z.object({ combinedVerdict: z.unknown().optional() }).passthrough();
// Entity schemas and SaaS-specific payloads: guide pages 11-15 and 21-24.
const entity = z.object({ entityInfo: z.object({ entityId: z.string().min(1), entityActionState: z.string().optional() }).passthrough(),
  entityPayload: z.object({ subject: z.string().optional() }).passthrough(),
  entitySecurityResults: z.union([securityResults, z.array(z.object({}).passthrough())]).optional(),
}).passthrough();
// Event and task fields: guide pages 31-32, 35-36 and 40-41.
const event = z.object({ eventId: z.string().min(1), type: z.string(), state: z.string(), severity: z.string() }).passthrough();
const task = z.object({ id: z.union([z.string().min(1), z.number().int().nonnegative()]),
  status: z.enum(["init", "inprogress", "completed", "failed", "stopped", "paused"]),
  actions: z.array(z.object({ action_status: z.string() }).passthrough()),
  progress: z.number().nonnegative(), total: z.number().nonnegative(),
}).passthrough();
const invalid = (message: string): never => { throw new AxiError(message, "VALIDATION_ERROR", ["Run checkpoint-axi <email search|email show|event list|event show|task show> --help"]); };

export async function readCommand(name: "email search" | "email show" | "event list" | "event show" | "task show", id: string | undefined, flags: Map<string, string>,
  store: ReturnType<typeof credentialStore>, transport?: Parameters<typeof gateway>[3]): Promise<Record<string, unknown>> {
  const isEvent = name.startsWith("event ");
  if (name.endsWith(" show") && (!id || !/^[A-Za-z0-9_-]+$/.test(id))) invalid(`${name} requires one ID containing letters, digits, underscores or hyphens`);
  const limitText = flags.get("--limit") ?? "50";
  if (!/^[1-9][0-9]*$/.test(limitText) || Number(limitText) > READ_LIMITS.rows) invalid("--limit must be an integer from 1 to 1000");
  if (flags.has("--all") && flags.has("--limit")) invalid("Use either --all or --limit");
  const limit = flags.has("--all") ? READ_LIMITS.rows : Number(limitText);
  if (!flags.has("--expand") && (flags.has("--expand-limit") || flags.has("--expand-requests"))) invalid("Expansion limits require --expand");
  const expandLimitText = flags.get("--expand-limit") ?? "5";
  const expandRequestsText = flags.get("--expand-requests") ?? "10";
  if (!/^[1-8]$/.test(expandLimitText)) invalid("--expand-limit must be an integer from 1 to 8");
  if (!/^(?:[2-9]|10)$/.test(expandRequestsText)) invalid("--expand-requests must be an integer from 2 to 10");
  let extended: z.infer<typeof filters> | undefined;
  if (flags.has("--filter")) {
    let raw: unknown;
    try { raw = JSON.parse(flags.get("--filter")!); } catch { invalid("--filter must be a JSON array of attribute filters"); }
    const parsed = filters.safeParse(raw);
    if (!parsed.success) invalid("--filter must contain saasAttrName, a documented saasAttrOp and saasAttrValue");
    extended = parsed.data;
  }
  let cursor: z.infer<typeof continuation> | undefined;
  if (flags.has("--cursor")) {
    try {
      const encoded = flags.get("--cursor")!;
      if (!/^[A-Za-z0-9_-]+$/.test(encoded)) invalid("Invalid continuation cursor");
      cursor = continuation.parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
    } catch { invalid("Invalid continuation cursor"); }
  }
  const end = flags.get("--end-date") ?? cursor?.end ?? new Date().toISOString();
  if (!timestamp.safeParse(end).success) invalid("--end-date must be an ISO timestamp with timezone");
  const start = flags.get("--start-date") ?? cursor?.start ?? new Date(Date.parse(end) - day).toISOString();
  if (!timestamp.safeParse(start).success) invalid("--start-date must be an ISO timestamp with timezone");
  const window = Date.parse(end) - Date.parse(start);
  if (window <= 0 || window > 31 * day) invalid("Search window must be positive and at most 31 days");
  for (const flag of ["--saas", "--saas-entity"]) if (flags.has(flag) && !flags.get(flag)!.trim()) invalid(`${flag} must not be blank`);
  const eventSelectors: Extract<ReadRequest, { path: "/event/query" }>["body"] = {};
  for (const [flag, key] of [["event-types", "eventTypes"], ["event-states", "eventStates"], ["severities", "severities"], ["event-ids", "eventIds"], ["saas", "saas"]] as const) {
    if (!isEvent || !flags.has(`--${flag}`)) continue;
    const values = flags.get(`--${flag}`)!.split(",").map((value) => value.trim());
    if (values.some((value) => !value)) invalid(`--${flag} must contain nonempty comma-separated values`);
    eventSelectors[key] = values;
  }
  for (const [flag, key] of [["confidence-indicator", "confidenceIndicator"], ["description", "description"]] as const) {
    if (!flags.has(`--${flag}`)) continue;
    const value = flags.get(`--${flag}`)!.trim();
    if (!value) invalid(`--${flag} must not be blank`);
    eventSelectors[key] = value;
  }
  store.readOnly();
  const profile = store.select(store.load(flags.get("--config"), true).config, flags.get("--profile"));
  const saas = flags.get("--saas")?.trim() ?? profile.saas;
  const entityFilter = { saas, ...(flags.has("--saas-entity") ? { saasEntity: flags.get("--saas-entity")!.trim() } : {}), startDate: start, endDate: end };
  const selectors = { ...eventSelectors, saas: eventSelectors.saas ?? [saas], startDate: start, endDate: end };
  const binding = createHash("sha256").update(JSON.stringify({ profile: profile.name, client: profile.clientId,
    origin: REGIONS[profile.region], operation: name, ...(isEvent ? { selectors } : { entityFilter, extended }) })).digest("hex");
  if (cursor && cursor.binding !== binding) invalid("Cursor does not match this profile, region or search selectors; repeat the original selectors");
  const api = gateway(profile, store.credentials(profile, true), store.redactor, transport, false, Number(expandRequestsText));
  async function detail(id: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new AxiError("Invalid detail ID", "RESPONSE_INVALID", []);
    const kind = name.split(" ")[0]!;
    const page = await api.read({ path: name === "task show" ? `/task/${id}` : isEvent ? `/event/${id}` : `/search/entity/${id}` });
    const response = { responseData: page.dataIsArray ? page.records : page.records[0] };
    const recordPath = page.dataIsArray ? ["responseData", 0] : ["responseData"];
    if (page.records.length === 0) throw new AxiError(`${kind} was not found`, "NOT_FOUND", []);
    const parsed = (name === "task show" ? task : isEvent ? event : entity).safeParse(page.records[0]);
    if (page.records.length !== 1) throw responseInvalid(`Invalid ${kind} detail response`, response, [["responseData"]]);
    if (!parsed.success) throw responseInvalid(`Invalid ${kind} detail response`, response,
      parsed.error.issues.map((issue) => [...recordPath, ...issue.path]));
    const record = page.records[0] as Record<string, unknown>;
    const returnedId = name === "task show" ? String(record.id) : isEvent ? record.eventId : (record.entityInfo as { entityId?: string } | undefined)?.entityId;
    if (returnedId !== id) throw responseInvalid(`Invalid ${kind} detail response`, response,
      [[...recordPath, ...(name === "task show" ? ["id"] : isEvent ? ["eventId"] : ["entityInfo", "entityId"])]]);
    return parsed.data;
  }
  if (name.endsWith(" show")) return { [name.split(" ")[0]!]: await detail(id!) };
  const results: Record<string, unknown>[] = [];
  let scroll = cursor?.scroll;
  let offset = cursor?.offset ?? 0;
  let replayRisk = cursor?.replayRisk ?? offset > 0;
  let total: number | undefined;
  let exhausted = false;
  while (results.length < limit) {
    let page;
    try {
      page = await api.read(isEvent ? { path: "/event/query", body: { ...selectors, ...(scroll === undefined ? {} : { scrollId: scroll }) } }
        : { path: "/search/query", body: { entityFilter,
          ...(extended === undefined ? {} : { entityExtendedFilter: extended }), ...(scroll === undefined ? {} : { scrollId: scroll }) } });
    } catch (error) {
      if (results.length && error instanceof AxiError && ["REQUEST_BUDGET", "TIME_BUDGET", "RESPONSE_TOO_LARGE"].includes(error.code)) break;
      throw error;
    }
    const parsed = z.array(isEvent ? event : entity).safeParse(page.records);
    const response = { responseData: page.dataIsArray ? page.records : page.records[0] };
    if (!parsed.success) throw responseInvalid("Invalid search response", response,
      parsed.error.issues.map((issue) => ["responseData", ...(page.dataIsArray ? issue.path : issue.path.slice(1))]));
    if (offset > page.records.length) throw responseInvalid("Invalid search response", response, [["responseData"]]);
    // Never wrap an echoed credential in a reversible continuation cursor.
    if (page.scrollId && store.redactor.text(page.scrollId) !== page.scrollId) throw responseInvalid("Unsafe API scrollId", { responseEnvelope: { scrollId: page.scrollId } }, [["responseEnvelope", "scrollId"]]);
    total = page.total ?? total;
    const rows = parsed.data.slice(offset, offset + limit - results.length);
    results.push(...rows.map((record) => {
      if (isEvent) { const value = event.parse(record); return { id: value.eventId, type: value.type, state: value.state, severity: value.severity }; }
      const value = entity.parse(record);
      return { id: value.entityInfo.entityId, subject: value.entityPayload.subject ?? "",
        state: value.entityInfo.entityActionState ?? "", verdict: Array.isArray(value.entitySecurityResults) ? null : value.entitySecurityResults?.combinedVerdict ?? null };
    }));
    offset += rows.length;
    if (offset < page.records.length) { replayRisk = true; break; }
    if (!page.scrollId) { exhausted = true; break; }
    scroll = page.scrollId;
    offset = 0;
  }
  const next = exhausted ? undefined : Buffer.from(JSON.stringify({ version: 1, binding, start, end, scroll, offset,
    ...(replayRisk ? { replayRisk: true } : {}) })).toString("base64url");
  let expansion: Record<string, unknown> | undefined;
  if (flags.has("--expand")) {
    let attempted = 0;
    let expanded = 0;
    let stopped: { reason: string; code: string } | undefined;
    const notExpanded: { id: string; reason: string; code?: string }[] = [];
    for (const row of results) {
      const itemId = row.id as string;
      if (stopped) { notExpanded.push({ id: itemId, ...stopped }); continue; }
      if (attempted >= Number(expandLimitText)) { notExpanded.push({ id: itemId, reason: "item-cap-reached" }); continue; }
      attempted++;
      try {
        row.detail = await detail(itemId);
        expanded++;
      } catch (error) {
        if (!(error instanceof AxiError)) throw error;
        const code = error.code;
        if (["REQUEST_BUDGET", "TIME_BUDGET", "RESPONSE_TOO_LARGE"].includes(code)) {
          stopped = { reason: code === "REQUEST_BUDGET" ? "request-cap-reached" : "budget-exhausted", code };
          notExpanded.push({ id: itemId, ...stopped });
        } else notExpanded.push({ id: itemId, reason: "per-item-error", code });
      }
    }
    expansion = { expanded, attempted, itemLimit: Number(expandLimitText), requestLimit: Number(expandRequestsText), complete: notExpanded.length === 0, notExpanded };
  }
  return { [isEvent ? "events" : "emails"]: results, count: results.length, ...(total === undefined ? {} : { total }), complete: exhausted && !replayRisk,
    ...(expansion ? { expansion } : {}),
    ...(replayRisk ? { reason: "replay-may-skip-or-repeat" } : {}), ...(next ? { cursor: next } : {}),
    help: [...(results.length ? [isEvent ? "Run checkpoint-axi event show <id> for event details and available actions" : "Run checkpoint-axi email show <id> for verdicts, actions and available actions"] : [`No ${isEvent ? "events" : "emails"} matched this search window and selectors`]),
      ...(next ? ["Repeat this search with --cursor <cursor> and the original selectors to continue"] : []),
      ...(replayRisk ? ["Results changed between calls may be skipped or repeated during page replay"] : [])] };
}
