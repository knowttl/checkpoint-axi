export const DESCRIPTION = "Inspect Check Point Email Security through compact, guarded AXI commands";
export const SETUP_GUIDANCE = "Run checkpoint-axi config path; configure a region, clientId and clientSecret env/file SecretRef";

const common = {
  config: "Config path; default CHECKPOINT_AXI_CONFIG or platform path",
  profile: "Profile name; default CHECKPOINT_AXI_PROFILE, env profile, config default, or sole profile",
  fields: "Comma-separated output fields; default all",
  full: "Show full strings instead of 500-character previews; default false",
  help: "Show concise command help; default false",
};

// Only shipped commands belong here. Inventory records are evidence, never dispatch.
export const catalogue = {
  "email search": { description: "Search emails with a bounded date window and scroll continuation (API guide pages 18-27)", flags: { ...common,
    saas: "SaaS override; default selected profile saas or office365_emails",
    "saas-entity": "Optional SaaS entity type selector",
    "start-date": "ISO timestamp with timezone; default 24 hours before end-date; maximum window 31 days",
    "end-date": "ISO timestamp with timezone; default now",
    filter: "JSON array of {saasAttrName, saasAttrOp, saasAttrValue} filters (guide pages 19-20)",
    limit: "Maximum rows; default 50, range 1-1000; cannot combine with --all",
    all: "Read up to 1000 rows / 10 HTTP requests / 60 seconds / 8 MiB; default false",
    cursor: "Opaque continuation bound to profile, region, operation and selectors; repeat original selectors",
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
