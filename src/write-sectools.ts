import { AxiError } from "axi-sdk-js";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { readPrivateFile } from "./private-file.js";
import type { credentialStore } from "./profiles.js";
import { gateway } from "./transport.js";
import { coordinateWrite } from "./writes.js";
import { exceptionFamilies } from "./exceptions.js";

export type SectoolsAction = "create" | "update" | "remove" | "remove-items" | "clear";
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const text = z.string().refine((value) => value.trim().length > 0);
// Request bodies only: guide pp.84,86,92-95,97-99 publishes no response schemas.
const anomalyInput = z.strictObject({ addedBy: z.string(), requestJson: z.strictObject({
  "whitelist-option:new_country": identifier, "apply-to-past": z.enum(["Yes", "No"]),
  "anomaly-comment": z.string(), event_id: identifier,
}) });
const clickInput = z.strictObject({ listItemName: text, listId: identifier, createdBy: z.string() });
const clickUpdate = clickInput.extend({ listItemId: identifier });
export type SectoolKind = "malware" | "url" | "dlp";
const condition = z.strictObject({ condition: text });
// Guide pp.103-106,113-117,123-127 supplies request examples, but no parameter tables.
const sectoolFields = { exception_type: text, exception_str: text, comment: z.string() };
const sectoolCreate = z.strictObject({ ...sectoolFields, entity_type: text, entity_id: text,
  file_name: z.string(), created_by_email: z.string(), is_exclusive: z.boolean() });
const malwareCreate = sectoolCreate.extend({ exception_payload: condition });
const sectoolUpdate = z.strictObject({ ...sectoolFields, exception_payload: condition });
const fail = (code: string, message: string): never => { throw new AxiError(message, code,
  ["Run checkpoint-axi exception create --help; live response identities remain unverified until commissioning through Artium"]); };

export async function sectoolsWriteCommand(action: SectoolsAction, kind: string, id: string | undefined,
  flags: Map<string, string>, store: ReturnType<typeof credentialStore>, transport?: Parameters<typeof gateway>[3]) {
  const sectool = kind === "malware" || kind === "url" || kind === "dlp";
  if (sectool && (action === "remove" || action === "clear")) {
    return fail("ENDPOINT_UNVERIFIED", "Malware, URL and DLP deletes duplicate create requests in the guide (pages 102-109, 113-119, 123-129); commissioning must establish the real requests");
  }
  if (sectool ? action !== "create" && action !== "update"
    : kind !== "anomaly" && kind !== "click-time" || kind === "anomaly" && action !== "create" && action !== "remove") {
    return fail("VALIDATION_ERROR", "Anomaly supports create/remove; click-time supports create/update/remove/remove-items/clear; malware/url/dlp support create/update");
  }
  if (flags.has("--specific") && (!sectool || action !== "create")) return fail("VALIDATION_ERROR", "--specific is only valid for malware, url or dlp create");
  if (sectool && id !== undefined) return fail("VALIDATION_ERROR", "Malware, URL and DLP updates identify the exception in --input; omit the positional ID");
  if (flags.has("--execute") && flags.has("--dry-run")) return fail("VALIDATION_ERROR", "--execute cannot combine with --dry-run");
  if (action === "clear") return fail("ENDPOINT_UNVERIFIED", "Click-time clear requires a trustworthy pre-read count; the response schema is undocumented (guide pages 87-88, 96-97)");
  if (action !== "remove-items" && flags.has("--ids")) return fail("VALIDATION_ERROR", "--ids is only valid for click-time remove-items");
  if (!sectool && (action === "update" || action === "remove") && !identifier.safeParse(id).success) return fail("VALIDATION_ERROR", "Supply one exception ID containing letters, digits, underscores or hyphens");
  let data: Record<string, unknown> | undefined;
  if (action === "create" || action === "update") {
    const path = flags.get("--input");
    if (!path || !isAbsolute(path)) return fail("VALIDATION_ERROR", "--input requires an absolute private JSON file path");
    let value: unknown;
    try { value = JSON.parse(readPrivateFile(path, true, true)); }
    catch (error) {
      if (error instanceof AxiError) throw error;
      return fail("VALIDATION_ERROR", "Cannot read a valid private JSON input file");
    }
    const parsed = (sectool ? action === "update" ? sectoolUpdate : kind === "malware" ? malwareCreate : sectoolCreate
      : kind === "anomaly" ? anomalyInput : action === "update" ? clickUpdate : clickInput).safeParse(value);
    if (!parsed.success) return fail("VALIDATION_ERROR", "Input must contain only the documented requestData fields for this operation");
    data = parsed.data;
    if (sectool && !(exceptionFamilies[kind as SectoolKind].types as readonly string[]).includes(String(data.exception_type))) return fail("VALIDATION_ERROR", "Input exception_type must be a documented type for the selected kind");
    if (!sectool && action === "update" && data.listItemId !== id) return fail("VALIDATION_ERROR", "Input listItemId must match the positional item ID");
  }
  const targets = action === "remove-items" ? flags.get("--ids")?.split(",") ?? [] : action === "create" || sectool
    ? [`sha256:${createHash("sha256").update(JSON.stringify(sectool ? { specific: flags.has("--specific"), data } : data)).digest("hex")}`] : [id!];
  if (!targets.length || targets.length > 20 || new Set(targets).size !== targets.length
    || action === "remove-items" && targets.some((target) => !identifier.safeParse(target).success)) {
    return fail("VALIDATION_ERROR", "Supply --ids with 1-20 unique comma-separated item IDs");
  }
  if (action === "remove-items") data = { listItemIds: targets };
  if (kind === "anomaly" && action === "remove") data = { ruleId: id };
  const operation = `exception.${kind}.${action}`;
  store.readOnly();
  const profile = store.select(store.load(flags.get("--config"), true).config, flags.get("--profile"));
  const checkScope = () => {
    if (store.readOnly() || !profile.writes.allowWrites) fail("WRITES_DISABLED", "Writes are disabled for the selected profile");
    if (!profile.writes.operations.includes(operation)) fail("OPERATION_NOT_WRITABLE", "Operation is outside the selected profile's exact write scope");
    const fresh = store.select(store.load(flags.get("--config"), true).config, flags.get("--profile"));
    if (JSON.stringify(fresh) !== JSON.stringify(profile)) fail("CONFIG_CHANGED", "Profile changed during the write; nothing was sent");
  };
  checkScope();
  const session = gateway(profile, store.credentials(profile, true), store.redactor, transport, true);
  // No existence/no-op inference is safe without documented response identities.
  // Both coordinator checks retain explicit uncertainty instead of inventing a list preflight.
  return coordinateWrite({ operation, targets, flags, store, scope: { profile: profile.name, region: profile.region }, checkScope,
    readState: async () => ({ noop: false, state: { targetState: "unverified", responseSchema: "unverified",
      reason: "Existence and no-op detection require live response identity commissioning", ...(data ? { requested: data } : {}) } }),
    send: async (authorization, checkScopeBeforeSend) => ({
      response: await session.sectoolsWrite(authorization, kind as "anomaly" | "click-time" | SectoolKind, action, targets, checkScopeBeforeSend, data, flags.has("--specific")),
      responseSchema: "unverified",
      help: [`Run checkpoint-axi exception list ${kind}${sectool ? ` --type ${String(data!.exception_type)}` : kind === "click-time" ? " --items" : ""} to inspect unverified JSON and reconcile; never replay automatically`],
    }) });
}
