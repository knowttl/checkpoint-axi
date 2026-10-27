import { AxiError } from "axi-sdk-js";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { credentialStore } from "./profiles.js";
import { REGIONS } from "./regions.js";
import { gateway, READ_LIMITS } from "./transport.js";

const day = 86_400_000;
const timestamp = z.iso.datetime({ offset: true });
const filters = z.array(z.strictObject({ saasAttrName: z.string().min(1),
  saasAttrOp: z.enum(["is", "contains", "startsWith", "isEmpty", "isNot", "notContains", "isNotEmpty", "greaterThan", "lessThan"]),
  saasAttrValue: z.string() }));
const continuation = z.strictObject({ version: z.literal(1), binding: z.string(), start: timestamp, end: timestamp,
  scroll: z.string().optional(), offset: z.number().int().nonnegative() });
// Entity schemas and SaaS-specific payloads: guide pages 11-15 and 21-24.
const entity = z.object({ entityInfo: z.object({ entityId: z.string().min(1), entityActionState: z.string().optional() }).passthrough(),
  entityPayload: z.object({ subject: z.string().optional() }).passthrough(),
  entitySecurityResults: z.object({ combinedVerdict: z.unknown().optional() }).passthrough().optional(),
}).passthrough();
const invalid = (message: string): never => { throw new AxiError(message, "VALIDATION_ERROR", ["Run checkpoint-axi email search --help or checkpoint-axi email show --help"]); };

export async function emailRead(name: "email search" | "email show", id: string | undefined, flags: Map<string, string>,
  store: ReturnType<typeof credentialStore>, transport?: Parameters<typeof gateway>[3]): Promise<Record<string, unknown>> {
  if (name === "email show" && (!id || !/^[A-Za-z0-9_-]+$/.test(id))) invalid("email show requires one entity ID containing letters, digits, underscores or hyphens");
  const limitText = flags.get("--limit") ?? "50";
  if (!/^[1-9][0-9]*$/.test(limitText) || Number(limitText) > READ_LIMITS.rows) invalid("--limit must be an integer from 1 to 1000");
  if (flags.has("--all") && flags.has("--limit")) invalid("Use either --all or --limit");
  const limit = flags.has("--all") ? READ_LIMITS.rows : Number(limitText);
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
  store.readOnly();
  const profile = store.select(store.load(flags.get("--config"), true).config, flags.get("--profile"));
  const saas = flags.get("--saas")?.trim() ?? profile.saas;
  const entityFilter = { saas, ...(flags.has("--saas-entity") ? { saasEntity: flags.get("--saas-entity")!.trim() } : {}), startDate: start, endDate: end };
  const binding = createHash("sha256").update(JSON.stringify({ profile: profile.name, client: profile.clientId,
    origin: REGIONS[profile.region], operation: name, entityFilter, extended })).digest("hex");
  if (cursor && cursor.binding !== binding) invalid("Cursor does not match this profile, region or search selectors; repeat the original selectors");
  const api = gateway(profile, store.credentials(profile, true), store.redactor, transport);
  if (name === "email show") {
    const page = await api.read({ path: `/search/entity/${id!}` });
    if (page.records.length === 0) throw new AxiError("Email was not found", "NOT_FOUND", []);
    const parsed = entity.safeParse(page.records[0]);
    if (page.records.length !== 1 || !parsed.success || parsed.data.entityInfo.entityId !== id) throw new AxiError("Invalid email detail response", "RESPONSE_INVALID", []);
    return { email: parsed.data };
  }
  const emails: Record<string, unknown>[] = [];
  let scroll = cursor?.scroll;
  let offset = cursor?.offset ?? 0;
  let total: number | undefined;
  let complete = false;
  while (emails.length < limit) {
    let page;
    try {
      page = await api.read({ path: "/search/query", body: { entityFilter,
        ...(extended === undefined ? {} : { entityExtendedFilter: extended }), ...(scroll === undefined ? {} : { scrollId: scroll }) } });
    } catch (error) {
      if (emails.length && error instanceof AxiError && ["REQUEST_BUDGET", "TIME_BUDGET", "RESPONSE_TOO_LARGE"].includes(error.code)) break;
      throw error;
    }
    const parsed = z.array(entity).safeParse(page.records);
    if (!parsed.success || offset > page.records.length) throw new AxiError("Invalid email search response", "RESPONSE_INVALID", []);
    // Never wrap an echoed credential in a reversible continuation cursor.
    if (page.scrollId && store.redactor.text(page.scrollId) !== page.scrollId) throw new AxiError("Unsafe API scrollId", "RESPONSE_INVALID", []);
    total = page.total ?? total;
    const rows = parsed.data.slice(offset, offset + limit - emails.length);
    emails.push(...rows.map((record) => ({ id: record.entityInfo.entityId, subject: record.entityPayload.subject ?? "",
      state: record.entityInfo.entityActionState ?? "", verdict: record.entitySecurityResults?.combinedVerdict ?? null })));
    offset += rows.length;
    if (offset < page.records.length) break;
    if (!page.scrollId) { complete = true; break; }
    scroll = page.scrollId;
    offset = 0;
  }
  const next = complete ? undefined : Buffer.from(JSON.stringify({ version: 1, binding, start, end, scroll, offset })).toString("base64url");
  return { emails, count: emails.length, ...(total === undefined ? {} : { total }), complete, ...(next ? { cursor: next } : {}),
    help: [...(emails.length ? ["Run checkpoint-axi email show <id> for verdicts, actions and available actions"] : ["No emails matched this search window and selectors"]),
      ...(next ? ["Repeat this search with --cursor <cursor> and the original selectors to continue"] : [])] };
}
