import { exceptionFamilies } from "./exceptions.js";

export const DESCRIPTION = "Inspect Check Point Email Security through compact, guarded AXI commands";
export const SETUP_GUIDANCE = "Run checkpoint-axi config path; configure a region, clientId and clientSecret env/file SecretRef";

const common = {
  config: "Config path; default CHECKPOINT_AXI_CONFIG or platform path",
  profile: "Profile name; default CHECKPOINT_AXI_PROFILE, env profile, config default, or sole profile",
  fields: "Comma-separated output fields; default all",
  full: "Show full strings instead of 500-character previews; default false",
  help: "Show concise command help; default false",
};
const paging = {
  "start-date": "ISO timestamp with timezone; default 24 hours before end-date; maximum window 31 days",
  "end-date": "ISO timestamp with timezone; default now",
  limit: "Maximum rows; default 50, range 1-1000; cannot combine with --all",
  all: "Read up to 1000 rows / 10 HTTP requests / 60 seconds / 8 MiB; default false",
  cursor: "Opaque continuation bound to profile, region, operation and selectors; repeat original selectors",
};
const exceptionType = `Required for ${["malware", "url", "dlp"].map((kind) => `${kind}: ${exceptionFamilies[kind as "malware" | "url" | "dlp"].types.join(",")}`).join("; ")}`;

const writeFlags = { ...common,
  ids: "Required comma-separated unique entity IDs; maximum 20",
  execute: "Send once after all write gates; default false (preview)",
  "dry-run": "Explicit preview; cannot combine with --execute",
  confirm: "Exact operation followed by a space and the comma-separated IDs in supplied order",
};

// Only shipped commands belong here. Inventory records are evidence, never dispatch.
export const catalogue = {
  "email quarantine": { description: "Preview or request asynchronous email quarantine through the gated write coordinator (guide pages 28-30)", flags: writeFlags,
    examples: ["checkpoint-axi email quarantine --ids <id>", "checkpoint-axi email quarantine --ids <id> --execute --confirm 'email.quarantine <id>'"] },
  "email restore": { description: "Preview or request asynchronous email restore through the gated write coordinator (guide pages 28-30)", flags: writeFlags,
    examples: ["checkpoint-axi email restore --ids <id>", "checkpoint-axi email restore --ids <id> --execute --confirm 'email.restore <id>'"] },
  "exception list": { description: "List bounded exceptions for phishing-allow, phishing-block, spam-allow, anomaly, click-time, malware, url or dlp (guide pages 49-123)",
    flags: { ...common, type: exceptionType,
      items: "Click-time item routes instead of list routes; default false", limit: paging.limit, all: "Return up to 1000 rows within transport budgets; no server continuation parameter is documented" },
    examples: ["checkpoint-axi exception list phishing-allow", "checkpoint-axi exception list malware --type hash", "checkpoint-axi exception list click-time --items --all"] },
  "exception show": { description: "Show an exception by kind and ID/value; anomaly refuses ENDPOINT_UNVERIFIED pending commissioning (guide pages 52-123)",
    flags: { ...common, type: exceptionType, items: "Click-time item route instead of list route; default false" },
    examples: ["checkpoint-axi exception show phishing-block <id>", "checkpoint-axi exception show url <value> --type allow-url", "checkpoint-axi exception show click-time <id> --items --full"] },
  "event list": { description: "List security events with bounded scroll continuation (API guide pages 37-42)", flags: { ...common, ...paging,
    saas: "Comma-separated SaaS overrides; default selected profile saas or office365_emails",
    "event-types": "Comma-separated event types; default unfiltered",
    "event-states": "Comma-separated event states; default unfiltered",
    severities: "Comma-separated severities; default unfiltered",
    "event-ids": "Comma-separated event IDs; default unfiltered",
    "confidence-indicator": "Confidence indicator selector; default unfiltered",
    description: "Description selector; default unfiltered",
  }, examples: ["checkpoint-axi event list", "checkpoint-axi event list --all --event-types phishing", "checkpoint-axi event list --cursor <cursor>"] },
  "event show": { description: "Show one event, actions taken and available actions (API guide pages 34-37)", flags: common,
    examples: ["checkpoint-axi event show <id>", "checkpoint-axi event show <id> --full"] },
  "task show": { description: "Show asynchronous task status and per-action details (API guide pages 30-33)", flags: common,
    examples: ["checkpoint-axi task show <id>", "checkpoint-axi task show <id> --full"] },
  "email search": { description: "Search emails with a bounded date window and scroll continuation (API guide pages 18-27)", flags: { ...common,
    saas: "SaaS override; default selected profile saas or office365_emails",
    "saas-entity": "Optional SaaS entity type selector",
    ...paging,
    filter: "JSON array of {saasAttrName, saasAttrOp, saasAttrValue} filters (guide pages 19-20)",
  }, examples: ["checkpoint-axi email search", "checkpoint-axi email search --all --saas office365_emails", "checkpoint-axi email search --cursor <cursor>"] },
  "email show": { description: "Show one email with verdicts, actions and available actions (API guide pages 10-18)", flags: common,
    examples: ["checkpoint-axi email show <id>", "checkpoint-axi email show <id> --full"] },
  doctor: { description: "Check regional API authentication and one bounded email search without printing tenant data", flags: { ...common, saas: "SaaS override; default selected profile saas or office365_emails" },
    examples: ["checkpoint-axi doctor", "checkpoint-axi doctor --profile example --saas office365_emails"] },
  home: { description: "Show local profile context without resolving secrets or making API calls", flags: common,
    examples: ["checkpoint-axi", "checkpoint-axi home --profile example"] },
  "auth status": { description: "Validate the selected local profile and secret source without API calls", flags: common,
    examples: ["checkpoint-axi auth status", "checkpoint-axi auth status --profile example"] },
  "profile list": { description: "List file profiles without resolving secrets; --profile does not filter this list", flags: common,
    examples: ["checkpoint-axi profile list", "checkpoint-axi profile list --config /example/config.json"] },
  "config path": { description: "Show config and state paths without reading files; --profile does not affect paths", flags: common,
    examples: ["checkpoint-axi config path", "checkpoint-axi config path --fields config"] },
} as const;

export function help(): Record<string, unknown> {
  return { description: DESCRIPTION, commands: Object.fromEntries(Object.entries(catalogue).map(([name, entry]) => [name, entry.description])),
    flags: common, version: "-v, -V, --version: print the bare version", examples: catalogue.home.examples };
}
