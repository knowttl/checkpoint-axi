import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterEach, expect, test } from "vitest";
import { main } from "../src/cli.js";
import { credentialStore } from "../src/profiles.js";
import { gateway } from "../src/transport.js";
import { localFixture } from "./support/local-cli.js";
import { fakeGateway } from "./support/fake-gateway.js";

// Request bodies follow pp.84,86,92-95,97-99. Responses are arbitrary provisional JSON,
// never schema-derived: the guide explicitly publishes no response schema for C9.
const anomaly = { addedBy: "", requestJson: { "whitelist-option:new_country": "synthetic-country-1",
  "apply-to-past": "Yes", "anomaly-comment": "Synthetic rule", event_id: "synthetic-event-1" } };
const click = { listItemName: "https://example.com/path", listId: "synthetic-list-1", createdBy: "" };
const item = "synthetic-item-1";
const cases = [
  { kind: "anomaly", action: "create", body: anomaly, method: "POST", route: "/anomaly/exceptions" },
  { kind: "anomaly", action: "remove", body: { ruleId: item }, method: "POST", route: "/anomaly/exceptions" },
  { kind: "click-time", action: "create", body: click, method: "POST", route: "/click_time_protection/exceptions/items" },
  { kind: "click-time", action: "update", body: { ...click, listItemId: item }, method: "PUT", route: `/click_time_protection/exceptions/items/${item}` },
  { kind: "click-time", action: "remove", body: undefined, method: "POST", route: `/click_time_protection/exceptions/items/${item}` },
  { kind: "click-time", action: "remove-items", body: { listItemIds: [item, "synthetic-item-2"] }, method: "POST", route: "/click_time_protection/exceptions/items" },
];
const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); process.exitCode = 0; });

async function setup(entry = cases[3]!, handler?: Parameters<typeof fakeGateway>[0], onAuth?: (local: ReturnType<typeof localFixture>) => void) {
  const local = localFixture();
  cleanups.push(local.cleanup);
  const operation = `exception.${entry.kind}.${entry.action}`;
  local.profile.profiles.example.writes = { allowWrites: true, operations: [operation] };
  local.save();
  const input = join(local.directory, "rule.json"), log = join(local.directory, "writes.log");
  writeFileSync(input, JSON.stringify(entry.body ?? {}), { mode: 0o600 });
  local.env.CHECKPOINT_AXI_WRITE_LOG = log;
  const requests: { method: string; path: string; body: unknown }[] = [];
  const server = await fakeGateway((request, response, body) => {
    requests.push({ method: request.method!, path: request.url!, body });
    if (request.url === "/auth/external") { onAuth?.(local); return response.end(JSON.stringify({ token: "synthetic-token-sentinel" })); }
    // The mutation cannot reach even the fake gateway without durable intent.
    expect(JSON.parse(readFileSync(log, "utf8").split("\n")[0]!)).toMatchObject({ kind: "intent", operation });
    if (handler) return handler(request, response, body);
    response.end(JSON.stringify({ provisional: "synthetic acknowledgement" }));
  });
  cleanups.push(server.close);
  const run = async (args: string[]) => {
    let output = "";
    await main(args, { credentials: local.context, transport: { agent: server.agent }, stdout: { write: (chunk) => { output += chunk; } } });
    const code = process.exitCode ?? 0;
    process.exitCode = 0;
    return { code, output, data: decode(output) as Record<string, any> };
  };
  const args = ["exception", entry.action, entry.kind,
    ...(["update", "remove"].includes(entry.action) ? [item] : []),
    ...(["create", "update"].includes(entry.action) ? ["--input", input] : []),
    ...(entry.action === "remove-items" ? ["--ids", `${item},synthetic-item-2`] : [])];
  const journal = () => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { local, args, run, input, log, requests, operation, journal };
}

test.each(cases)("$kind $action previews uncertainty then sends one documented request", async (entry) => {
  const cli = await setup(entry);
  const preview = await cli.run(cli.args);
  expect(preview.code).toBe(0);
  expect(preview.data).toMatchObject({ outcome: "preview", preview: { operation: cli.operation, noop: false,
    currentState: { targetState: "unverified", responseSchema: "unverified" } } });
  expect(cli.requests).toEqual([]);
  expect(existsSync(cli.log)).toBe(false);
  const result = await cli.run([...cli.args, "--execute", "--confirm", preview.data.preview.confirm]);
  expect(result.code).toBe(0);
  expect(result.data).toMatchObject({ outcome: "accepted", responseSchema: "unverified", response: { provisional: "synthetic acknowledgement" } });
  expect(cli.requests.slice(1)).toEqual([{ method: entry.method, path: `/app/hec-api/v1.0/sectools${entry.route}`,
    body: entry.body === undefined ? undefined : { requestData: entry.body } }]);
  expect(cli.requests).toHaveLength(2);
  expect(cli.journal()).toMatchObject([{ kind: "intent", targets: preview.data.preview.targets }, { kind: "outcome", outcome: "accepted" }]);
  expect(readFileSync(cli.log, "utf8")).not.toMatch(/example.com|Synthetic rule|synthetic-token-sentinel|synthetic-secret-sentinel/);
});

test.each(cases)("$kind $action rejects missing or mismatched confirmation before auth", async (entry) => {
  const cli = await setup(entry);
  expect((await cli.run([...cli.args, "--execute"])).data.error.code).toBe("CONFIRM_REQUIRED");
  expect((await cli.run([...cli.args, "--execute", "--confirm", `${cli.operation} wrong`])).data.error.code).toBe("CONFIRM_MISMATCH");
  expect(cli.requests).toEqual([]);
  expect(existsSync(cli.log)).toBe(false);
});

test.each(["anomaly", "click-time"])("%s create confirmation binds nested payload changes", async (kind) => {
  const cli = await setup(cases.find((entry) => entry.kind === kind && entry.action === "create")!);
  const preview = await cli.run(cli.args);
  writeFileSync(cli.input, JSON.stringify(kind === "anomaly" ? { ...anomaly, requestJson: { ...anomaly.requestJson, "anomaly-comment": "Changed" } }
    : { ...click, listId: "synthetic-list-2" }));
  expect((await cli.run([...cli.args, "--execute", "--confirm", preview.data.preview.confirm])).data.error.code).toBe("CONFIRM_MISMATCH");
  expect(cli.requests).toEqual([]);
});

test.each(["read-only", "scope", "disabled"])("C9 %s gate fails before authentication", async (gate) => {
  const cli = await setup();
  if (gate === "read-only") cli.local.env.CHECKPOINT_AXI_READ_ONLY = "true";
  else { cli.local.profile.profiles.example.writes = { allowWrites: gate !== "disabled", operations: [] }; cli.local.save(); }
  expect((await cli.run(cli.args)).data.error.code).toBe(gate === "scope" ? "OPERATION_NOT_WRITABLE" : "WRITES_DISABLED");
  expect(cli.requests).toEqual([]);
});

test.each([
  ["exception", "clear", "click-time"], ["exception", "clear", "click-time", "--execute", "--confirm", "exception.click-time.clear 1"],
])("clear refuses without inventing counts or authenticating: %j", async (...args) => {
  const cli = await setup();
  cli.local.env.CHECKPOINT_AXI_CONFIG = "/missing/config.json";
  expect((await cli.run(args)).data.error.code).toBe("ENDPOINT_UNVERIFIED");
  expect(cli.requests).toEqual([]);
});

test.each([
  ["exception", "update", "anomaly", item], ["exception", "update", "click-time"],
  ["exception", "remove-items", "anomaly", "--ids", item], ["exception", "remove-items", "click-time"],
  ["exception", "remove-items", "click-time", "--ids", `${item},${item}`],
  ["exception", "remove-items", "click-time", "--ids", Array.from({ length: 21 }, (_, i) => `synthetic-item-${i}`).join(",")],
  ["exception", "remove", "click-time", "../escape"], ["exception", "remove", "anomaly", item, "--input", "/absolute/rule.json"],
])("invalid C9 command fails before config: %j", async (...args) => {
  const cli = await setup();
  cli.local.env.CHECKPOINT_AXI_CONFIG = "/missing/config.json";
  expect((await cli.run(args)).code).toBe(2);
  expect(cli.requests).toEqual([]);
});

test.each([{}, { ...click, listItemId: "wrong" }, { ...click, listItemId: item, unknown: true }, { ...click, listItemId: item, listItemName: " " }])(
  "invalid C9 private input fails before auth: %j", async (body) => {
    const cli = await setup();
    writeFileSync(cli.input, JSON.stringify(body));
    expect((await cli.run(cli.args)).code).toBe(2);
    expect(cli.requests).toEqual([]);
  });

test("C9 rejects an insecure input file", async () => {
  const cli = await setup();
  chmodSync(cli.input, 0o644);
  expect((await cli.run(cli.args)).code).not.toBe(0);
  expect(cli.requests).toEqual([]);
});

test("C9 intent failure prevents authentication and send", async () => {
  const cli = await setup();
  writeFileSync(`${cli.log}.lock`, "", { mode: 0o600 });
  expect((await cli.run([...cli.args, "--execute", "--confirm", `${cli.operation} ${item}`])).data.error.code).toBe("INTENT_NOT_RECORDED");
  expect(cli.requests).toEqual([]);
});

test.each(["read-only", "operation", "profile"])("C9 rechecks %s after authentication, before sending", async (revocation) => {
  const cli = await setup(undefined, undefined, (local) => {
    if (revocation === "read-only") local.env.CHECKPOINT_AXI_READ_ONLY = "true";
    else {
      if (revocation === "operation") local.profile.profiles.example.writes.operations = [];
      else local.profile.profiles.example.saas = "synthetic-saas";
      local.save();
    }
  });
  expect((await cli.run([...cli.args, "--execute", "--confirm", `${cli.operation} ${item}`])).data.error.code)
    .toBe(revocation === "read-only" ? "WRITES_DISABLED" : "CONFIG_CHANGED");
  expect(cli.requests).toHaveLength(1);
  expect(cli.journal()[1].outcome).toBe("NOT_SENT");
});

test.each(["401", "429", "500", "302", "disconnect", "json", "envelope", "api-error"])("C9 never retries ambiguous acknowledgement: %s", async (failure) => {
  const cli = await setup(undefined, (_request, response) => {
    if (failure === "disconnect") return response.destroy();
    if (/^\d+$/.test(failure)) { response.writeHead(Number(failure), { "retry-after": "0", location: "https://example.test/redirect" }); return response.end("synthetic-secret-sentinel"); }
    response.end(failure === "json" ? "{" : JSON.stringify({ responseEnvelope: failure === "envelope" ? null : { responseCode: 500 } }));
  });
  const result = await cli.run([...cli.args, "--execute", "--confirm", `${cli.operation} ${item}`]);
  expect(result.data.error.code).toBe("OUTCOME_UNKNOWN");
  expect(cli.requests).toHaveLength(2);
  expect(cli.journal()[1].outcome).toBe("OUTCOME_UNKNOWN");
  expect(result.output).not.toMatch(/synthetic-secret-sentinel|synthetic-token-sentinel/);
});

test.each(["json", "envelope", "empty"])("C9 preserves successful unverified acknowledgement: %s", async (shape) => {
  const cli = await setup(undefined, (_request, response) => {
    if (shape === "empty") { response.writeHead(204); return response.end(); }
    response.end(JSON.stringify(shape === "envelope" ? { responseEnvelope: { responseCode: 200 }, responseData: { arbitrary: true } }
      : { arbitrary: ["synthetic-secret-sentinel", "synthetic-token-sentinel", "x".repeat(600)] }));
  });
  const result = await cli.run([...cli.args, "--execute", "--confirm", `${cli.operation} ${item}`]);
  expect(result.data.outcome).toBe("accepted");
  expect(result.data.responseSchema).toBe("unverified");
  expect(result.output).not.toMatch(/synthetic-secret-sentinel|synthetic-token-sentinel/);
  if (shape === "empty") expect(result.data.response).toBeNull();
  if (shape === "json") expect(result.output).toContain("truncated, 600 chars total");
});

test("C9 transport rejects a forged authorization before auth", async () => {
  const cli = await setup();
  const store = credentialStore(cli.local.context), profile = store.select(store.load().config);
  const session = gateway(profile, store.credentials(profile), store.redactor, {}, true);
  await expect(session.sectoolsWrite({ operation: cli.operation, targets: [item], profile: profile.name, region: profile.region },
    "click-time", "update", [item], () => {}, { ...click, listItemId: item })).rejects.toMatchObject({ code: "WRITES_DISABLED" });
  expect(cli.requests).toEqual([]);
});
