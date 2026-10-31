import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test.each(["generate-docs.ts", "specs.ts"])("generated artifacts match their authoritative sources: %s", (script) => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(`../scripts/${script}`, import.meta.url)), "--check"], { encoding: "utf8" });
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
