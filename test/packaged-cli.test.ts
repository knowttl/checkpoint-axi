import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { decode } from "@toon-format/toon";
import { parse } from "@iarna/toml";
import { afterAll, beforeAll, expect, test } from "vitest";

let directory: string;
let entry: string;
let packageRoot: string;
let version: string;
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "checkpoint-axi-package-"));
  const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], { encoding: "utf8" });
  expect(packed.status, packed.stderr).toBe(0);
  const [metadata] = JSON.parse(packed.stdout) as { filename: string; version: string }[];
  version = metadata!.version;
  const tarballs = [join(directory, metadata!.filename)];
  for (const dependency of ["axi-sdk-js", "@toon-format/toon", "zod", "@iarna/toml"]) {
    // Copy first to break pnpm hardlinks before repacking for offline installation.
    const source = join(directory, "dependencies", dependency);
    cpSync(realpathSync(resolve("node_modules", dependency)), source, { recursive: true });
    const result = spawnSync("npm", ["pack", "--force", "--ignore-scripts", "--json", "--pack-destination", directory], { cwd: source, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    tarballs.push(join(directory, JSON.parse(result.stdout)[0].filename));
  }
  const prefix = join(directory, "Agent's $Tools");
  const installed = spawnSync("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", prefix, ...tarballs], { encoding: "utf8" });
  expect(installed.status, installed.stderr).toBe(0);
  packageRoot = join(prefix, "node_modules/@knowttl/checkpoint-axi");
  entry = join(packageRoot, "bin/checkpoint-axi.js");
}, 30_000);
afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

function cli(args: string[], env: NodeJS.ProcessEnv = {}, bin = entry) {
  const home = env.HOME ?? directory;
  return spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", cwd: directory, timeout: 10_000,
    env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: "", CLAUDE_CONFIG_DIR: "", XDG_CONFIG_HOME: join(home, ".config"), ...env } });
}

function executeHook(hook: { command: string; args?: string[] }, env: NodeJS.ProcessEnv) {
  const options = { encoding: "utf8" as const, cwd: env.HOME, timeout: 10_000, env: { ...process.env, ...env } };
  return hook.args !== undefined ? spawnSync(hook.command, hook.args, options)
    : process.platform === "win32" ? spawnSync("powershell.exe", ["-NoProfile", "-Command", hook.command], options)
      : spawnSync("bash", ["-c", hook.command], options);
}

test.each([
  ["bounded", 0, { status: "live", emails: { count: 5, total: 8, complete: false }, events: { count: 1, complete: true } }],
  ["empty", 0, { status: "live", emails: { status: "empty", count: 0, rows: [], complete: true }, events: { status: "empty", count: 0, rows: [] } }],
  ["partial", 0, { status: "partial", emails: { count: 1 }, events: { status: "error", code: "HTTP_ERROR" } }],
  ["email-failed", 0, { status: "partial", emails: { status: "error", code: "HTTP_ERROR" }, events: { count: 1 } }],
  ["invalid", 0, { status: "partial", emails: { status: "error", code: "RESPONSE_INVALID" }, events: { count: 1 } }],
  ["budget", 0, { status: "live", emails: { count: 1, total: 2, complete: false }, events: { count: 1 } }],
  ["auth-failed", 1, { error: { code: "AUTH_FAILED" } }],
])("packaged configured home reports %s through the controlled API", (scenario, code, expected) => {
  const config = join(directory, "live-profile.json");
  writeFileSync(config, readFileSync(new URL("./fixtures/profile.json", import.meta.url)), { mode: 0o600 });
  const result = cli([], { CHECKPOINT_AXI_CONFIG: config, SYNTHETIC_SECRET: "synthetic-packaged-secret",
    PACKAGED_GATEWAY_SCENARIO: scenario as string,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --experimental-strip-types --import=${fileURLToPath(new URL("./support/packaged-gateway.mjs", import.meta.url))}` });
  expect(result.status, result.stdout + result.stderr).toBe(code);
  expect(decode(result.stdout)).toMatchObject(expected);
  expect(result.stdout + result.stderr).not.toMatch(/synthetic-packaged-secret|synthetic-packaged-token/);
});

test("packaged home offline skips secret resolution and unknown flags fail before config or API access", () => {
  const config = join(directory, "offline-profile.json");
  writeFileSync(config, readFileSync(new URL("./fixtures/profile.json", import.meta.url)), { mode: 0o600 });
  const offline = cli(["home", "--offline"], { CHECKPOINT_AXI_CONFIG: config, SYNTHETIC_SECRET: "" });
  expect(offline.status, offline.stdout + offline.stderr).toBe(0);
  expect(decode(offline.stdout)).toMatchObject({ status: "configured: example (eu); not verified with the API" });
  const missing = cli(["home"], { CHECKPOINT_AXI_CONFIG: config, SYNTHETIC_SECRET: "" });
  expect(missing.status, missing.stdout + missing.stderr).toBe(1);
  expect(decode(missing.stdout)).toMatchObject({ error: { code: "AUTH_REQUIRED" } });
  for (const args of [[], ["home"], ["setup", "hooks"], ["email", "search"], ["event", "list"]]) {
    const result = cli([...args, "--unknown"], { CHECKPOINT_AXI_CONFIG: "/missing/profile.json" });
    expect(result.status, result.stdout + result.stderr).toBe(2);
    expect(decode(result.stdout)).toMatchObject({ error: { code: "VALIDATION_ERROR", message: "Unknown or duplicate flag --unknown" } });
  }
});

test.each([["home"], ["setup", "hooks"], ["email", "search"], ["event", "list"], ["auth", "status"], ["task", "show"]])("installed subcommand help works without credentials: %j", (...args) => {
  const result = cli([...args, "--help"], { CHECKPOINT_AXI_CONFIG: "/missing/profile.json" });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(decode(result.stdout)).toMatchObject({ command: args.join(" ") });
});

test("opt-in packaged setup preserves settings, repeats without writes and repairs relocated executables", async () => {
  const home = join(directory, "hook-home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  const settings = join(home, ".claude/settings.json");
  const codex = join(home, ".codex/hooks.json");
  const feature = join(home, ".codex/config.toml");
  const plugin = join(home, ".config/opencode/plugins/axi-checkpoint-axi-hook.js");
  const unrelated = { permissions: { allow: ["Read"] }, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "other-tool" }] }] } };
  const previous = { ...unrelated, hooks: { SessionStart: [...unrelated.hooks.SessionStart,
    { hooks: [{ type: "command", command: "checkpoint-axi-hook missing-installation" }] }] } };
  writeFileSync(settings, JSON.stringify(previous));
  writeFileSync(codex, JSON.stringify(previous));
  writeFileSync(feature, 'model = "example"\n[features]\nhooks = false\nother = true\n');
  const env = { HOME: home, USERPROFILE: home };
  expect(cli(["home", "--offline"], env).status).toBe(0);
  expect(readFileSync(settings, "utf8")).toBe(JSON.stringify(previous));
  expect(existsSync(plugin)).toBe(false);
  const setup = cli(["setup", "hooks"], env);
  expect(setup.status, setup.stdout + setup.stderr).toBe(0);
  for (const path of [settings, codex]) {
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.permissions).toEqual(unrelated.permissions);
    expect(saved.hooks.SessionStart[0]).toEqual(unrelated.hooks.SessionStart[0]);
    const executed = executeHook(saved.hooks.SessionStart[1].hooks[0], env);
    expect(executed.status, executed.stdout + executed.stderr).toBe(0);
    expect(decode(executed.stdout)).toMatchObject({ status: "not configured" });
  }
  expect(readFileSync(feature, "utf8")).toBe('model = "example"\n[features]\nhooks = true\nother = true\n');
  const before = [settings, codex, feature, plugin].map((path) => statSync(path).mtimeMs);
  expect(cli(["setup", "hooks"], env).status).toBe(0);
  expect([settings, codex, feature, plugin].map((path) => statSync(path).mtimeMs)).toEqual(before);
  const moved = join(dirname(packageRoot), "relocated-package");
  cpSync(packageRoot, moved, { recursive: true });
  const repaired = cli(["setup", "hooks"], env, join(moved, "bin/checkpoint-axi.js"));
  expect(repaired.status, repaired.stdout + repaired.stderr).toBe(0);
  const hidden = `${packageRoot}-hidden`;
  renameSync(packageRoot, hidden);
  try {
    for (const path of [settings, codex]) {
      const hook = JSON.parse(readFileSync(path, "utf8")).hooks.SessionStart[1].hooks[0];
      const executed = executeHook(hook, env);
      expect(executed.status, executed.stdout + executed.stderr).toBe(0);
      expect(decode(executed.stdout)).toMatchObject({ status: "not configured" });
    }
    await expectPluginContext(plugin, home);
  } finally { renameSync(hidden, packageRoot); }
});

test("packaged setup honors active agent configuration directories", async () => {
  const home = mkdtempSync(join(directory, "custom-hook-"));
  const claudeHome = join(home, "active-claude");
  const codexHome = join(home, "active-codex");
  const configHome = join(home, "active-config");
  const env = { HOME: home, CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome, XDG_CONFIG_HOME: configHome };
  const setup = cli(["setup", "hooks"], env);
  expect(setup.status, setup.stdout + setup.stderr).toBe(0);
  for (const path of [join(claudeHome, "settings.json"), join(codexHome, "hooks.json")]) {
    const hook = JSON.parse(readFileSync(path, "utf8")).hooks.SessionStart[0].hooks[0];
    const executed = executeHook(hook, env);
    expect(executed.status, executed.stdout + executed.stderr).toBe(0);
    expect(decode(executed.stdout)).toMatchObject({ status: "not configured" });
  }
  expect(parse(readFileSync(join(codexHome, "config.toml"), "utf8"))).toEqual({ features: { hooks: true } });
  await expectPluginContext(join(configHome, "opencode/plugins/axi-checkpoint-axi-hook.js"), home);
  for (const name of [".claude", ".codex", ".config"]) expect(existsSync(join(home, name))).toBe(false);
});

test.each([".claude/settings.json", ".codex/hooks.json"])("setup preserves marker mentions and repairs only launchers in %s", (relative) => {
  const home = mkdtempSync(join(directory, "hook-ownership-"));
  const target = join(home, relative);
  const unrelated = [
    { type: "command", command: "notify", args: ["checkpoint-axi-hook status"] },
    { type: "command", command: "notify", args: ["/synthetic/checkpoint-axi-hook.js"] },
    { type: "command", command: "notify checkpoint-axi-hook" },
    { type: "command", command: process.execPath, args: ["notify.js", "/synthetic/checkpoint-axi-hook.js"] },
    { type: "command", command: "/synthetic/checkpoint-axi-hook/notify", args: [] },
    { type: "command", command: process.execPath, args: ["/synthetic/other-checkpoint-axi-hook.js"] },
  ];
  const owned = [
    { type: "command", command: "checkpoint-axi-hook" },
    { type: "command", command: process.execPath, args: ["/synthetic/old/checkpoint-axi-hook.js"] },
    { type: "command", command: "'/synthetic/Agent'\\''s $Tools/checkpoint-axi-hook.js'" },
    { type: "command", command: "'/synthetic/node' '/synthetic/Agent'\\''s $Tools/checkpoint-axi-hook.js'" },
    { type: "command", command: '& \'C:\\Program Files\\nodejs\\node.exe\' \'C:\\Agent\'\'s $Tools\\checkpoint-axi-hook.js\'' },
    { type: "command", command: '"C:\\Agent\'s $Tools\\checkpoint-axi-hook.js"' },
  ];
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify({ hooks: { session_start: [...unrelated, ...owned], SessionStart: [{ hooks: [...unrelated, ...owned] }] } }));
  const env = { HOME: home, USERPROFILE: home };
  const result = cli(["setup", "hooks"], env);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const saved = JSON.parse(readFileSync(target, "utf8"));
  expect(saved.hooks.session_start).toEqual(unrelated);
  expect(saved.hooks.SessionStart[0].hooks).toHaveLength(unrelated.length + owned.length);
  expect(saved.hooks.SessionStart[0].hooks.slice(0, unrelated.length)).toEqual(unrelated);
  for (const hook of saved.hooks.SessionStart[0].hooks.slice(unrelated.length)) {
    const executed = executeHook(hook, env);
    expect(executed.status, executed.stdout + executed.stderr).toBe(0);
    expect(decode(executed.stdout)).toMatchObject({ status: "not configured" });
  }
});

test.each([".claude/settings.json", ".codex/hooks.json", ".codex/config.toml", ".config/opencode/plugins/axi-checkpoint-axi-hook.js"])("packaged setup reports a failed target without replacing it: %s", (relative) => {
  const home = mkdtempSync(join(directory, "failed-hook-"));
  const target = join(home, relative);
  mkdirSync(target, { recursive: true });
  const result = cli(["setup", "hooks"], { HOME: home, USERPROFILE: home });
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(decode(result.stdout)).toMatchObject({ error: { code: "HOOK_SETUP_FAILED" } });
  expect(result.stdout).toContain(target);
  expect(statSync(target).isDirectory()).toBe(true);
});

test("packaged setup launches JavaScript hooks through Node despite PATH shadowing", async () => {
  const home = mkdtempSync(join(directory, "portable-hook-"));
  const bins = join(home, "bin");
  mkdirSync(bins);
  writeFileSync(join(bins, "checkpoint-axi-hook"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  const env = { HOME: home, USERPROFILE: home, PATH: `${bins}${delimiter}${process.env.PATH}` };
  expect(cli(["setup", "hooks"], env).status).toBe(0);
  const hook = join(packageRoot, "bin/checkpoint-axi-hook.js");
  const mode = statSync(hook).mode;
  chmodSync(hook, 0o644);
  try {
    for (const relative of [".claude/settings.json", ".codex/hooks.json"]) {
      const hook = JSON.parse(readFileSync(join(home, relative), "utf8")).hooks.SessionStart[0].hooks[0];
      const executed = executeHook(hook, env);
      expect(executed.status, executed.stdout + executed.stderr).toBe(0);
      expect(decode(executed.stdout)).toMatchObject({ status: "not configured" });
    }
    await expectPluginContext(join(home, ".config/opencode/plugins/axi-checkpoint-axi-hook.js"), home);
  } finally { chmodSync(hook, mode); }
});

test.skipIf(process.platform === "win32")("matching PATH hooks survive relocation without setup", async () => {
  const home = mkdtempSync(join(directory, "matching-hook-"));
  const bins = join(home, "bin");
  mkdirSync(bins);
  const launcher = join(bins, "checkpoint-axi-hook");
  symlinkSync(join(packageRoot, "bin/checkpoint-axi-hook.js"), launcher);
  const env = { HOME: home, PATH: `${bins}${delimiter}${process.env.PATH}` };
  const setup = cli(["setup", "hooks"], env);
  expect(setup.status, setup.stdout + setup.stderr).toBe(0);
  const moved = join(dirname(packageRoot), "portable-package");
  cpSync(packageRoot, moved, { recursive: true });
  rmSync(launcher);
  symlinkSync(join(moved, "bin/checkpoint-axi-hook.js"), launcher);
  const hidden = `${packageRoot}-hidden`;
  const previousPath = process.env.PATH;
  renameSync(packageRoot, hidden);
  try {
    for (const relative of [".claude/settings.json", ".codex/hooks.json"]) {
      const hook = JSON.parse(readFileSync(join(home, relative), "utf8")).hooks.SessionStart[0].hooks[0];
      const executed = executeHook(hook, env);
      expect(executed.status, executed.stdout + executed.stderr).toBe(0);
      expect(decode(executed.stdout)).toMatchObject({ status: "not configured" });
    }
    process.env.PATH = env.PATH;
    await expectPluginContext(join(home, ".config/opencode/plugins/axi-checkpoint-axi-hook.js"), home);
  } finally {
    process.env.PATH = previousPath;
    renameSync(hidden, packageRoot);
  }
});

test.each([
  [".claude/settings.json", '{"permissions":{"allow":["Read"]},"hooks":{"SessionStart":{}}}'],
  [".codex/hooks.json", '{"hooks":'],
  [".codex/config.toml", '[features]\nhooks = "unterminated'],
  [".config/opencode/plugins/axi-checkpoint-axi-hook.js", "export default { custom: true };\n"],
])("packaged setup preserves invalid or unmanaged configuration on failure: %s", (relative, contents) => {
  const home = mkdtempSync(join(directory, "invalid-hook-"));
  const target = join(home, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
  const result = cli(["setup", "hooks"], { HOME: home, USERPROFILE: home });
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(decode(result.stdout)).toMatchObject({ error: { code: "HOOK_SETUP_FAILED" } });
  expect(readFileSync(target, "utf8")).toBe(contents);
});

test("installed OpenCode plugin injects home context through its supported session interface", async () => {
  const home = mkdtempSync(join(directory, "opencode-hook-"));
  const result = cli(["setup", "hooks"], { HOME: home, USERPROFILE: home });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  await expectPluginContext(join(home, ".config/opencode/plugins/axi-checkpoint-axi-hook.js"), home);
});

async function expectPluginContext(path: string, home: string) {
  const { default: plugin } = await import(path);
  const hooks = await plugin.server({ directory: home });
  const output = { system: [] as string[] };
  await hooks["experimental.chat.system.transform"]({ sessionID: "synthetic-session" }, output);
  expect(decode(output.system[0]!)).toMatchObject({ status: "not configured" });
  let context: (event: unknown) => Promise<void> = async () => {};
  await plugin.setup({ location: { directory: home }, session: { hook: async (name: string, handler: typeof context) => {
    expect(name).toBe("context"); context = handler;
  } } });
  const event = { sessionID: "synthetic-session-v2", system: [] as { type: string; text: string }[] };
  await context(event);
  expect(decode(event.system[0]!.text)).toMatchObject({ status: "not configured" });
}

test("installed CLI shows an explicit empty local home without creating integrations", () => {
  const result = cli([]);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(decode(result.stdout)).toMatchObject({ status: "not configured", count: 0, profiles: [] });
  for (const name of [".claude", ".codex", ".opencode"]) expect(existsSync(join(directory, name))).toBe(false);
});

test("installed profile status is offline and never exposes secret source details", () => {
  const config = join(directory, "profile.json");
  writeFileSync(config, readFileSync(new URL("./fixtures/profile.json", import.meta.url)), { mode: 0o600 });
  const result = cli(["auth", "status"], { CHECKPOINT_AXI_CONFIG: config, SYNTHETIC_SECRET: "synthetic-packaged-secret" });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(decode(result.stdout)).toMatchObject({ profile: "example", region: "eu", clientSecret: "env", readOnly: true });
  expect(result.stdout + result.stderr).not.toMatch(/synthetic-packaged-secret|SYNTHETIC_SECRET|synthetic-client/);
});

test("installed hook emits local context and doctor help works offline", () => {
  const hook = join(packageRoot, "bin/checkpoint-axi-hook.js");
  const result = cli([], {}, hook);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(decode(result.stdout)).toMatchObject({ status: "not configured" });
  const doctor = cli(["doctor", "--help"]);
  expect(doctor.status).toBe(0);
  expect(decode(doctor.stdout)).toMatchObject({ command: "doctor" });
});

test("published metadata includes credential schema, inventory and generated discovery", () => {
  expect(JSON.parse(readFileSync(join(packageRoot, "axi-credential.schema.json"), "utf8")).properties.clientSecret["x-secret"]).toBe(true);
  expect(existsSync(join(packageRoot, "skills/checkpoint-axi/SKILL.md"))).toBe(true);
  expect(existsSync(join(packageRoot, "docs/commands.md"))).toBe(true);
  for (const guide of ["configuration", "reads", "writes", "downloads", "design"]) {
    expect(existsSync(join(packageRoot, `docs/${guide}.md`))).toBe(true);
  }
  expect(JSON.parse(readFileSync(join(packageRoot, "inventory/capabilities.json"), "utf8")).coverage).toHaveLength(20);
});

test("all version aliases work without the compiled command graph", () => {
  const dist = join(packageRoot, "dist");
  renameSync(dist, `${dist}-hidden`);
  try {
    for (const alias of ["--version", "-v", "-V"]) {
      const result = cli([alias]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(`${version}\n`);
    }
  } finally { renameSync(`${dist}-hidden`, dist); }
});

test("version startup stays close to the same machine's Node process floor", () => {
  const measure = (args: string[]) => {
    const start = performance.now();
    expect(spawnSync(process.execPath, args, { encoding: "utf8", timeout: 5_000 }).status).toBe(0);
    return performance.now() - start;
  };
  const floor = Array.from({ length: 5 }, () => measure(["-e", "console.log(1)"])).sort((a, b) => a - b)[2]!;
  const probe = Array.from({ length: 5 }, () => measure([entry, "--version"])).sort((a, b) => a - b)[2]!;
  expect(probe / floor).toBeLessThan(5);
});
