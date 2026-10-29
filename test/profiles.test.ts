import { chmodSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { credentialStore } from "../src/profiles.js";
import { localFixture } from "./support/local-cli.js";

const fixtures: ReturnType<typeof localFixture>[] = [];
function fixture() { const value = localFixture(); fixtures.push(value); return value; }
afterEach(() => { for (const value of fixtures.splice(0)) value.cleanup(); });

test("auth status validates a local SecretRef without printing credential material", async () => {
  const f = fixture();
  const result = await f.run(["auth", "status"]);
  expect(result.code).toBe(0);
  expect(result.data).toMatchObject({ profile: "example", region: "eu", clientSecret: "env", saas: "office365_emails", readOnly: true });
  expect(result.output).not.toContain("synthetic-secret-sentinel");
  expect(result.output).not.toContain("synthetic-client");
  expect(result.output).not.toContain("SYNTHETIC_SECRET");
});

test.each([[], ["profile", "list"]])("local discovery does not resolve missing secret files: %j", async (...args) => {
  const f = fixture();
  f.profile.profiles.example.clientSecret = { file: join(f.directory, "missing-secret") };
  f.save();
  expect((await f.run(args as string[])).code).toBe(0);
});

test.each([
  [{ origin: "https://example.test" }, "CONFIG_INVALID"],
  [{ clientSecret: "synthetic-inline-secret" }, "CONFIG_INVALID"],
  [{ clientSecret: { env: "NOT VALID" } }, "CONFIG_INVALID"],
  [{ region: "elsewhere" }, "CONFIG_INVALID"],
])("invalid file profiles fail without echoing input: %j", async (changes, code) => {
  const f = fixture();
  Object.assign(f.profile.profiles.example, changes);
  f.save();
  const result = await f.run(["auth", "status"]);
  expect(result.data).toMatchObject({ error: { code } });
  expect(result.output).not.toContain("synthetic-inline-secret");
});

test.each(["https://example.test", "example.test/auth", "office365_emails/"])("file profiles reject a URL-shaped SaaS: %s", async (saas) => {
  const f = fixture();
  f.profile.profiles.example.saas = saas;
  f.save();
  const result = await f.run(["auth", "status"]);
  expect(result.code).toBe(1);
  expect(result.data).toMatchObject({ error: { code: "CONFIG_INVALID" } });
  expect(result.output).toContain("SaaS application name");
  expect(result.output).not.toContain(saas);
});

test.each(["https://example.test", "example.test/auth", "office365_emails/"])("environment profiles reject a URL-shaped SaaS: %s", async (saas) => {
  const f = fixture();
  Object.assign(f.env, { CHECKPOINT_AXI_REGION: "ca", CHECKPOINT_AXI_CLIENT_ID: "synthetic-env-client",
    CHECKPOINT_AXI_CLIENT_SECRET: "synthetic-env-secret", CHECKPOINT_AXI_SAAS: saas });
  const result = await f.run(["auth", "status"]);
  expect(result.code).toBe(1);
  expect(result.data).toMatchObject({ error: { code: "CONFIG_INVALID" } });
  expect(result.output).toContain("SaaS application name");
  expect(result.output).not.toContain(saas);
});

test.each([
  ["config-default", "example", undefined],
  ["config-default", "example", { env: "CHECKPOINT_AXI_CLIENT_SECRET" }],
  ["sole", undefined, undefined],
  ["sole", undefined, { env: "CHECKPOINT_AXI_CLIENT_SECRET" }],
])("a default SecretRef preserves %s file profile selection (%s, %j)", async (source, defaultProfile, clientSecret) => {
  const f = fixture();
  f.profile.profiles.example.clientSecret = clientSecret;
  f.profile.defaultProfile = defaultProfile;
  f.save();
  f.env.CHECKPOINT_AXI_CLIENT_SECRET = "synthetic-default-secret";
  const status = await f.run(["auth", "status"]);
  expect(status.code).toBe(0);
  expect(status.data).toMatchObject({ profile: "example", source, region: "eu", clientSecret: "env" });
  expect(status.output).not.toContain("synthetic-default-secret");
  const home = await f.run(["home"]);
  expect(home.code).toBe(0);
  expect(home.data.status).toBe("configured: example (eu); not verified with the API");
});

test.each(["REGION", "CLIENT_ID", "SAAS", "SCOPE"])("profile flags take precedence over partial env metadata %s without mixing sources", async (field) => {
  const f = fixture();
  f.env[`CHECKPOINT_AXI_${field}`] = "ca";
  expect((await f.run(["auth", "status"])).data).toMatchObject({ error: { code: "CONFIG_INVALID" } });
  expect((await f.run(["auth", "status", "--profile", "example"])).data).toMatchObject({ region: "eu", source: "flag" });
});

test("a complete environment profile overrides the default and cannot enable writes or downloads", () => {
  const f = fixture();
  Object.assign(f.env, { CHECKPOINT_AXI_REGION: "ca", CHECKPOINT_AXI_CLIENT_ID: "synthetic-env-client", CHECKPOINT_AXI_CLIENT_SECRET: "synthetic-env-secret" });
  const store = credentialStore(f.context);
  const profile = store.select(store.load().config);
  expect(profile).toMatchObject({ region: "ca", source: "env-profile", saas: "office365_emails", writes: { allowWrites: false, operations: [] }, downloads: { allow: false } });
});

test.each([
  [undefined, "PROFILE_AMBIGUOUS"], ["absent", "PROFILE_NOT_FOUND"],
])("multiple profiles require a known selector: %s", async (selected, code) => {
  const f = fixture();
  delete f.profile.defaultProfile;
  f.profile.profiles.second = { ...f.profile.profiles.example, region: "ca" };
  f.save();
  expect((await f.run(["auth", "status", ...(selected ? ["--profile", selected] : [])])).data).toMatchObject({ error: { code } });
});

test("read-only override wins over configured operation permission", async () => {
  const f = fixture();
  f.profile.profiles.example.writes = { allowWrites: true, operations: ["email.quarantine"] };
  f.save();
  f.env.CHECKPOINT_AXI_READ_ONLY = "TRUE";
  expect((await f.run(["auth", "status"])).data.readOnly).toBe(true);
  f.env.CHECKPOINT_AXI_READ_ONLY = "perhaps";
  expect((await f.run(["auth", "status"])).data).toMatchObject({ error: { code: "CONFIG_INVALID" } });
});

test.skipIf(process.platform === "win32")("auth status rejects exposed secret files and symlinks", async () => {
  const f = fixture();
  const secret = join(f.directory, "secret");
  writeFileSync(secret, "synthetic-file-secret", { mode: 0o644 });
  f.profile.profiles.example.clientSecret = { file: secret };
  f.save();
  expect((await f.run(["auth", "status"])).data).toMatchObject({ error: { code: "CONFIG_INSECURE" } });
  chmodSync(secret, 0o600);
  const link = join(f.directory, "secret-link");
  symlinkSync(secret, link);
  f.profile.profiles.example.clientSecret = { file: link };
  f.save();
  expect((await f.run(["auth", "status"])).data).toMatchObject({ error: { code: "CONFIG_INSECURE" } });
});

test.skipIf(process.platform === "win32")("config reads reject foreign ownership and group-writable files", async () => {
  const f = fixture();
  expect((await f.run(["profile", "list"], { uid: process.getuid!() + 1 })).data).toMatchObject({ error: { code: "CONFIG_INSECURE" } });
  chmodSync(f.config, 0o660);
  expect((await f.run(["profile", "list"])).data).toMatchObject({ error: { code: "CONFIG_INSECURE" } });
});

test("file SecretRefs strip a BOM and trailing whitespace", () => {
  const f = fixture();
  const secret = join(f.directory, "secret");
  writeFileSync(secret, "\uFEFFsynthetic-file-secret\r\n ", { mode: 0o600 });
  f.profile.profiles.example.clientSecret = { file: secret };
  f.save();
  const store = credentialStore(f.context);
  expect(store.credentials(store.select(store.load().config)).clientSecret).toBe("synthetic-file-secret");
});

test("Windows auth status verifies ACLs while ordinary discovery only checks reparse points", async () => {
  const f = fixture();
  const checks: boolean[] = [];
  const options = { platform: "win32" as const, acl: (_path: string, verify: boolean) => { checks.push(verify); if (verify) throw new Error("synthetic ACL denial"); } };
  expect((await f.run(["profile", "list"], options)).code).toBe(0);
  expect(checks).toEqual([false]);
  expect((await f.run(["auth", "status"], options)).data).toMatchObject({ error: { code: "CONFIG_INSECURE" } });
});

test("platform paths ignore relative XDG values and Windows ignores XDG entirely", () => {
  const f = fixture();
  expect(credentialStore({ home: "/synthetic-home", platform: "linux", env: { XDG_CONFIG_HOME: "relative" } }).configPath()).toBe("/synthetic-home/.config/checkpoint-axi/config.json");
  expect(credentialStore({ home: "C:\\Synthetic", platform: "win32", env: { APPDATA: "C:\\Roaming", LOCALAPPDATA: "C:\\Local", XDG_CONFIG_HOME: "/ignored" } }).configPath()).toBe("C:\\Roaming\\checkpoint-axi\\config.json");
  expect(credentialStore(f.context).configPath("explicit.json")).toMatch(/explicit\.json$/);
});

test("registered secrets are removed from profile names before TOON encoding", async () => {
  const f = fixture();
  f.env.SYNTHETIC_SECRET = "example";
  const result = await f.run(["profile", "list"]);
  expect(result.output).not.toContain("example");
  expect(result.output).toContain("***redacted***");
});
