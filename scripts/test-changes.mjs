import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8", cwd: root });
  if (result.error || result.status !== 0) throw new Error(`Cannot compute changed files: git ${args.join(" ")} failed`);
  return result.stdout;
}

try {
  const base = git(["merge-base", "origin/main", "HEAD"]).trim();
  if (!base) throw new Error("Cannot compute changed files: merge base is empty");
  const changed = [...new Set([
    ...git(["diff", "--name-only", "-z", base, "--"]).split("\0"),
    ...git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0"),
  ].filter(Boolean))];
  const baseline = ["test/packaged-cli.test.ts", "test/profiles.test.ts", "test/network-guard.test.ts", "test/identifiers.test.ts"];
  if (baseline.some((path) => !existsSync(new URL(`../${path}`, import.meta.url)))) throw new Error("Required safety baseline is missing");
  const full = changed.some((path) => /^(package\.json|pnpm-lock\.yaml|tsconfig[^/]*\.json|vitest\.config\.[^/]+|\.no-mistakes\.yaml|axi-credential\.schema\.json)$/.test(path)
    || /^(scripts\/|inventory\/|test\/(support|fixtures)\/)/.test(path));
  const vitestArgs = full ? ["run"] : ["related", "--run", ...new Set([...changed, ...baseline])];
  console.log(`Test mode: ${full ? "full-suite" : "affected-only"}; baseline: ${baseline.join(", ")}`);
  if (process.argv.includes("--plan")) console.log(JSON.stringify({ mode: full ? "full-suite" : "affected-only", changed, baseline, vitestArgs }));
  else {
    const guard = fileURLToPath(new URL("../test/support/deny-network.mjs", import.meta.url));
    for (const [entry, ...args] of [
      ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"],
      ["node_modules/typescript/bin/tsc", "--noEmit", "-p", "tsconfig.json"],
      ["node_modules/vitest/vitest.mjs", ...vitestArgs],
    ]) {
      const result = spawnSync(process.execPath, [fileURLToPath(new URL(`../${entry}`, import.meta.url)), ...args], {
        cwd: root, stdio: "inherit", env: { ...process.env,
          ...(entry.includes("vitest") ? { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${guard}`.trim() } : {}) },
      });
      if (result.error) throw result.error;
      if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
