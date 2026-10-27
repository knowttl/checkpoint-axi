import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "checkpoint-axi-validation-"));
try {
  const [command, ...args] = process.argv.slice(2);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("CHECKPOINT_AXI_")));
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: { ...env, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData/Roaming"),
      CODEX_HOME: join(home, ".codex"), CLAUDE_CONFIG_DIR: join(home, ".claude"),
      LOCALAPPDATA: join(home, "AppData/Local"), XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"), XDG_CACHE_HOME: join(home, ".cache"), XDG_STATE_HOME: join(home, ".local/state") },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(home, { recursive: true, force: true });
}
