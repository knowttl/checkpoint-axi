import { afterEach, expect, test } from "vitest";
import { localFixture } from "./support/local-cli.js";

const fixtures: ReturnType<typeof localFixture>[] = [];
function fixture() { const f = localFixture(); fixtures.push(f); return f; }
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });

test.each([
  ["auth", "status", "--client-secret", "synthetic-argv-secret"],
  ["profile", "list", "--unknown"], ["home", "extra"],
  ["config", "path", "--full", "false"], ["config", "path", "--config"],
  ["auth", "status", "--profile", "example", "--profile", "example"],
  ["auth", "status", "--fields", "clientId"], ["email", "search"], ["constructor"], ["toString"],
])("rejects invalid input before attempting config reads: %j", async (...args) => {
  const f = fixture();
  f.env.CHECKPOINT_AXI_CONFIG = "/missing/config.json";
  const result = await f.run(args as string[]);
  expect(result.code).toBe(2);
  expect(result.data).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  expect(result.output).not.toContain("synthetic-argv-secret");
});

test("config path and command help do not require a readable configuration", async () => {
  const f = fixture();
  f.env.CHECKPOINT_AXI_CONFIG = "/missing/config.json";
  expect((await f.run(["config", "path", "--fields", "config"])).data).toEqual({ config: "/missing/config.json" });
  expect((await f.run(["auth", "status", "--help"])).data).toMatchObject({ command: "auth status" });
});

test("unknown flags are named without echoing attached credential values", async () => {
  const f = fixture();
  const result = await f.run(["auth", "status", "--client-secret=synthetic-argv-secret"]);
  expect(result.data).toMatchObject({ error: { code: "VALIDATION_ERROR", message: "Unknown or duplicate flag --client-secret" } });
  expect(result.output).not.toContain("synthetic-argv-secret");
});

test("500-character previews disclose the complete length and --full restores the value", async () => {
  const f = fixture();
  f.profile.profiles.example.saas = "a".repeat(501);
  f.save();
  const preview = await f.run(["auth", "status", "--fields", "saas"]);
  expect(preview.data.saas).toBe(`${"a".repeat(500)}... (truncated, 501 chars total)`);
  expect(preview.data.help).toEqual(["Repeat the command with --full to see complete strings"]);
  expect((await f.run(["auth", "status", "--fields", "saas", "--full"])).data).toEqual({ saas: "a".repeat(501) });
});
