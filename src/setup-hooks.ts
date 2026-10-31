import { AxiError, computeCodexConfigUpdate, computeSessionStartHookUpdate } from "axi-sdk-js";
import { accessSync, constants, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parse } from "@iarna/toml";

export function setupHooks(): Record<string, unknown> {
  const marker = "checkpoint-axi-hook";
  const execPath = fileURLToPath(new URL("../../bin/checkpoint-axi-hook.js", import.meta.url));
  let executable = execPath;
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, marker);
    try {
      accessSync(candidate, constants.X_OK);
      if (realpathSync(candidate) === realpathSync(execPath)) executable = marker;
      break;
    } catch { /* Continue until the first executable on PATH. */ }
  }
  const command = process.platform === "win32" ? `"${executable}"` : `'${executable.replaceAll("'", "'\\''")}'`;
  const home = homedir();
  const integrations = {
    claude: join(home, ".claude/settings.json"),
    codex: join(home, ".codex/hooks.json"),
    codexFeature: join(home, ".codex/config.toml"),
    opencode: join(home, ".config/opencode/plugins/axi-checkpoint-axi-hook.js"),
  };
  const failures: string[] = [];
  for (const [agent, target] of Object.entries(integrations)) {
    try {
      let current = "";
      try { current = readFileSync(target, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      let next: string;
      if (agent === "opencode") {
        if (current && !current.startsWith("// checkpoint-axi managed session plugin\n")) throw new Error("Unmanaged plugin");
        next = openCodePlugin(executable);
      } else if (agent === "codexFeature") {
        const parsed = parse(current);
        const features = parsed.features;
        if (features !== undefined && (!features || typeof features !== "object" || Array.isArray(features))) throw new Error("Invalid features table");
        next = computeCodexConfigUpdate(current)[0];
        if (!isDeepStrictEqual(parse(next), { ...parsed, features: { ...(features as Record<string, unknown> | undefined), hooks: true } })) throw new Error("Cannot safely update features table");
      } else {
        const settings = current ? JSON.parse(current) : {};
        if (!settings || typeof settings !== "object" || Array.isArray(settings)
          || settings.hooks !== undefined && (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks))
          || settings.hooks?.SessionStart !== undefined && (!Array.isArray(settings.hooks.SessionStart)
            || settings.hooks.SessionStart.some((group: unknown) => !group || typeof group !== "object" || !("hooks" in group) || !Array.isArray(group.hooks)))) throw new Error("Invalid hook settings");
        const [updated, changed] = computeSessionStartHookUpdate(settings, { marker, command, timeoutSeconds: 25 });
        next = changed ? `${JSON.stringify(updated, null, 2)}\n` : current;
      }
      if (next !== current) {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, next, "utf8");
      }
    } catch { failures.push(target); }
  }
  if (failures.length) throw new AxiError("Some session integrations could not be installed or repaired", "HOOK_SETUP_FAILED",
    failures.map((path) => `Check permissions and syntax at ${path}; rerun checkpoint-axi setup hooks (other integrations may already be installed)`));
  return { status: "installed", integrations };
}

function openCodePlugin(executable: string): string {
  return `// checkpoint-axi managed session plugin
import { execFile } from "node:child_process";
const executable = ${JSON.stringify(executable)};
function context(directory) {
  const sessions = new Map();
  return (id) => {
    if (!sessions.has(id)) sessions.set(id, new Promise((resolve) => {
      execFile(executable, [], { cwd: directory, timeout: 25000, maxBuffer: 65536 }, (error, stdout) => {
        resolve(stdout.trim() || (error ? "checkpoint-axi: context unavailable; run checkpoint-axi home --offline" : ""));
      });
    }));
    return sessions.get(id);
  };
}
export default {
  id: "axi-checkpoint-axi-hook",
  async setup(ctx) {
    const read = context(ctx.location.directory);
    await ctx.session.hook("context", async (event) => {
      const text = await read(event.sessionID);
      if (text) event.system.push({ type: "text", text });
    });
  },
  async server({ directory }) {
    const read = context(directory);
    return { "experimental.chat.system.transform": async (input, output) => {
      const text = await read(input.sessionID);
      if (text) output.system.push(text);
    } };
  },
};
`;
}
