import { AxiError } from "axi-sdk-js";
import { z } from "zod";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, win32 } from "node:path";
import { readPrivateFile, toolDirectory, type PrivateFileOptions } from "./private-file.js";
import { REGIONS } from "./regions.js";
import { SecretRedactor } from "./redact.js";

const profileName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const region = z.enum(Object.keys(REGIONS) as [keyof typeof REGIONS, ...(keyof typeof REGIONS)[]]);
const nonempty = z.string().trim().min(1);
export type CredentialContext = PrivateFileOptions & { env?: NodeJS.ProcessEnv; home?: string };

function schema(platform: NodeJS.Platform) {
  const secretRef = z.union([
    z.strictObject({ env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/) }),
    z.strictObject({ file: z.string().refine((path) => platform === "win32" ? /^[A-Za-z]:[\\/]/.test(path) : isAbsolute(path)) }),
  ]);
  const profile = z.strictObject({
    region,
    clientId: nonempty,
    clientSecret: secretRef.default({ env: "CHECKPOINT_AXI_CLIENT_SECRET" }),
    saas: nonempty.default("office365_emails"),
    scope: nonempty.optional(),
    downloads: z.strictObject({ allow: z.boolean() }).default({ allow: false }),
    writes: z.strictObject({ allowWrites: z.boolean(), operations: z.array(z.string().regex(/^[a-z][A-Za-z0-9_.-]*$/)) })
      .default({ allowWrites: false, operations: [] }),
  });
  return z.strictObject({ version: z.literal(1), defaultProfile: profileName.optional(), profiles: z.record(profileName, profile) })
    .refine((config) => config.defaultProfile === undefined || Object.hasOwn(config.profiles, config.defaultProfile));
}
export type Profile = z.infer<ReturnType<typeof schema>>["profiles"][string];
export type SelectedProfile = Profile & { name: string; source: "flag" | "env" | "env-profile" | "config-default" | "sole" };

export function credentialStore(options: CredentialContext = {}, redactor = new SecretRedactor()) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const invalid = (message: string): never => { throw new AxiError(message, "CONFIG_INVALID", [
    "Use version: 1, named profiles, a supported region, clientId and a clientSecret env/file SecretRef; run checkpoint-axi auth status --help",
  ]); };
  redactor.add(env.CHECKPOINT_AXI_CLIENT_SECRET);
  function configPath(explicit?: string): string {
    const selected = explicit ?? env.CHECKPOINT_AXI_CONFIG;
    if (selected !== undefined && !selected.trim()) invalid("Config path must not be blank");
    return selected !== undefined ? resolve(selected) : (platform === "win32" ? win32.join : join)(toolDirectory("config", env, platform, home), "config.json");
  }
  function readOnly(): boolean {
    const value = env.CHECKPOINT_AXI_READ_ONLY?.toLowerCase();
    if (value === undefined || value === "0" || value === "false") return false;
    if (value === "1" || value === "true") return true;
    return invalid("Read-only override must be 1, true, 0 or false");
  }
  function load(explicit?: string, verifyAcl = false) {
    const path = configPath(explicit);
    let raw: unknown;
    try { raw = JSON.parse(readPrivateFile(path, false, verifyAcl, options)); } catch (error) {
      if (error instanceof AxiError) throw error;
      if (explicit === undefined && env.CHECKPOINT_AXI_CONFIG === undefined && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return { path, config: { version: 1 as const, profiles: {} as Record<string, Profile>, defaultProfile: undefined as string | undefined } };
      }
      return invalid("Cannot read profile configuration as JSON; check its path and syntax");
    }
    // Register malformed inline secrets too, before any validation result is rendered.
    if (raw && typeof raw === "object" && "profiles" in raw && raw.profiles && typeof raw.profiles === "object") {
      for (const profile of Object.values(raw.profiles)) {
        if (!profile || typeof profile !== "object" || !("clientSecret" in profile)) continue;
        const ref = profile.clientSecret;
        if (typeof ref === "string") redactor.add(ref);
        if (ref && typeof ref === "object" && "env" in ref && typeof ref.env === "string") redactor.add(env[ref.env]);
      }
    }
    const parsed = schema(platform).safeParse(raw);
    if (!parsed.success) return invalid("Invalid configuration: check profile names, region, defaultProfile, unknown fields and clientSecret SecretRef");
    return { path, config: parsed.data };
  }
  function select(config: ReturnType<typeof load>["config"], flag?: string): SelectedProfile {
    const selected = flag ?? env.CHECKPOINT_AXI_PROFILE;
    if (selected !== undefined && !profileName.safeParse(selected).success) invalid("Invalid selected profile name");
    const envFields = ["REGION", "CLIENT_ID", "SAAS", "SCOPE"];
    if (selected === undefined && envFields.some((field) => env[`CHECKPOINT_AXI_${field}`] !== undefined)) {
      if (!region.safeParse(env.CHECKPOINT_AXI_REGION).success || !env.CHECKPOINT_AXI_CLIENT_ID?.trim() || !env.CHECKPOINT_AXI_CLIENT_SECRET?.trim()
        || (env.CHECKPOINT_AXI_SAAS !== undefined && !env.CHECKPOINT_AXI_SAAS.trim()) || (env.CHECKPOINT_AXI_SCOPE !== undefined && !env.CHECKPOINT_AXI_SCOPE.trim())) {
        return invalid("Incomplete or invalid env profile; set REGION, CLIENT_ID and CLIENT_SECRET together");
      }
      return { region: env.CHECKPOINT_AXI_REGION as Profile["region"], clientId: env.CHECKPOINT_AXI_CLIENT_ID.trim(),
        clientSecret: { env: "CHECKPOINT_AXI_CLIENT_SECRET" }, saas: env.CHECKPOINT_AXI_SAAS?.trim() ?? "office365_emails", scope: env.CHECKPOINT_AXI_SCOPE?.trim(),
        downloads: { allow: false }, writes: { allowWrites: false, operations: [] }, name: "env", source: "env-profile" };
    }
    const names = Object.keys(config.profiles);
    const name = selected ?? config.defaultProfile ?? (names.length === 1 ? names[0] : undefined);
    if (name === undefined) throw new AxiError(names.length ? "Select one of the configured profiles" : "No profiles are configured",
      names.length ? "PROFILE_AMBIGUOUS" : "PROFILE_REQUIRED", ["Pass --profile <name> or configure defaultProfile; run checkpoint-axi config path"]);
    if (!Object.hasOwn(config.profiles, name)) throw new AxiError("Selected profile is not configured", "PROFILE_NOT_FOUND", ["Run checkpoint-axi profile list"]);
    return { ...config.profiles[name]!, name, source: flag !== undefined ? "flag" : env.CHECKPOINT_AXI_PROFILE !== undefined ? "env" : config.defaultProfile !== undefined ? "config-default" : "sole" };
  }
  function credentials(profile: SelectedProfile, verifyAcl = false) {
    const ref = profile.clientSecret;
    let value: string | undefined;
    try { value = "env" in ref ? env[ref.env] : readPrivateFile(ref.file, true, verifyAcl, options).replace(/^\uFEFF/, "").trimEnd(); } catch (error) {
      if (error instanceof AxiError) throw error;
      throw new AxiError("Cannot read clientSecret SecretRef file", "AUTH_REQUIRED", ["Check the SecretRef file exists and is readable"]);
    }
    redactor.add(value);
    if (!value?.trim()) throw new AxiError("clientSecret is required", "AUTH_REQUIRED", ["Set the selected clientSecret SecretRef source; run checkpoint-axi auth status --help"]);
    return { clientId: profile.clientId, clientSecret: value };
  }
  function status(explicit?: string, flag?: string) {
    const forced = readOnly();
    const loaded = load(explicit, true);
    const profile = select(loaded.config, flag);
    credentials(profile, true);
    return { profile: profile.name, source: profile.source, region: profile.region, origin: REGIONS[profile.region], saas: profile.saas,
      clientSecret: "env" in profile.clientSecret ? "env" : "file", readOnly: forced || !profile.writes.allowWrites || profile.writes.operations.length === 0 };
  }
  function list(explicit?: string) {
    readOnly();
    const loaded = load(explicit);
    return { profiles: Object.entries(loaded.config.profiles).map(([name, profile]) => ({ name, region: profile.region, default: name === loaded.config.defaultProfile })),
      count: Object.keys(loaded.config.profiles).length, config: loaded.path };
  }
  return { configPath, statePath: () => toolDirectory("state", env, platform, home), readOnly, load, select, credentials, status, list, redactor };
}
