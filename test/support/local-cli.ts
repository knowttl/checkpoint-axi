import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { main } from "../../src/cli.js";
import type { CredentialContext } from "../../src/profiles.js";

export function localFixture() {
  const directory = mkdtempSync(join(tmpdir(), "checkpoint-axi-test-"));
  const config = join(directory, "config.json");
  const profile = JSON.parse(readFileSync(new URL("../fixtures/profile.json", import.meta.url), "utf8"));
  writeFileSync(config, JSON.stringify(profile), { mode: 0o600 });
  const env: NodeJS.ProcessEnv = { CHECKPOINT_AXI_CONFIG: config, SYNTHETIC_SECRET: "synthetic-secret-sentinel" };
  const context: CredentialContext = { env, home: directory };
  return {
    directory, config, profile, env, context,
    save: () => writeFileSync(config, JSON.stringify(profile), { mode: 0o600 }),
    run: async (args: string[], extra: CredentialContext = {}) => {
      let output = "";
      process.exitCode = 0;
      await main(args, { credentials: { ...context, ...extra }, stdout: { write: (chunk) => { output += chunk; } } });
      const code = process.exitCode;
      process.exitCode = 0;
      return { code, output, data: decode(output) as Record<string, unknown> };
    },
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
