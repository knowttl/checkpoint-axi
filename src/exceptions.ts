import { AxiError } from "axi-sdk-js";
import { z } from "zod";
import type { credentialStore } from "./profiles.js";
import { gateway, READ_LIMITS, type ExceptionPath } from "./transport.js";

// Read routes and selectors: guide pages 49-60, 69-74, 83, 87-91, 100-102, 110-112 and 120-123.
export const exceptionFamilies = {
  "phishing-allow": { path: "/exceptions/whitelist", types: [] },
  "phishing-block": { path: "/exceptions/blacklist", types: [] },
  "spam-allow": { path: "/exceptions/spam_whitelist", types: [] },
  anomaly: { path: "/sectools/anomaly/exceptions", types: [] },
  "click-time": { path: "/sectools/click_time_protection/exceptions", types: [] },
  malware: { path: "/sectool-exceptions/checkpoint2/exceptions", types: ["hash", "micro_hash", "file_type", "ppat_sender_name", "allow_file_type", "sender_email"] },
  url: { path: "/sectool-exceptions/avanan_url/exceptions", types: ["allow-url", "allow-domain", "block-url", "block-domain"] },
  dlp: { path: "/sectool-exceptions/avanan_dlp/exceptions", types: ["hash", "text_content", "sender_email", "recipient_email"] },
} as const;
// Only these families have published response fields (pages 50, 56-60 and 70-74).
const exception = z.object({ entityId: z.string().min(1), senderEmail: z.string().nullish(),
  subject: z.string().nullish(), comment: z.string().nullish() }).passthrough();

export async function exceptionCommand(name: "exception list" | "exception show", kind: string | undefined, value: string | undefined,
  flags: Map<string, string>, store: ReturnType<typeof credentialStore>, transport?: Parameters<typeof gateway>[3]): Promise<Record<string, unknown>> {
  const invalid = (message: string): never => { throw new AxiError(message, "VALIDATION_ERROR", [`Run checkpoint-axi ${name} --help`]); };
  if (!kind || !Object.hasOwn(exceptionFamilies, kind)) invalid(`Choose an exception kind: ${Object.keys(exceptionFamilies).join(", ")}`);
  const family = exceptionFamilies[kind as keyof typeof exceptionFamilies];
  const show = name === "exception show";
  const documented = family.path.startsWith("/exceptions/");
  const type = flags.get("--type");
  if (family.types.length ? !type || !(family.types as readonly string[]).includes(type) : type !== undefined) {
    invalid(family.types.length ? `--type must be one of: ${family.types.join(", ")}` : "--type is only valid for malware, url and dlp");
  }
  if (flags.has("--items") && kind !== "click-time") invalid("--items is only valid for click-time");
  if (show && (!value?.trim() || /[\u0000-\u001f\u007f]/.test(value) || value === "." || value === "..")) invalid("show requires one nonempty exception ID or value");
  if (show && documented && !/^[A-Za-z0-9_-]+$/.test(value!)) invalid("Exception ID must contain letters, digits, underscores or hyphens");
  const limitText = flags.get("--limit") ?? "50";
  if (!/^[1-9][0-9]*$/.test(limitText) || Number(limitText) > READ_LIMITS.rows) invalid("--limit must be an integer from 1 to 1000");
  if (flags.has("--all") && flags.has("--limit")) invalid("Use either --all or --limit");
  if (show && kind === "anomaly") throw new AxiError("Anomaly detail endpoint and response identity are undocumented (guide pages 83-84)",
    "ENDPOINT_UNVERIFIED", ["Use checkpoint-axi exception list anomaly; owner commissioning happens later through Artium"]);
  let path: string = family.path;
  if (type) path += `/${type}`;
  if (flags.has("--items")) path += "/items";
  if (show) {
    try { path += `/${encodeURIComponent(value!)}`; } catch { invalid("Exception value must be valid Unicode"); }
  }
  store.readOnly();
  const profile = store.select(store.load(flags.get("--config"), true).config, flags.get("--profile"));
  const api = gateway(profile, store.credentials(profile, true), store.redactor, transport);
  const page = await api.read({ path: path as ExceptionPath });
  if (documented && !z.array(exception).safeParse(page.records).success) throw new AxiError("Invalid exception response", "RESPONSE_INVALID", []);
  const unverified = documented ? {} : { responseSchema: "unverified" };
  if (show) {
    if (!page.records.length) throw new AxiError("Exception was not found", "NOT_FOUND", []);
    if (documented && (page.records.length !== 1 || exception.parse(page.records[0]).entityId !== value)) {
      throw new AxiError("Invalid exception detail response", "RESPONSE_INVALID", []);
    }
    return { exception: documented ? page.records[0] : page.records, ...unverified };
  }
  const limit = flags.has("--all") ? READ_LIMITS.rows : Number(limitText);
  const rows = page.records.slice(0, limit);
  const complete = rows.length === page.records.length && !page.scrollId && (page.total === undefined || page.total <= rows.length);
  return { exceptions: documented ? rows.map((row) => {
    const record = exception.parse(row);
    return { id: record.entityId, sender: record.senderEmail ?? "", subject: record.subject ?? "", comment: record.comment ?? "" };
  }) : rows, count: rows.length, ...(page.total === undefined ? {} : { total: page.total }), complete, ...unverified,
  ...(!complete ? { reason: "No continuation request parameter is documented for this exception route" } : {}),
  help: [rows.length ? kind === "anomaly" ? "Anomaly detail remains unavailable pending response identity commissioning"
    : `Run checkpoint-axi exception show ${kind} <id-or-value>${type ? ` --type ${type}` : ""}${flags.has("--items") ? " --items" : ""} for details`
    : `No ${kind} exceptions found`, ...(!complete && limit < READ_LIMITS.rows ? ["Repeat with --all for up to 1000 rows; server-side continuation remains undocumented"] : [])] };
}
