import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { decode } from "@toon-format/toon";
import { main } from "../src/cli.js";
import { credentialStore } from "../src/profiles.js";
import { gateway } from "../src/transport.js";
import { localFixture } from "./support/local-cli.js";
import { fakeGateway } from "./support/fake-gateway.js";

const event = JSON.parse(readFileSync(new URL("./fixtures/event-page.json", import.meta.url), "utf8"));
const acknowledgement = JSON.parse(readFileSync(new URL("./fixtures/event-action-page.json", import.meta.url), "utf8"));
const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); process.exitCode = 0; });
const preview = ["--ids", "synthetic-event-1", "--name", "dismiss"];
const execute = [...preview, "--execute", "--confirm", "event.action.dismiss synthetic-event-1"];

async function setup(handler?: Parameters<typeof fakeGateway>[0]) {
  const local = localFixture();
  cleanups.push(local.cleanup);
  local.profile.profiles.example.writes = { allowWrites: true, operations: ["event.action.dismiss", "event.action.severityChange"] };
  local.save();
  const log = join(local.directory, "writes.log");
  local.env.CHECKPOINT_AXI_WRITE_LOG = log;
  const requests: { path: string; body: any }[] = [];
  const server = await fakeGateway((request, response, body) => {
    requests.push({ path: request.url!, body });
    if (request.url === "/auth/external") return response.end(JSON.stringify({ token: "synthetic-token-sentinel" }));
    if (handler) return handler(request, response, body);
    response.end(JSON.stringify(request.url?.includes("/event/") ? event : acknowledgement));
  });
  cleanups.push(server.close);
  return { local, requests, log, journal: () => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)),
    run: async (args: string[]) => {
      let output = "";
      await main(["event", "action", ...args], { credentials: local.context, transport: { agent: server.agent }, stdout: { write: (chunk) => { output += chunk; } } });
      const code = process.exitCode ?? 0;
      process.exitCode = 0;
      return { code, output, data: decode(output) as Record<string, any> };
    } };
}

test.each([
  [], ["--ids", "synthetic-event-1"], ["--name", "dismiss"], ["--ids", "a,a", "--name", "dismiss"],
  ["--ids", "../escape", "--name", "dismiss"], ["--ids", "a", "--name", "../escape"],
  ["--ids", Array.from({ length: 21 }, (_, i) => `synthetic-event-${i}`).join(","), "--name", "dismiss"],
  [...preview, "--execute", "--dry-run"], [...preview, "--param", "High"],
])("invalid event action input is rejected before configuration: %j", async (...args) => {
  const cli = await setup();
  cli.local.env.CHECKPOINT_AXI_CONFIG = "/missing/config.json";
  expect((await cli.run(args)).code).toBe(2);
  expect(cli.requests).toEqual([]);
});

test.each([
  { forced: "true", operations: ["event.action.dismiss"], code: "WRITES_DISABLED" },
  { forced: "false", operations: ["email.quarantine"], code: "OPERATION_NOT_WRITABLE" },
])("event operation scope fails before authentication: $code", async ({ forced, operations, code }) => {
  const cli = await setup();
  cli.local.env.CHECKPOINT_AXI_READ_ONLY = forced;
  cli.local.profile.profiles.example.writes.operations = operations;
  cli.local.save();
  expect((await cli.run(execute)).data.error.code).toBe(code);
  expect(cli.requests).toEqual([]);
});

test("event preview reads state without a journal or action", async () => {
  const cli = await setup();
  expect((await cli.run(preview)).data).toMatchObject({ outcome: "preview", preview: {
    operation: "event.action.dismiss", confirm: "event.action.dismiss synthetic-event-1", noop: false,
  } });
  expect(cli.requests).toHaveLength(2);
  expect(existsSync(cli.log)).toBe(false);
});

test.each([
  { flags: [], code: "CONFIRM_REQUIRED" },
  { flags: ["--confirm", "dismiss synthetic-event-1"], code: "CONFIRM_MISMATCH" },
  { flags: ["--confirm", "event.action.dismiss synthetic-event-2"], code: "CONFIRM_MISMATCH" },
])("event execute requires exact confirmation: $code", async ({ flags, code }) => {
  const cli = await setup();
  expect((await cli.run([...preview, "--execute", ...flags])).data.error.code).toBe(code);
  expect(cli.requests).toHaveLength(2);
  expect(existsSync(cli.log)).toBe(false);
});

test("event execution journals intent before re-read and sends one schema-derived request", async () => {
  let reads = 0;
  const cli = await setup((request, response, body) => {
    if (request.url?.includes("/event/")) {
      if (++reads === 2) expect(cli.journal()[0]).toMatchObject({ kind: "intent", operation: "event.action.dismiss" });
      return response.end(JSON.stringify(event));
    }
    expect(request.method).toBe("POST");
    expect(body).toEqual({ requestData: { eventIds: ["synthetic-event-1"], eventActionName: ["dismiss"], eventActionParam: [""] } });
    response.end(JSON.stringify(acknowledgement));
  });
  const result = await cli.run(execute);
  expect(result.code).toBe(0);
  expect(result.data).toMatchObject({ outcome: "accepted", tasks: [{ eventId: "synthetic-event-1", entityId: "synthetic-email-1", taskId: "123456", outcome: "accepted" }] });
  expect(cli.journal()).toMatchObject([{ kind: "intent", auditId: result.data.auditId }, { kind: "outcome", auditId: result.data.auditId, outcome: "accepted" }]);
  expect(cli.requests).toHaveLength(4);
  expect(readFileSync(cli.log, "utf8")).not.toMatch(/synthetic-secret-sentinel|synthetic-token-sentinel|availableEventActions/);
});

test.each([
  { actions: [], code: "ACTION_UNAVAILABLE" },
  { actions: [{ actionName: "dismiss", actionParameter: { eventId: "synthetic-event-1" } }], code: "ENDPOINT_UNVERIFIED" },
  { actions: [{ actionName: "dismiss", actionParameter: {} }, { actionName: "dismiss", actionParameter: {} }], code: "ENDPOINT_UNVERIFIED" },
  { actions: [{ actionName: "dismiss", actionParameter: "" }], code: "RESPONSE_INVALID" },
])("event preflight refuses unavailable, ambiguous or malformed actions: $code", async ({ actions, code }) => {
  const cli = await setup((_request, response) => {
    const record = structuredClone(event);
    record.responseData[0].availableEventActions = actions;
    response.end(JSON.stringify(record));
  });
  expect((await cli.run(execute)).data.error.code).toBe(code);
  expect(cli.requests).toHaveLength(2);
  expect(existsSync(cli.log)).toBe(false);
});

test("severity variants remain visible in event show and refuse execution", async () => {
  const record = structuredClone(event);
  record.responseData[0].availableEventActions = [
    { actionName: "severityChange", actionParameter: { newSeverity: "Low" } },
    { actionName: "severityChange", actionParameter: { newSeverity: "High" } },
  ];
  const cli = await setup((_request, response) => response.end(JSON.stringify(record)));
  expect((await cli.run(["--ids", "synthetic-event-1", "--name", "severityChange"])).data.error.code).toBe("ENDPOINT_UNVERIFIED");
  // The public read interface preserves deferred choices for discovery.
  const server = await fakeGateway((request, response) => response.end(JSON.stringify(request.url === "/auth/external" ? { token: "synthetic-token-sentinel" } : record)));
  cleanups.push(server.close);
  let output = "";
  await main(["event", "show", "synthetic-event-1"], { credentials: cli.local.context, transport: { agent: server.agent }, stdout: { write: (chunk) => { output += chunk; } } });
  expect((decode(output) as any).event.availableEventActions).toEqual(record.responseData[0].availableEventActions);
  expect(existsSync(cli.log)).toBe(false);
});

test.each(["missing", "mismatch", "malformed"])("event identity preflight refuses %s", async (kind) => {
  const cli = await setup((_request, response) => {
    const record = structuredClone(event);
    if (kind === "missing") record.responseData = [];
    if (kind === "mismatch") record.responseData[0].eventId = "synthetic-other";
    if (kind === "malformed") delete record.responseData[0].entityId;
    response.end(JSON.stringify(record));
  });
  expect((await cli.run(execute)).data.error.code).toBe("RESPONSE_INVALID");
  expect(cli.requests).toHaveLength(2);
});

test.each(["unavailable", "parameterized", "scope"])("event re-read aborts before sending when %s", async (change) => {
  let reads = 0;
  const cli = await setup((_request, response) => {
    const record = structuredClone(event);
    if (++reads === 2) {
      if (change === "unavailable") record.responseData[0].availableEventActions = [];
      if (change === "parameterized") record.responseData[0].availableEventActions[0].actionParameter = { newSeverity: "High" };
      if (change === "scope") { cli.local.profile.profiles.example.writes.allowWrites = false; cli.local.save(); }
    }
    response.end(JSON.stringify(record));
  });
  expect((await cli.run(execute)).data.error.code).toBe(change === "scope" ? "CONFIG_CHANGED" : change === "parameterized" ? "ENDPOINT_UNVERIFIED" : "ACTION_UNAVAILABLE");
  expect(cli.requests).toHaveLength(3);
  expect(cli.journal()[1].outcome).toBe("NOT_SENT");
});

test("an unsafe event journal prevents the final read and send", async () => {
  const cli = await setup();
  writeFileSync(`${cli.log}.lock`, "", { mode: 0o600 });
  expect((await cli.run(execute)).data.error.code).toBe("INTENT_NOT_RECORDED");
  expect(cli.requests).toHaveLength(2);
});

test.each([401, 429, 500, 302])("event HTTP %i is never replayed or reauthenticated", async (status) => {
  const cli = await setup((request, response) => {
    if (request.url?.includes("/event/")) return response.end(JSON.stringify(event));
    response.writeHead(status, { "retry-after": "0", location: "https://example.test/redirect" });
    response.end("synthetic-secret-sentinel synthetic-token-sentinel");
  });
  const result = await cli.run(execute);
  expect(result.data.error.code).toBe("OUTCOME_UNKNOWN");
  expect(result.output).not.toMatch(/synthetic-secret-sentinel|synthetic-token-sentinel/);
  expect(cli.requests).toHaveLength(4);
  expect(cli.journal()[1].outcome).toBe("OUTCOME_UNKNOWN");
});

test.each(["disconnect", "invalid-json", "missing-task", "wrong-event", "wrong-entity", "duplicate"])("ambiguous event acknowledgement is not replayed: %s", async (kind) => {
  const cli = await setup((request, response) => {
    if (request.url?.includes("/event/")) return response.end(JSON.stringify(event));
    if (kind === "disconnect") return response.destroy();
    if (kind === "invalid-json") return response.end("{");
    const record = structuredClone(acknowledgement);
    if (kind === "missing-task") delete record.responseData[0].taskId;
    if (kind === "wrong-event") record.responseData[0].eventId = "synthetic-other";
    if (kind === "wrong-entity") record.responseData[0].entityId = "synthetic-other";
    if (kind === "duplicate") record.responseData.push(record.responseData[0]);
    response.end(JSON.stringify(record));
  });
  expect((await cli.run(execute)).data.error.code).toBe("OUTCOME_UNKNOWN");
  expect(cli.requests).toHaveLength(4);
  expect(cli.journal()[1].outcome).toBe("OUTCOME_UNKNOWN");
});

test("twenty events fit both preflight reads and one batch send", async () => {
  const ids = Array.from({ length: 20 }, (_, i) => `synthetic-event-${i}`);
  const cli = await setup((request, response, body) => {
    if (request.url?.includes("/event/")) {
      const record = structuredClone(event);
      record.responseData[0].eventId = request.url.split("/").at(-1);
      return response.end(JSON.stringify(record));
    }
    expect(body).toMatchObject({ requestData: { eventIds: ids } });
    response.end(JSON.stringify({ ...acknowledgement, responseData: ids.map((eventId) => ({ eventId, entityId: "synthetic-email-1", taskId: 123456 })) }));
  });
  expect((await cli.run(["--ids", ids.join(","), "--name", "dismiss", "--execute", "--confirm", `event.action.dismiss ${ids.join(",")}`])).data.outcome).toBe("accepted");
  expect(cli.requests).toHaveLength(42);
});

test("event transport refuses forged coordinator authorization before authentication", async () => {
  const cli = await setup();
  const store = credentialStore(cli.local.context);
  const profile = store.select(store.load().config);
  const session = gateway(profile, store.credentials(profile), store.redactor, {}, true);
  await expect(session.eventAction({ operation: "event.action.dismiss", targets: ["synthetic-event-1"], profile: profile.name, region: profile.region }, "dismiss", ["synthetic-event-1"]))
    .rejects.toMatchObject({ code: "WRITES_DISABLED" });
  expect(cli.requests).toEqual([]);
});
