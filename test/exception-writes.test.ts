import { chmodSync, existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { decode } from "@toon-format/toon";
import { main } from "../src/cli.js";
import { credentialStore } from "../src/profiles.js";
import { gateway } from "../src/transport.js";
import { localFixture } from "./support/local-cli.js";
import { fakeGateway } from "./support/fake-gateway.js";

const existing = JSON.parse(readFileSync(new URL("./fixtures/exception-page.json", import.meta.url), "utf8"));
const rule = JSON.parse(readFileSync(new URL("./fixtures/exception-write.json", import.meta.url), "utf8"));
const ack = JSON.parse(readFileSync(new URL("./fixtures/exception-write-page.json", import.meta.url), "utf8"));
const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); process.exitCode = 0; });
const routes = { "phishing-allow": "whitelist", "phishing-block": "blacklist", "spam-allow": "spam_whitelist" };
const cases = Object.entries(routes).flatMap(([kind, route]) => ["create", "update", "remove"].map((action) => ({ kind, route, action })));

async function setup(kind = "spam-allow", action = "update", handler?: Parameters<typeof fakeGateway>[0], onWait?: (count: number) => void) {
  const local = localFixture();
  cleanups.push(local.cleanup);
  const operation = `exception.${kind}.${action}`;
  local.profile.profiles.example.writes = { allowWrites: true, operations: [operation] };
  local.save();
  const input = join(local.directory, "rule.json"), log = join(local.directory, "writes.log");
  const desired = { ...rule, comment: "Synthetic revised rule" };
  writeFileSync(input, JSON.stringify(desired), { mode: 0o600 });
  local.env.CHECKPOINT_AXI_WRITE_LOG = log;
  const requests: { path: string; method: string; body: unknown; time: number }[] = [];
  const waits: number[] = [];
  let now = 0;
  const server = await fakeGateway((request, response, body) => {
    requests.push({ path: request.url!, method: request.method!, body, time: now });
    if (request.url === "/auth/external") return response.end(JSON.stringify({ token: "synthetic-token-sentinel" }));
    if (handler) return handler(request, response, body);
    response.end(JSON.stringify(request.method === "GET" ? action === "create" ? { ...existing, responseData: [], responseEnvelope: { responseCode: 200, totalRecordsNumber: 0 } } : existing : ack));
  });
  cleanups.push(server.close);
  const run = async (args: string[]) => {
    let output = "";
    await main(args, { credentials: local.context, transport: { agent: server.agent, now: () => now, wait: async (ms) => { waits.push(ms); now += ms; onWait?.(waits.length); } },
      stdout: { write: (chunk) => { output += chunk; } } });
    const code = process.exitCode ?? 0;
    process.exitCode = 0;
    return { code, output, data: decode(output) as Record<string, any> };
  };
  const args = ["exception", action, kind, ...(action === "create" ? [] : ["synthetic-exception-1"]), ...(action === "remove" ? [] : ["--input", input])];
  const journal = () => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { local, input, log, requests, waits, args, run, journal, desired, operation };
}

test.each(cases)("$kind $action previews, journals and sends one documented request", async ({ kind, route, action }) => {
  const cli = await setup(kind, action);
  const preview = await cli.run(cli.args);
  expect(preview.data).toMatchObject({ outcome: "preview", preview: { operation: cli.operation, noop: false, effect: "disruptive" } });
  expect(existsSync(cli.log)).toBe(false);
  if (action === "create") expect(preview.data.preview.confirm).toMatch(new RegExp(`^${cli.operation} sha256:[a-f0-9]{64}$`));
  const result = await cli.run([...cli.args, "--execute", "--confirm", preview.data.preview.confirm]);
  expect(result.code).toBe(0);
  expect(result.data).toMatchObject({ outcome: "accepted", auditId: expect.any(String) });
  const sent = cli.requests.filter((request) => request.path !== "/auth/external" && request.method !== "GET");
  expect(sent).toEqual([{ method: action === "update" ? "PUT" : "POST",
    path: `/app/hec-api/v1.0/exceptions/${route}${action === "create" ? "" : action === "remove" ? "/delete/synthetic-exception-1" : "/synthetic-exception-1"}`,
    body: action === "remove" ? undefined : { requestData: cli.desired }, time: kind.startsWith("phishing") ? 2000 : 200 }]);
  expect(cli.journal()).toMatchObject([{ kind: "intent", operation: cli.operation, auditId: result.data.auditId }, { kind: "outcome", outcome: "accepted", auditId: result.data.auditId }]);
  expect(readFileSync(cli.log, "utf8")).not.toMatch(/sender@example.com|Synthetic revised rule|synthetic-secret-sentinel|synthetic-token-sentinel/);
});

test.each([
  ["exception", "create", "anomaly"], ["exception", "create", "spam-allow"],
  ["exception", "create", "spam-allow", "--input", "relative.json"],
  ["exception", "create", "spam-allow", "unexpected"], ["exception", "remove", "spam-allow", "../escape"],
  ["exception", "update", "spam-allow"], ["exception", "remove", "spam-allow", "a,b"],
  ["exception", "remove", "spam-allow", "a", "--unknown"],
])("invalid exception input fails before configuration or authentication: %j", async (...args) => {
  const cli = await setup();
  cli.local.env.CHECKPOINT_AXI_CONFIG = "/missing/config.json";
  expect((await cli.run(args)).code).toBe(2);
  expect(cli.requests).toEqual([]);
});

test.each([{}, { comment: "only metadata" }, { senderEmail: "sender@example.com", ignoringSpfCheck: "true" },
  { senderEmail: "sender@example.com", unknown: true }, { senderEmail: "sender@example.com", entityId: "wrong-id" }])("invalid request fields fail before authentication: %j", async (value) => {
  const cli = await setup();
  writeFileSync(cli.input, JSON.stringify(value));
  expect((await cli.run(cli.args)).code).toBe(2);
  expect(cli.requests).toEqual([]);
});

test.each(["permissions", "symlink", "invalid-json"])("unsafe input file fails before authentication: %s", async (kind) => {
  const cli = await setup();
  if (kind === "permissions") chmodSync(cli.input, 0o644);
  if (kind === "invalid-json") writeFileSync(cli.input, "{ synthetic-secret-sentinel");
  if (kind === "symlink") { symlinkSync(cli.input, `${cli.input}.link`); cli.args[cli.args.length - 1] = `${cli.input}.link`; }
  const result = await cli.run(cli.args);
  expect(result.code).not.toBe(0);
  expect(result.output).not.toContain("synthetic-secret-sentinel");
  expect(cli.requests).toEqual([]);
});

test.each(["read-only", "scope"])("exception %s gate fails before authentication", async (kind) => {
  const cli = await setup();
  if (kind === "read-only") cli.local.env.CHECKPOINT_AXI_READ_ONLY = "true";
  else { cli.local.profile.profiles.example.writes.operations = ["exception.phishing-allow.update"]; cli.local.save(); }
  expect((await cli.run(cli.args)).data.error.code).toBe(kind === "read-only" ? "WRITES_DISABLED" : "OPERATION_NOT_WRITABLE");
  expect(cli.requests).toEqual([]);
});

test.each([undefined, "exception.spam-allow.remove synthetic-exception-1", "exception.spam-allow.update other"])("exception execution requires exact confirmation: %s", async (confirmation) => {
  const cli = await setup();
  const result = await cli.run([...cli.args, "--execute", ...(confirmation ? ["--confirm", confirmation] : [])]);
  expect(result.data.error.code).toBe(confirmation ? "CONFIRM_MISMATCH" : "CONFIRM_REQUIRED");
  expect(cli.requests).toHaveLength(2);
  expect(existsSync(cli.log)).toBe(false);
});

test.each(["create", "update", "remove"])("exception %s detects no-op without journal or confirmation", async (action) => {
  const cli = await setup("spam-allow", action, (_request, response) => response.end(JSON.stringify(action === "remove"
    ? { ...existing, responseData: [], responseEnvelope: { responseCode: 200, totalRecordsNumber: 0 } } : existing)));
  writeFileSync(cli.input, JSON.stringify(rule));
  expect((await cli.run([...cli.args, "--execute"])).data.outcome).toBe("noop");
  expect(cli.requests).toHaveLength(2);
  expect(existsSync(cli.log)).toBe(false);
});

test.each(["identity", "incomplete", "malformed", "duplicate"])("exception preflight refuses %s state", async (change) => {
  const cli = await setup("spam-allow", "update", (_request, response) => {
    const page = structuredClone(existing);
    if (change === "identity") page.responseData[0].entityId = "wrong-id";
    if (change === "incomplete") page.responseEnvelope.scrollId = "synthetic-scroll";
    if (change === "malformed") page.responseData[0].ignoringSpfCheck = "false";
    if (change === "duplicate") page.responseData.push(page.responseData[0]);
    response.end(JSON.stringify(page));
  });
  expect((await cli.run(cli.args)).data.error.code).toBe("RESPONSE_INVALID");
  expect(cli.requests).toHaveLength(2);
});

test.each(Object.keys(routes).flatMap((kind) => ["create", "update"].map((action) => ({ kind, action }))))(
  "$kind $action recognizes documented empty optional fields as a no-op", async ({ kind, action }) => {
    const cli = await setup(kind, action, (_request, response) => {
      const page = structuredClone(existing);
      Object.assign(page.responseData[0], { actionNeeded: "", senderName: null, senderNameMatching: "", recipientMatching: "" });
      response.end(JSON.stringify(page));
    });
    writeFileSync(cli.input, JSON.stringify({ ...rule, senderDomainMatching: "" }));
    expect((await cli.run([...cli.args, "--execute"])).data.outcome).toBe("noop");
    expect(cli.requests).toHaveLength(2);
    expect(existsSync(cli.log)).toBe(false);
  });

test.each([{ actionNeeded: "quarantine" }, { ignoringSpfCheck: true }, { senderName: " " }])(
  "exception comparison preserves meaningful differences: %j", async (difference) => {
    const cli = await setup();
    writeFileSync(cli.input, JSON.stringify({ ...rule, ...difference }));
    expect((await cli.run(cli.args)).data.preview.noop).toBe(false);
  });

test.each(cases.flatMap((entry) => ["allowWrites", "operation", "read-only"].map((revocation) => ({ ...entry, revocation }))))(
  "$kind $action refuses $revocation revocation during send pacing", async ({ kind, action, revocation }) => {
    const cli = await setup(kind, action, undefined, (count) => {
      if (count !== 2) return;
      if (revocation === "read-only") cli.local.env.CHECKPOINT_AXI_READ_ONLY = "true";
      else {
        if (revocation === "allowWrites") cli.local.profile.profiles.example.writes.allowWrites = false;
        else cli.local.profile.profiles.example.writes.operations = [];
        cli.local.save();
      }
    });
    const preview = await cli.run(cli.args);
    const result = await cli.run([...cli.args, "--execute", "--confirm", preview.data.preview.confirm]);
    expect(result.data.error.code).toBe(revocation === "read-only" ? "WRITES_DISABLED" : "CONFIG_CHANGED");
    expect(cli.requests.filter((request) => request.path !== "/auth/external").map((request) => request.method)).toEqual(["GET", "GET", "GET"]);
    expect(cli.journal()).toMatchObject([{ kind: "intent" }, { kind: "outcome", outcome: "NOT_SENT" }]);
  });

test("intent is durable before final read; revoked scope aborts before send", async () => {
  let reads = 0;
  const cli = await setup("spam-allow", "update", (_request, response) => {
    if (++reads === 2) {
      expect(cli.journal()[0]).toMatchObject({ kind: "intent", operation: cli.operation });
      cli.local.profile.profiles.example.writes.allowWrites = false;
      cli.local.save();
    }
    response.end(JSON.stringify(existing));
  });
  expect((await cli.run([...cli.args, "--execute", "--confirm", "exception.spam-allow.update synthetic-exception-1"])).data.error.code).toBe("CONFIG_CHANGED");
  expect(cli.requests).toHaveLength(3);
  expect(cli.journal()[1].outcome).toBe("NOT_SENT");
});

test("unsafe exception journal blocks the final read and send", async () => {
  const cli = await setup();
  writeFileSync(`${cli.log}.lock`, "", { mode: 0o600 });
  expect((await cli.run([...cli.args, "--execute", "--confirm", "exception.spam-allow.update synthetic-exception-1"])).data.error.code).toBe("INTENT_NOT_RECORDED");
  expect(cli.requests).toHaveLength(2);
});

test.each(["401", "429", "500", "302", "disconnect", "json", "envelope", "api-error"])("ambiguous exception acknowledgement never retries: %s", async (failure) => {
  const cli = await setup("spam-allow", "update", (request, response) => {
    if (request.method === "GET") return response.end(JSON.stringify(existing));
    if (failure === "disconnect") return response.destroy();
    if (/^\d+$/.test(failure)) { response.writeHead(Number(failure), { "retry-after": "0", location: "https://example.test/redirect" }); return response.end("synthetic-secret-sentinel"); }
    response.end(failure === "json" ? "{" : JSON.stringify(failure === "envelope" ? {} : { responseEnvelope: { responseCode: 500 } }));
  });
  const result = await cli.run([...cli.args, "--execute", "--confirm", "exception.spam-allow.update synthetic-exception-1"]);
  expect(result.data.error.code).toBe("OUTCOME_UNKNOWN");
  expect(result.output).not.toMatch(/synthetic-secret-sentinel|synthetic-token-sentinel/);
  expect(cli.requests).toHaveLength(4);
  expect(cli.journal()[1].outcome).toBe("OUTCOME_UNKNOWN");
});

test("documented remove envelope code 204 is accepted", async () => {
  const cli = await setup("spam-allow", "remove", (request, response) => response.end(JSON.stringify(request.method === "GET" ? existing : { responseEnvelope: { responseCode: 204 } })));
  expect((await cli.run([...cli.args, "--execute", "--confirm", "exception.spam-allow.remove synthetic-exception-1"])).data.outcome).toBe("accepted");
});

test("exception transport refuses forged coordinator authorization before authentication", async () => {
  const cli = await setup();
  const store = credentialStore(cli.local.context), profile = store.select(store.load().config);
  const session = gateway(profile, store.credentials(profile), store.redactor, {}, true);
  await expect(session.exceptionWrite({ operation: cli.operation, targets: ["synthetic-exception-1"], profile: profile.name, region: profile.region }, "spam-allow", "update", "synthetic-exception-1", () => {}, rule))
    .rejects.toMatchObject({ code: "WRITES_DISABLED" });
  expect(cli.requests).toEqual([]);
});
