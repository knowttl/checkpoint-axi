import { chmodSync, existsSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { decode } from "@toon-format/toon";
import { main } from "../src/cli.js";
import { localFixture } from "./support/local-cli.js";
import { fakeGateway } from "./support/fake-gateway.js";
import { credentialStore } from "../src/profiles.js";
import { gateway } from "../src/transport.js";

const email = JSON.parse(readFileSync(new URL("./fixtures/email-page.json", import.meta.url), "utf8"));
const acknowledgement = JSON.parse(readFileSync(new URL("./fixtures/email-action-page.json", import.meta.url), "utf8"));
const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); process.exitCode = 0; });
const execute = ["--ids", "synthetic-email-1", "--execute", "--confirm", "email.restore synthetic-email-1"];

async function setup(handler?: Parameters<typeof fakeGateway>[0]) {
  const local = localFixture();
  cleanups.push(local.cleanup);
  local.profile.profiles.example.writes = { allowWrites: true, operations: ["email.restore", "email.quarantine"] };
  local.save();
  const log = join(local.directory, "writes.log");
  local.env.CHECKPOINT_AXI_WRITE_LOG = log;
  const requests: { path: string; body: any }[] = [];
  const server = await fakeGateway((request, response, body) => {
    requests.push({ path: request.url!, body });
    if (request.url === "/auth/external") return response.end(JSON.stringify({ token: "synthetic-token-sentinel" }));
    if (handler) return handler(request, response, body);
    if (request.url?.includes("/search/entity/")) return response.end(JSON.stringify(email));
    response.end(JSON.stringify(acknowledgement));
  });
  cleanups.push(server.close);
  return { local, log, requests, journal: () => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)),
    run: async (args: string[]) => {
      let output = "";
      await main(["email", ...args], { credentials: local.context, transport: { agent: server.agent }, stdout: { write: (chunk) => { output += chunk; } } });
      const code = process.exitCode ?? 0;
      process.exitCode = 0;
      return { code, output, data: decode(output) as Record<string, any> };
    } };
}

test.each([
  { forced: "true", allow: true, operations: ["email.restore"], code: "WRITES_DISABLED" },
  { forced: "false", allow: false, operations: ["email.restore"], code: "WRITES_DISABLED" },
  { forced: "false", allow: true, operations: ["email.*"], code: "CONFIG_INVALID" },
  { forced: "false", allow: true, operations: ["email.quarantine"], code: "OPERATION_NOT_WRITABLE" },
  { forced: "invalid", allow: true, operations: ["email.restore"], code: "CONFIG_INVALID" },
])("scope gate refuses before authentication: $code $forced $allow", async ({ forced, allow, operations, code }) => {
  const cli = await setup();
  cli.local.env.CHECKPOINT_AXI_READ_ONLY = forced;
  cli.local.profile.profiles.example.writes = { allowWrites: allow, operations };
  cli.local.save();
  expect((await cli.run(["restore", ...execute])).data.error.code).toBe(code);
  expect(cli.requests).toEqual([]);
  expect(existsSync(cli.log)).toBe(false);
});

test.each([
  [], ["--ids", ""], ["--ids", "a,a"], ["--ids", "../escape"], ["--ids", "a, b"],
  ["--ids", Array.from({ length: 21 }, (_, i) => `synthetic-email-${i}`).join(",")],
  ["--ids", "a", "--execute", "--dry-run"], ["--ids", "a", "--execut"],
])("invalid write input is rejected before configuration: %j", async (...args) => {
  const cli = await setup();
  cli.local.env.CHECKPOINT_AXI_CONFIG = "/missing/config.json";
  expect((await cli.run(["restore", ...args])).code).toBe(2);
  expect(cli.requests).toEqual([]);
});

test("preview reads current state and sends no action or journal", async () => {
  const cli = await setup();
  const result = await cli.run(["restore", "--ids", "synthetic-email-1"]);
  expect(result.data).toMatchObject({ outcome: "preview", preview: { effect: "disruptive", noop: false, confirm: "email.restore synthetic-email-1" } });
  expect(cli.requests.map((item) => item.path)).toEqual(["/auth/external", "/app/hec-api/v1.0/search/entity/synthetic-email-1"]);
  expect(existsSync(cli.log)).toBe(false);
});

test.each([
  { flags: [], code: "CONFIRM_REQUIRED" },
  { flags: ["--confirm", "synthetic-email-1"], code: "CONFIRM_MISMATCH" },
  { flags: ["--confirm", "email.quarantine synthetic-email-1"], code: "CONFIRM_MISMATCH" },
])("execute requires exact operation and all targets: $code", async ({ flags, code }) => {
  const cli = await setup();
  expect((await cli.run(["restore", "--ids", "synthetic-email-1", "--execute", ...flags])).data.error.code).toBe(code);
  expect(cli.requests).toHaveLength(2);
  expect(existsSync(cli.log)).toBe(false);
});

test.each(["restore", "quarantine"])("%s journals intent before re-read and one asynchronous send", async (action) => {
  let reads = 0;
  const cli = await setup((request, response, body) => {
    if (request.url?.includes("/search/entity/")) {
      reads++;
      if (reads === 2) expect(cli.journal()[0]).toMatchObject({ kind: "intent", operation: `email.${action}` });
      const record = structuredClone(email);
      record.responseData[0].entityPayload.isQuarantined = action === "restore";
      record.responseData[0].entityAvailableActions = [{ entityActionName: action }];
      return response.end(JSON.stringify(record));
    }
    expect(request.method).toBe("POST");
    expect(body).toEqual({ requestData: { entityIds: ["synthetic-email-1"], entityActionName: [action], entityActionParam: [""] } });
    response.end(JSON.stringify(acknowledgement));
  });
  const result = await cli.run([action, "--ids", "synthetic-email-1", "--execute", "--confirm", `email.${action} synthetic-email-1`]);
  expect(result.code).toBe(0);
  expect(result.data).toMatchObject({ outcome: "accepted", tasks: [{ entityId: "synthetic-email-1", taskId: "123456", outcome: "accepted" }] });
  expect(cli.journal()).toMatchObject([{ kind: "intent", auditId: result.data.auditId }, { kind: "outcome", auditId: result.data.auditId, outcome: "accepted" }]);
  expect(statSync(cli.log).mode & 0o777).toBe(0o600);
  expect(readFileSync(cli.log, "utf8")).not.toMatch(/synthetic-secret-sentinel|synthetic-token-sentinel|entityPayload/);
  expect(cli.requests.filter((item) => item.path.endsWith("/action/entity"))).toHaveLength(1);
});

test("the action sender rejects a forged coordinator authorization before authentication", async () => {
  const cli = await setup();
  const store = credentialStore(cli.local.context);
  const profile = store.select(store.load().config);
  const session = gateway(profile, store.credentials(profile), store.redactor, {}, true);
  await expect(session.emailAction({ operation: "email.restore", targets: ["synthetic-email-1"], profile: profile.name, region: profile.region }, "restore", ["synthetic-email-1"]))
    .rejects.toMatchObject({ code: "WRITES_DISABLED" });
  expect(cli.requests).toEqual([]);
});

test("twenty targets fit both preflight reads and one batch send", async () => {
  const ids = Array.from({ length: 20 }, (_, i) => `synthetic-email-${i}`);
  const cli = await setup((request, response, body) => {
    if (request.url?.includes("/search/entity/")) {
      const record = structuredClone(email);
      record.responseData[0].entityInfo.entityId = request.url.split("/").at(-1);
      return response.end(JSON.stringify(record));
    }
    expect(body).toMatchObject({ requestData: { entityIds: ids } });
    response.end(JSON.stringify({ ...acknowledgement, responseData: ids.map((entityId) => ({ entityId, taskId: 123456 })) }));
  });
  expect((await cli.run(["restore", "--ids", ids.join(","), "--execute", "--confirm", `email.restore ${ids.join(",")}`])).data.outcome).toBe("accepted");
  expect(cli.requests).toHaveLength(42);
});

test("already quarantined email is a no-op without confirmation or journal", async () => {
  const cli = await setup();
  const result = await cli.run(["quarantine", "--ids", "synthetic-email-1", "--execute"]);
  expect(result.data.outcome).toBe("noop");
  expect(cli.requests).toHaveLength(2);
  expect(existsSync(cli.log)).toBe(false);
});

test("mixed batches send only emails still needing the requested state", async () => {
  const cli = await setup((request, response, body) => {
    if (request.url?.includes("/search/entity/")) {
      const record = structuredClone(email);
      const id = request.url.split("/").at(-1);
      record.responseData[0].entityInfo.entityId = id;
      record.responseData[0].entityPayload.isRestored = id === "synthetic-email-2";
      record.responseData[0].entityPayload.isQuarantined = id !== "synthetic-email-2";
      return response.end(JSON.stringify(record));
    }
    expect(body).toMatchObject({ requestData: { entityIds: ["synthetic-email-1"] } });
    response.end(JSON.stringify(acknowledgement));
  });
  const result = await cli.run(["restore", "--ids", "synthetic-email-1,synthetic-email-2", "--execute", "--confirm", "email.restore synthetic-email-1,synthetic-email-2"]);
  expect(result.data.outcome).toBe("accepted");
  expect(cli.requests).toHaveLength(6);
});

test("a target reaching desired state during re-read records no send", async () => {
  let reads = 0;
  const cli = await setup((_request, response) => {
    const record = structuredClone(email);
    if (++reads === 2) {
      record.responseData[0].entityPayload.isQuarantined = false;
      record.responseData[0].entityPayload.isRestored = true;
    }
    response.end(JSON.stringify(record));
  });
  expect((await cli.run(["restore", ...execute])).data.outcome).toBe("noop");
  expect(cli.journal()[1].outcome).toBe("NOT_SENT");
  expect(cli.requests).toHaveLength(3);
});

test("an outcome journal failure preserves the intent and reports reconciliation", async () => {
  const cli = await setup((request, response) => {
    if (request.url?.includes("/search/entity/")) return response.end(JSON.stringify(email));
    writeFileSync(`${cli.log}.lock`, "", { mode: 0o600 });
    response.end(JSON.stringify(acknowledgement));
  });
  expect((await cli.run(["restore", ...execute])).data.error.code).toBe("OUTCOME_NOT_RECORDED");
  expect(cli.journal()).toHaveLength(1);
  expect(cli.requests).toHaveLength(4);
});

test("execution creates a private journal in newly created nested state directories", async () => {
  const cli = await setup();
  const log = join(cli.local.directory, "new-state", "checkpoint-axi", "writes.log");
  cli.local.env.CHECKPOINT_AXI_WRITE_LOG = log;
  expect((await cli.run(["restore", ...execute])).data.outcome).toBe("accepted");
  expect(statSync(join(cli.local.directory, "new-state", "checkpoint-axi")).mode & 0o777).toBe(0o700);
  expect(statSync(log).mode & 0o777).toBe(0o600);
  expect(readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line).kind)).toEqual(["intent", "outcome"]);
});

test.each(["missing", "mismatch", "not-email"])("preflight refuses invalid target identity: %s", async (kind) => {
  const cli = await setup((_request, response) => {
    const record = structuredClone(email);
    if (kind === "missing") record.responseData = [];
    if (kind === "mismatch") record.responseData[0].entityInfo.entityId = "synthetic-other";
    if (kind === "not-email") record.responseData[0].entityInfo.saasEntityType = "synthetic-file";
    response.end(JSON.stringify(record));
  });
  expect((await cli.run(["restore", ...execute])).data.error.code).toBe("RESPONSE_INVALID");
  expect(cli.requests).toHaveLength(2);
  expect(existsSync(cli.log)).toBe(false);
});

test.each(["symlink", "permissions", "partial", "lock"])("unsafe journal blocks the send: %s", async (kind) => {
  const cli = await setup();
  if (kind === "symlink") symlinkSync(cli.local.config, cli.log);
  if (kind === "permissions") { writeFileSync(cli.log, "", { mode: 0o600 }); chmodSync(cli.log, 0o644); }
  if (kind === "partial") writeFileSync(cli.log, "{", { mode: 0o600 });
  if (kind === "lock") writeFileSync(`${cli.log}.lock`, "", { mode: 0o600 });
  expect((await cli.run(["restore", ...execute])).data.error.code).toBe("INTENT_NOT_RECORDED");
  expect(cli.requests).toHaveLength(2);
});

test.each([401, 429, 500, 302])("action HTTP %i is never retried or reauthenticated", async (status) => {
  const cli = await setup((request, response) => {
    if (request.url?.includes("/search/entity/")) return response.end(JSON.stringify(email));
    response.writeHead(status, { "retry-after": "0", location: "https://example.test/redirect" });
    response.end("synthetic-secret-sentinel synthetic-token-sentinel");
  });
  const result = await cli.run(["restore", ...execute]);
  expect(result.data.error.code).toBe("OUTCOME_UNKNOWN");
  expect(result.output).not.toMatch(/synthetic-secret-sentinel|synthetic-token-sentinel/);
  expect(cli.requests).toHaveLength(4);
  expect(cli.journal()[1]).toMatchObject({ outcome: "OUTCOME_UNKNOWN" });
});

test.each(["disconnect", "invalid-json", "missing-task", "mismatched-target"])("ambiguous acknowledgement is not replayed: %s", async (kind) => {
  const cli = await setup((request, response) => {
    if (request.url?.includes("/search/entity/")) return response.end(JSON.stringify(email));
    if (kind === "disconnect") return response.destroy();
    if (kind === "invalid-json") return response.end("{");
    response.end(JSON.stringify({ ...acknowledgement, responseData: kind === "missing-task" ? [] : [{ entityId: "synthetic-other", taskId: 123 }] }));
  });
  expect((await cli.run(["restore", ...execute])).data.error.code).toBe("OUTCOME_UNKNOWN");
  expect(cli.requests).toHaveLength(4);
  expect(cli.journal()[1].outcome).toBe("OUTCOME_UNKNOWN");
});

test("an HTML action acknowledgement preserves safe diagnostics and reconciliation", async () => {
  const cli = await setup((request, response) => {
    if (request.url?.includes("/search/entity/")) return response.end(JSON.stringify(email));
    response.writeHead(200, { "content-type": "text/html; private=synthetic-secret-sentinel" });
    response.end("<html>private-content-sentinel synthetic-token-sentinel</html>");
  });
  const result = await cli.run(["restore", ...execute]);
  expect(result.code).toBe(1);
  expect(result.data.error).toMatchObject({ code: "OUTCOME_UNKNOWN", status: 200, contentType: "text/html", shape: [{ path: "$", type: "undefined" }] });
  expect(result.data.help[0]).toMatch(/^Audit ID:/);
  expect(result.output).not.toMatch(/private-content-sentinel|synthetic-token-sentinel|synthetic-secret-sentinel|<html>/);
  expect(cli.requests).toHaveLength(4);
  expect(cli.journal()[1].outcome).toBe("OUTCOME_UNKNOWN");
});

test("scope revoked during re-read aborts before sending", async () => {
  let reads = 0;
  const cli = await setup((_request, response) => {
    if (++reads === 2) {
      cli.local.profile.profiles.example.writes.allowWrites = false;
      cli.local.save();
    }
    response.end(JSON.stringify(email));
  });
  expect((await cli.run(["restore", ...execute])).data.error.code).toBe("CONFIG_CHANGED");
  expect(cli.requests).toHaveLength(3);
  expect(cli.journal()[1].outcome).toBe("NOT_SENT");
});

test("action unavailable on re-read aborts the entire batch", async () => {
  let reads = 0;
  const cli = await setup((_request, response) => {
    const record = structuredClone(email);
    if (++reads === 2) record.responseData[0].entityAvailableActions = [];
    response.end(JSON.stringify(record));
  });
  expect((await cli.run(["restore", ...execute])).data.error.code).toBe("ACTION_UNAVAILABLE");
  expect(cli.requests).toHaveLength(3);
  expect(cli.journal()[1].outcome).toBe("NOT_SENT");
});
