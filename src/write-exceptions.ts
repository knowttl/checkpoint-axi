import { AxiError } from "axi-sdk-js";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { exceptionFamilies } from "./exceptions.js";
import { readPrivateFile } from "./private-file.js";
import type { credentialStore } from "./profiles.js";
import { gateway, READ_LIMITS, type ExceptionPath } from "./transport.js";
import { coordinateWrite } from "./writes.js";

// Request parameter tables, not the contradictory string-boolean samples: guide pp.62-66, 76-80.
const criteria = { attachmentMd5: z.string(), senderEmail: z.string(), senderName: z.string(), recipient: z.string(),
  senderClientIp: z.string(), senderDomain: z.string(), senderIp: z.string(), linkDomains: z.string(), subject: z.string() };
const fields = { ...criteria, comment: z.string(), actionNeeded: z.string(), ignoringSpfCheck: z.boolean(),
  subjectMatching: z.string(), linkDomainMatching: z.string(), senderNameMatching: z.string(),
  senderDomainMatching: z.string(), senderEmailMatching: z.string(), recipientMatching: z.string() };
const payload = z.strictObject({ ...fields, entityId: z.string().regex(/^[A-Za-z0-9_-]+$/) }).partial();
const record = z.object({ entityId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.nullish()])) }).passthrough();
const fail = (code: string, message: string): never => { throw new AxiError(message, code, ["Run checkpoint-axi exception create --help; inspect the preview before execution"]); };

export async function exceptionWriteCommand(name: "exception create" | "exception update" | "exception remove", kind: string | undefined,
  id: string | undefined, flags: Map<string, string>, store: ReturnType<typeof credentialStore>, transport?: Parameters<typeof gateway>[3]) {
  if (kind !== "phishing-allow" && kind !== "phishing-block" && kind !== "spam-allow") {
    return fail("VALIDATION_ERROR", "Choose phishing-allow, phishing-block or spam-allow for C8 writes");
  }
  const action = name === "exception create" ? "create" : name === "exception update" ? "update" : "remove";
  if (action !== "create" && (!id || !/^[A-Za-z0-9_-]{1,256}$/.test(id))) return fail("VALIDATION_ERROR", "Supply one exception ID containing letters, digits, underscores or hyphens");
  if (flags.has("--execute") && flags.has("--dry-run")) return fail("VALIDATION_ERROR", "--execute cannot combine with --dry-run");
  let data: z.infer<typeof payload> | undefined;
  if (action !== "remove") {
    const path = flags.get("--input");
    if (!path || !isAbsolute(path)) return fail("VALIDATION_ERROR", "--input requires an absolute private JSON file path");
    let value: unknown;
    try { value = JSON.parse(readPrivateFile(path, true, true)); }
    catch (error) {
      if (error instanceof AxiError) throw error;
      return fail("VALIDATION_ERROR", "Cannot read a valid private JSON input file");
    }
    const parsed = payload.safeParse(value);
    if (!parsed.success || !Object.keys(criteria).some((key) => typeof (parsed.data as Record<string, unknown>)[key] === "string"
      && String((parsed.data as Record<string, unknown>)[key]).trim())) {
      return fail("VALIDATION_ERROR", "Input must contain documented requestData fields and at least one nonempty matching criterion; ignoringSpfCheck is boolean");
    }
    data = parsed.data;
    if (action === "update" && data.entityId !== undefined && data.entityId !== id) return fail("VALIDATION_ERROR", "Input entityId must match the exception ID");
  }
  // Canonical payload identity binds a new rule's confirmation without putting its contents in the journal.
  const canonical = data === undefined ? "" : JSON.stringify(Object.fromEntries(Object.entries(data).sort(([a], [b]) => a.localeCompare(b))));
  const target = action === "create" ? `sha256:${createHash("sha256").update(canonical).digest("hex")}` : id!;
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
  const path = exceptionFamilies[kind].path;
  const same = (item: Record<string, unknown>) => Object.keys(fields).every((key) => (item[key] ?? undefined) === (data as Record<string, unknown>)[key])
    && (data!.entityId === undefined || item.entityId === data!.entityId);
  const readState = async () => {
    const page = await session.read({ path: (action === "create" ? path : `${path}/${id}`) as ExceptionPath });
    const parsed = z.array(record).safeParse(page.records);
    if (!parsed.success || page.scrollId || page.total !== undefined && page.total > page.records.length
      || page.records.length > (action === "create" ? READ_LIMITS.rows : 1)
      || action !== "create" && parsed.data.some((item) => item.entityId !== id)
      || new Set(parsed.data.map((item) => item.entityId)).size !== parsed.data.length) {
      return fail("RESPONSE_INVALID", "Exception preflight returned incomplete, mismatched or malformed state");
    }
    if (action === "update" && !parsed.data.length) return fail("NOT_FOUND", "Exception to update was not found");
    const noop = action === "remove" ? parsed.data.length === 0 : parsed.data.some(same);
    return { noop, state: { existing: action === "create" ? parsed.data.filter(same) : parsed.data, ...(data ? { requested: data } : {}) } };
  };
  return coordinateWrite({ operation, targets: [target], flags, store, scope: { profile: profile.name, region: profile.region }, checkScope, readState,
    send: async (authorization) => {
      await session.exceptionWrite(authorization, kind, action, target, data);
      return { help: [`Run checkpoint-axi exception ${action === "create" ? `list ${kind}` : `show ${kind} ${id}`} to reconcile the accepted request; live behavior is uncommissioned`] };
    } });
}
