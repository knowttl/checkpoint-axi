import { AxiError, computeCodexConfigUpdate } from "axi-sdk-js";
import { accessSync, constants, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parse } from "@iarna/toml";

type Hook = { command?: string; args?: string[]; [key: string]: unknown };

export function setupHooks(): Record<string, unknown> {
  const marker = "checkpoint-axi-hook";
  const execPath = fileURLToPath(new URL("../../bin/checkpoint-axi-hook.js", import.meta.url));
  let executable = process.execPath;
  let args = [execPath];
  if (process.platform !== "win32") {
    for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
      const candidate = join(directory, marker);
      try {
        accessSync(candidate, constants.X_OK);
        if (realpathSync(candidate) === realpathSync(execPath)) {
          executable = marker;
          args = [];
        }
        break;
      } catch { continue; }
    }
  }
  const command = process.platform === "win32"
    ? `& ${[executable, ...args].map((path) => `'${path.replaceAll("'", "''")}'`).join(" ")}`
    : [executable, ...args].map((path) => `'${path.replaceAll("'", "'\\''")}'`).join(" ");
  const home = homedir();
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const codexHome = process.env.CODEX_HOME || join(home, ".codex");
  const integrations = {
    claude: join(claudeHome, "settings.json"),
    codex: join(codexHome, "hooks.json"),
    codexFeature: join(codexHome, "config.toml"),
    opencode: join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "opencode/plugins/axi-checkpoint-axi-hook.js"),
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
        next = openCodePlugin(executable, args);
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
        const updated = structuredClone(settings);
        updated.hooks ??= {};
        const managed = (hook: Hook | null) => hook?.command?.includes(marker)
          || hook?.args?.some((arg) => arg.includes(marker));
        if (Array.isArray(updated.hooks.session_start)) {
          updated.hooks.session_start = updated.hooks.session_start.filter((hook: Hook | null) => !managed(hook));
          if (!updated.hooks.session_start.length) delete updated.hooks.session_start;
        }
        const groups: { matcher?: string; hooks: Hook[] }[] = updated.hooks.SessionStart ??= [];
        const hook = { type: "command", command: agent === "claude" ? executable : command,
          ...(agent === "claude" ? { args } : {}), timeout: 25 };
        let found = false;
        for (const group of groups) {
          for (let index = 0; index < group.hooks.length; index++) {
            if (!managed(group.hooks[index]!)) continue;
            group.hooks[index] = hook;
            found = true;
          }
        }
        if (!found) groups.push({ matcher: "", hooks: [hook] });
        next = isDeepStrictEqual(updated, settings) ? current : `${JSON.stringify(updated, null, 2)}\n`;
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

function openCodePlugin(executable: string, args: string[]): string {
  return `// checkpoint-axi managed session plugin
import { execFile } from "node:child_process";
const executable = ${JSON.stringify(executable)};
const args = ${JSON.stringify(args)};
function context(directory) {
  const sessions = new Map();
  return (id) => {
    if (!sessions.has(id)) sessions.set(id, new Promise((resolve) => {
      execFile(executable, args, { cwd: directory, timeout: 25000, maxBuffer: 65536 }, (error, stdout) => {
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
