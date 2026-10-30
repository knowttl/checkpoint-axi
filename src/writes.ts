import { AxiError } from "axi-sdk-js";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { credentialStore } from "./profiles.js";
import { gateway } from "./transport.js";
import { protectWindowsFile, windowsAcl } from "./private-file.js";
import { responseInvalid } from "./response-invalid.js";

type Store = ReturnType<typeof credentialStore>;
type Flags = Map<string, string>;
const fail = (code: string, message: string, help: string[] = []): never => { throw new AxiError(message, code, help); };
export type WriteAuthorization = Readonly<{ operation: string; targets: readonly string[]; profile: string; region: string }>;
const authorizations = new WeakSet<WriteAuthorization>();

export function consumeWriteAuthorization(authorization: WriteAuthorization, operation: string, targets: readonly string[], profile: string, region: string): boolean {
  if (!authorizations.delete(authorization)) return false;
  return authorization.operation === operation && authorization.profile === profile && authorization.region === region
    && targets.length > 0 && targets.length <= 20 && new Set(targets).size === targets.length
    && targets.every((target) => authorization.targets.includes(target));
}

// Metadata only, never message payloads, headers, credentials or API bodies.
function journal(store: Store) {
  const path = store.writeLogPath();
  function append(record: Record<string, unknown>) {
    let lock: number | undefined;
    let fd: number | undefined;
    try {
      const directory = dirname(path);
      const created = mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (process.platform === "win32" && created !== undefined) protectWindowsFile(directory);
      const parent = lstatSync(directory);
      if (!parent.isDirectory() || parent.isSymbolicLink() || process.platform !== "win32"
        && (parent.uid !== process.getuid!() || (parent.mode & 0o077) !== 0)) throw new Error("Insecure journal directory");
      if (process.platform === "win32") windowsAcl(directory, true);
      lock = openSync(`${path}.lock`, "wx", 0o600);
      if (process.platform === "win32") protectWindowsFile(`${path}.lock`);
      try {
        fd = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL, 0o600);
        if (process.platform === "win32") protectWindowsFile(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = lstatSync(path);
        if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1 || process.platform !== "win32"
          && (existing.uid !== process.getuid!() || (existing.mode & 0o077) !== 0)) throw new Error("Insecure journal file");
        if (process.platform === "win32") windowsAcl(path, true);
        fd = openSync(path, constants.O_RDWR | constants.O_APPEND | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
      }
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || process.platform !== "win32"
        && (stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0)) throw new Error("Insecure journal file");
      if (process.platform === "win32") windowsAcl(path, true);
      const contents = readFileSync(fd, "utf8");
      if (contents && !contents.endsWith("\n")) throw new Error("Incomplete journal");
      for (const line of contents.split("\n").filter(Boolean)) {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (!entry || !["intent", "outcome"].includes(String(entry.kind)) || typeof entry.auditId !== "string") throw new Error("Invalid journal");
        if (record.kind === "intent" && entry.kind === "intent" && entry.auditId === record.auditId) throw new Error("Duplicate intent");
      }
      const line = Buffer.from(JSON.stringify(store.redactor.value({ ...record, time: new Date().toISOString() })) + "\n");
      let offset = 0;
      while (offset < line.length) {
        const written = writeSync(fd, line, offset, line.length - offset);
        if (!written) throw new Error("Incomplete journal write");
        offset += written;
      }
      fsyncSync(fd);
      // The directory entry must survive a crash too, before sending anything.
      if (process.platform !== "win32") {
        const stop = created === undefined ? directory : dirname(created);
        let current = directory;
        for (;;) {
          const directoryFd = openSync(current, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
          if (current === stop) break;
          current = dirname(current);
        }
      }
    } catch {
      fail(record.kind === "intent" ? "INTENT_NOT_RECORDED" : "OUTCOME_NOT_RECORDED",
        record.kind === "intent" ? "Durable write intent could not be recorded; nothing was sent" : "Write outcome could not be recorded; reconcile before any further action",
        [`Audit ID: ${String(record.auditId)}`, "Check CHECKPOINT_AXI_WRITE_LOG and its private directory permissions; never replay an ambiguous action"]);
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (lock !== undefined) { closeSync(lock); unlinkSync(`${path}.lock`); }
    }
  }
  return append;
}

// Domain callers bind the operation and single send; flags cannot supply routes.
export async function coordinateWrite(args: {
  operation: string; targets: readonly string[]; flags: Flags; store: Store; scope: { profile: string; region: string };
  checkScope: () => void;
  readState: () => Promise<{ noop: boolean; state: unknown }>;
  send: (authorization: WriteAuthorization, checkScopeBeforeSend: () => void) => Promise<Record<string, unknown>>;
}): Promise<Record<string, unknown>> {
  const { operation, targets, flags, store, checkScope, readState, send } = args;
  if (!targets.length || targets.length > 20 || new Set(targets).size !== targets.length) fail("VALIDATION_ERROR", "Supply 1-20 unique targets");
  if (flags.has("--execute") && flags.has("--dry-run")) fail("VALIDATION_ERROR", "--execute cannot combine with --dry-run");
  checkScope();
  const current = await readState();
  const confirmation = `${operation} ${targets.join(",")}`;
  const preview = { operation, effect: "disruptive", targets, noop: current.noop, currentState: current.state, confirm: confirmation };
  if (!flags.has("--execute")) return { outcome: "preview", preview };
  if (current.noop) return { outcome: "noop", preview };
  if (!flags.has("--confirm")) fail("CONFIRM_REQUIRED", "Exact target confirmation is required", [`Repeat with --confirm '${confirmation}'`]);
  if (flags.get("--confirm") !== confirmation) fail("CONFIRM_MISMATCH", "Confirmation does not exactly match the operation and every target", [`Repeat with --confirm '${confirmation}'`]);
  checkScope();
  const auditId = randomUUID();
  const record = journal(store);
  const meta = { auditId, ...args.scope, operation, targets, effect: "disruptive" };
  record({ ...meta, kind: "intent" });
  let fresh: Awaited<ReturnType<typeof readState>>;
  try { fresh = await readState(); checkScope(); }
  catch (error) { record({ ...meta, kind: "outcome", outcome: "NOT_SENT" }); throw error; }
  if (fresh.noop) {
    record({ ...meta, kind: "outcome", outcome: "NOT_SENT" });
    return { outcome: "noop", preview, auditId };
  }
  const authorization: WriteAuthorization = Object.freeze({ operation, targets: Object.freeze([...targets]), ...args.scope });
  authorizations.add(authorization);
  let result: Record<string, unknown>;
  let scopeRevoked = false;
  try { result = await send(authorization, () => {
    try { checkScope(); }
    catch (error) { scopeRevoked = true; throw error; }
  }); }
  catch (error) {
    if (scopeRevoked) {
      record({ ...meta, kind: "outcome", outcome: "NOT_SENT" });
      throw error;
    }
    record({ ...meta, kind: "outcome", outcome: "OUTCOME_UNKNOWN" });
    throw Object.assign(new AxiError("Action outcome is unknown; never replay automatically", "OUTCOME_UNKNOWN", [
      `Audit ID: ${auditId}`, "Inspect the write journal and read back every target before deciding what to do next",
    ]), { cause: error });
  }
  finally { authorizations.delete(authorization); }
  record({ ...meta, kind: "outcome", outcome: "accepted" });
  return { outcome: "accepted", auditId, ...result };
}

const entity = z.object({ entityInfo: z.object({ entityId: z.string(), saasEntityType: z.string() }),
  entityPayload: z.object({ isQuarantined: z.boolean().optional(), isRestored: z.boolean().optional() }),
  entityAvailableActions: z.array(z.object({ entityActionName: z.string() })) });
const task = z.object({ entityId: z.string(), taskId: z.union([z.string().regex(/^[A-Za-z0-9_-]+$/), z.number().int().nonnegative()]) });

const event = z.object({ eventId: z.string(), entityId: z.string(), state: z.string(),
  availableEventActions: z.array(z.object({ actionName: z.string(), actionParameter: z.record(z.string(), z.unknown()) })) });
const eventTask = task.extend({ eventId: z.string() });

export async function eventWriteCommand(flags: Flags, store: Store, transport?: Parameters<typeof gateway>[3]) {
  const targets = flags.get("--ids")?.split(",") ?? [];
  const action = flags.get("--name");
  if (!targets.length || targets.length > 20 || new Set(targets).size !== targets.length
    || targets.some((id) => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(id))
    || !action || !/^[a-z][A-Za-z0-9_-]{0,127}$/.test(action)) {
    return fail("VALIDATION_ERROR", "Supply --name <action> and --ids with 1-20 unique comma-separated event IDs");
  }
  if (flags.has("--execute") && flags.has("--dry-run")) return fail("VALIDATION_ERROR", "--execute cannot combine with --dry-run");
  store.readOnly();
  const profile = store.select(store.load(flags.get("--config"), true).config, flags.get("--profile"));
  const operation = `event.action.${action}`;
  const checkScope = () => {
    if (store.readOnly() || !profile.writes.allowWrites) fail("WRITES_DISABLED", "Writes are disabled for the selected profile");
    if (!profile.writes.operations.includes(operation)) fail("OPERATION_NOT_WRITABLE", "Operation is outside the selected profile's exact write scope");
    const fresh = store.select(store.load(flags.get("--config"), true).config, flags.get("--profile"));
    if (JSON.stringify(fresh) !== JSON.stringify(profile)) fail("CONFIG_CHANGED", "Profile changed during the write; nothing was sent");
  };
  checkScope();
  const session = gateway(profile, store.credentials(profile, true), store.redactor, transport, true);
  const entities = new Map<string, string>();
  const readState = async () => {
    const states = [];
    for (const id of targets) {
      const page = await session.read({ path: `/event/${encodeURIComponent(id)}` });
      const parsed = event.safeParse(page.records[0]);
      if (page.records.length !== 1 || !parsed.success || parsed.data.eventId !== id) {
        throw responseInvalid("Event preflight returned a missing, mismatched or malformed event",
          { responseData: page.dataIsArray ? page.records : page.records[0] }, [["responseData"]]);
      }
      const value = parsed.data;
      const offered = value.availableEventActions.filter((item) => item.actionName === action);
      if (!offered.length) fail("ACTION_UNAVAILABLE", "Requested action is unavailable for an event target");
      // Guide pp.36-37 uses objects, but p.43 requires strings; never guess serialization.
      if (offered.length !== 1 || Object.keys(offered[0]!.actionParameter).length) {
        fail("ENDPOINT_UNVERIFIED", "Parameterized event actions require live commissioning through Artium", ["Run checkpoint-axi event show <id> to inspect available actions; parameter serialization is unverified (guide pages 36-37, 43)"]);
      }
      entities.set(id, value.entityId);
      states.push({ id, state: value.state, action });
    }
    return { noop: false, state: states };
  };
  return coordinateWrite({ operation, targets, flags, store, scope: { profile: profile.name, region: profile.region }, checkScope, readState, send: async (authorization) => {
    const page = await session.eventAction(authorization, action, targets);
    const parsed = z.array(eventTask).safeParse(page.records);
    if (!parsed.success || parsed.data.length !== targets.length || new Set(parsed.data.map((item) => item.eventId)).size !== targets.length
      || parsed.data.some((item) => !targets.includes(item.eventId) || entities.get(item.eventId) !== item.entityId
        || store.redactor.text(String(item.taskId)) !== String(item.taskId))) {
      throw responseInvalid("Action response did not identify a task for every event target",
        { responseData: page.dataIsArray ? page.records : page.records[0] }, [["responseData"]]);
    }
    return { tasks: parsed.data.map((item) => ({ ...item, outcome: "accepted" })), help: ["Run checkpoint-axi task show <taskId> to inspect asynchronous execution; accepted does not mean completed"] };
  } });
}

export async function emailWriteCommand(name: "email quarantine" | "email restore", flags: Flags, store: Store, transport?: Parameters<typeof gateway>[3]) {
  const targets = flags.get("--ids")?.split(",") ?? [];
  if (!targets.length || targets.length > 20 || new Set(targets).size !== targets.length
    || targets.some((id) => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(id))) {
    return fail("VALIDATION_ERROR", "--ids must name 1-20 unique comma-separated entity IDs");
  }
  if (flags.has("--execute") && flags.has("--dry-run")) return fail("VALIDATION_ERROR", "--execute cannot combine with --dry-run");
  store.readOnly();
  const loaded = store.load(flags.get("--config"), true);
  const profile = store.select(loaded.config, flags.get("--profile"));
  const operation = name.replace(" ", ".");
  const checkScope = () => {
    if (store.readOnly() || !profile.writes.allowWrites) fail("WRITES_DISABLED", "Writes are disabled for the selected profile");
    if (!profile.writes.operations.includes(operation)) fail("OPERATION_NOT_WRITABLE", "Operation is outside the selected profile's exact write scope");
    const fresh = store.select(store.load(flags.get("--config"), true).config, flags.get("--profile"));
    if (JSON.stringify(fresh) !== JSON.stringify(profile)) fail("CONFIG_CHANGED", "Profile changed during the write; nothing was sent");
  };
  checkScope();
  const session = gateway(profile, store.credentials(profile, true), store.redactor, transport, true);
  const action = name === "email quarantine" ? "quarantine" : "restore";
  let pending = targets;
  const readState = async () => {
    const states = [];
    for (const id of targets) {
      const page = await session.read({ path: `/search/entity/${encodeURIComponent(id)}` });
      const parsed = entity.safeParse(page.records[0]);
      if (page.records.length !== 1 || !parsed.success || parsed.data.entityInfo.entityId !== id
        || !["office365_emails_email", "google_mail_email"].includes(parsed.data.entityInfo.saasEntityType)) {
        throw responseInvalid("Email preflight returned a missing, mismatched or malformed entity",
          { responseData: page.dataIsArray ? page.records : page.records[0] }, [["responseData"]]);
      }
      const value = parsed.data;
      const noop = action === "quarantine" ? value.entityPayload.isQuarantined === true
        : value.entityPayload.isRestored === true && value.entityPayload.isQuarantined === false;
      if (!noop && !value.entityAvailableActions.some((item) => item.entityActionName === action)) fail("ACTION_UNAVAILABLE", "Requested action is unavailable for an email target");
      states.push({ id, noop, isQuarantined: value.entityPayload.isQuarantined, isRestored: value.entityPayload.isRestored });
    }
    pending = states.filter((state) => !state.noop).map((state) => state.id);
    return { noop: pending.length === 0, state: states };
  };
  return coordinateWrite({ operation, targets, flags, store, scope: { profile: profile.name, region: profile.region }, checkScope, readState, send: async (authorization) => {
    const page = await session.emailAction(authorization, action, pending);
    const parsed = z.array(task).safeParse(page.records);
    if (!parsed.success || parsed.data.length !== pending.length || new Set(parsed.data.map((item) => item.entityId)).size !== pending.length
      || parsed.data.some((item) => !pending.includes(item.entityId) || store.redactor.text(String(item.taskId)) !== String(item.taskId))) {
      throw responseInvalid("Action response did not identify a task for every target",
        { responseData: page.dataIsArray ? page.records : page.records[0] }, [["responseData"]]);
    }
    return { tasks: parsed.data.map((item) => ({ ...item, outcome: "accepted" })), help: ["Run checkpoint-axi task show <taskId> to inspect asynchronous execution; accepted does not mean completed"] };
  } });
}
