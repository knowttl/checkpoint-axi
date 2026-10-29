import { AxiError } from "axi-sdk-js";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { catalogue, DESCRIPTION, help, SETUP_GUIDANCE } from "./catalogue.js";
import { credentialStore } from "./profiles.js";
import { doctor } from "./doctor.js";
import { readCommand } from "./reads.js";
import { exceptionCommand } from "./exceptions.js";
import { emailWriteCommand, eventWriteCommand } from "./writes.js";
import { exceptionWriteCommand } from "./write-exceptions.js";
import { downloadCommand } from "./downloads.js";
import type { gateway } from "./transport.js";

export async function localCommand(argv: string[], store: ReturnType<typeof credentialStore>, transport?: Parameters<typeof gateway>[3]): Promise<Record<string, unknown>> {
  if (argv.length === 1 && argv[0] === "--help") return help();
  const name = !argv.length || argv[0]?.startsWith("--") ? "home" : argv[0] === "home" || argv[0] === "doctor" ? argv[0] : argv.slice(0, 2).join(" ");
  const entry = Object.hasOwn(catalogue, name) ? catalogue[name as keyof typeof catalogue] : undefined;
  const usage = (message = "Unknown command, argument, duplicate or invalid flag"): never => { throw new AxiError(message, "VALIDATION_ERROR", [
    `Valid commands: ${Object.keys(catalogue).join(", ")}; valid flags: ${entry ? Object.keys(entry.flags).map((flag) => `--${flag}`).join(", ") : "run checkpoint-axi --help"}`,
  ]); };
  if (!entry) return usage();
  const flags = new Map<string, string>();
  const isExceptionWrite = name === "exception create" || name === "exception update" || name === "exception remove" || name === "exception remove-items" || name === "exception clear";
  const isException = name === "exception list" || name === "exception show" || isExceptionWrite;
  const isDownload = name === "email download" || name === "attachment download" || name === "attachment download-all";
  const kind = isException && !argv[2]?.startsWith("--") ? argv[2] : undefined;
  const idIndex = isException ? 3 : 2;
  const entityId = (isDownload || name.endsWith(" show") || name === "exception update" || name === "exception remove") && !argv[idIndex]?.startsWith("--") ? argv[idIndex] : undefined;
  const attachmentId = name === "attachment download" && entityId !== undefined && !argv[3]?.startsWith("--") ? argv[3] : undefined;
  const start = name === "home" ? (argv[0] === "home" ? 1 : 0) : name === "doctor" ? 1
    : isException ? 2 + Number(kind !== undefined) + Number(entityId !== undefined) : entityId === undefined ? 2 : 3 + Number(attachmentId !== undefined);
  for (let index = start; index < argv.length; index++) {
    const flag = argv[index]!;
    if (!flag.startsWith("--")) usage();
    if (!Object.hasOwn(entry.flags, flag.slice(2)) || flags.has(flag)) {
      const label = flag.split("=")[0]!;
      usage(/^--[A-Za-z][A-Za-z0-9-]*$/.test(label) ? `Unknown or duplicate flag ${label}` : undefined);
    }
    if (["--help", "--full", "--all", "--expand", "--items", "--specific", "--original", "--execute", "--dry-run"].includes(flag)) flags.set(flag, "true");
    else {
      const value = argv[++index];
      if (!value || value.startsWith("--")) usage();
      flags.set(flag, value!);
    }
  }
  if (flags.has("--help")) return { command: name, ...entry };
  const available = isException ? name === "exception list" ? ["exceptions", "count", "total", "complete", "reason", "responseSchema", "help"] : ["exception", "responseSchema"]
    : name === "email search" || name === "event list" ? [name === "event list" ? "events" : "emails", "count", "total", "complete", "reason", "cursor", "expansion", "help"] : name.endsWith(" show") ? [name.split(" ")[0]!]
    : name === "doctor" ? ["region", "saas", "checks", "pass", "help"] : name === "auth status" ? ["profile", "source", "region", "origin", "saas", "clientSecret", "readOnly"]
    : name === "profile list" ? ["profiles", "count", "config"] : name === "config path" ? ["config", "state"]
      : ["bin", "description", "status", "profiles", "count", "help"];
  const isWrite = name === "email quarantine" || name === "email restore" || name === "event action" || isExceptionWrite;
  if (isWrite) available.splice(0, available.length, "outcome", "preview", "auditId", "tasks", "response", "responseSchema", "help");
  if (isDownload) available.splice(0, available.length, "path", "size", "sha256");
  const fields = flags.get("--fields")?.split(",") ?? available;
  if (fields.some((field) => !available.includes(field)) || new Set(fields).size !== fields.length) usage();
  const config = flags.get("--config");
  let result: Record<string, unknown>;
  if (isDownload) result = await downloadCommand(name, entityId, attachmentId, flags, store, transport);
  else if (name === "exception create" || name === "exception update" || name === "exception remove" || name === "exception remove-items" || name === "exception clear") result = await exceptionWriteCommand(name, kind, entityId, flags, store, transport);
  else if (name === "event action") result = await eventWriteCommand(flags, store, transport);
  else if (name === "email quarantine" || name === "email restore") result = await emailWriteCommand(name, flags, store, transport);
  else if (name === "exception list" || name === "exception show") result = await exceptionCommand(name, kind, entityId, flags, store, transport);
  else if (name === "email search" || name === "email show" || name === "event list" || name === "event show" || name === "task show") result = await readCommand(name, entityId, flags, store, transport);
  else if (name === "doctor") result = await doctor(store, config, flags.get("--profile"), flags.get("--saas"), transport);
  else if (name === "auth status") result = store.status(config, flags.get("--profile"));
  else if (name === "profile list") result = store.list(config);
  else if (name === "config path") result = { config: store.configPath(config), state: store.statePath() };
  else {
    const listed = store.list(config);
    // Selection errors matter when context exists, but a new installation has a useful empty home.
    const loaded = store.load(config);
    let status = "not configured";
    try {
      const selected = store.select(loaded.config, flags.get("--profile"));
      status = `configured: ${selected.name} (${selected.region}); not verified with the API`;
    } catch (error) {
      if (!(error instanceof AxiError) || error.code !== "PROFILE_REQUIRED") throw error;
    }
    const executable = resolve(process.argv[1] ?? "bin/checkpoint-axi.js");
    const home = homedir();
    result = { bin: executable.startsWith(`${home}/`) ? `~${executable.slice(home.length)}` : executable,
      description: DESCRIPTION, status, profiles: listed.profiles, count: listed.count,
      help: [SETUP_GUIDANCE, "Run checkpoint-axi auth status to validate local credentials", "Run checkpoint-axi profile list to inspect configured profiles"] };
  }
  let truncated = false;
  const preview = (value: unknown): unknown => {
    if (typeof value === "string" && value.length > 500 && !flags.has("--full")) {
      truncated = true;
      return `${value.slice(0, 500)}... (truncated, ${value.length} chars total)`;
    }
    if (Array.isArray(value)) return value.map(preview);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, preview(child)]));
    return value;
  };
  const projected = Object.fromEntries(fields.filter((field) => result[field] !== undefined).map((field) => [field,
    field === "cursor" || isDownload ? store.redactor.value(result[field]) : preview(store.redactor.value(result[field]))])) as Record<string, unknown>;
  if (truncated && !isWrite) projected.help = [...(Array.isArray(projected.help) ? projected.help : []), "Repeat the command with --full to see complete strings"];
  return projected;
}
