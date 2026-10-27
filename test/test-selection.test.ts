import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

test.each([["README.md", "affected-only"], ["scripts/change.mjs", "full-suite"]])("selector includes safety baseline for %s", (changed, mode) => {
  const directory = mkdtempSync(join(tmpdir(), "checkpoint-axi-selection-"));
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  };
  try {
    mkdirSync(join(directory, "scripts"));
    mkdirSync(join(directory, "test"));
    cpSync(new URL("../scripts/test-changes.mjs", import.meta.url), join(directory, "scripts/test-changes.mjs"));
    for (const name of ["packaged-cli", "profiles", "network-guard", "identifiers"]) writeFileSync(join(directory, `test/${name}.test.ts`), "");
    git("init", "--quiet");
    git("add", ".");
    git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.test", "commit", "--quiet", "-m", "baseline");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    writeFileSync(join(directory, changed), "synthetic change");
    const plan = spawnSync(process.execPath, [join(directory, "scripts/test-changes.mjs"), "--plan"], { encoding: "utf8" });
    expect(plan.status, plan.stderr).toBe(0);
    const data = JSON.parse(plan.stdout.trim().split("\n").at(-1)!);
    expect(data.mode).toBe(mode);
    expect(data.baseline).toEqual(["test/packaged-cli.test.ts", "test/profiles.test.ts", "test/network-guard.test.ts", "test/identifiers.test.ts"]);
    expect(data.changed).toContain(changed);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
