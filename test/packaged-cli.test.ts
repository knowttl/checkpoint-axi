import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { decode } from "@toon-format/toon";
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
  for (const dependency of ["axi-sdk-js", "@toon-format/toon", "zod"]) {
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
  return spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", cwd: directory, timeout: 10_000, env: { ...process.env, ...env } });
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

test("installed hook emits local context and refuses unsupported API commands", () => {
  const hook = join(packageRoot, "bin/checkpoint-axi-hook.js");
  const result = cli([], {}, hook);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(decode(result.stdout)).toMatchObject({ status: "not configured" });
  const unsupported = cli(["doctor"]);
  expect(unsupported.status).toBe(2);
  expect(decode(unsupported.stdout)).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
});

test("published metadata includes credential schema, inventory and generated discovery", () => {
  expect(JSON.parse(readFileSync(join(packageRoot, "axi-credential.schema.json"), "utf8")).properties.clientSecret["x-secret"]).toBe(true);
  expect(existsSync(join(packageRoot, "skills/checkpoint-axi/SKILL.md"))).toBe(true);
  expect(existsSync(join(packageRoot, "docs/commands.md"))).toBe(true);
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
