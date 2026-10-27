import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterEach, expect, test } from "vitest";
import { main } from "../src/cli.js";
import { credentialStore } from "../src/profiles.js";
import { gateway } from "../src/transport.js";
import { localFixture } from "./support/local-cli.js";
import { fakeGateway } from "./support/fake-gateway.js";

// Synthetic request fixtures follow guide pp.103-106,113-117,123-127.
// No parameter tables or response schemas are published; acknowledgements are arbitrary JSON.
const families = [
  { kind: "malware", route: "checkpoint2", type: "hash" },
  { kind: "url", route: "avanan_url", type: "allow-url" },
  { kind: "dlp", route: "avanan_dlp", type: "text_content" },
];
const create = { comment: "Synthetic rule", entity_type: "user", entity_id: "synthetic-user-1",
  file_name: "synthetic.json", created_by_email: "sender@example.com", is_exclusive: true };
const payload = { condition: "with_link" };
const cases = families.flatMap((family) => [
  { ...family, action: "create", specific: false, method: "POST" },
  { ...family, action: "create", specific: true, method: "POST" },
  { ...family, action: "update", specific: false, method: "PUT" },
]);
const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); process.exitCode = 0; });

async function setup(entry = cases[0]!, handler?: Parameters<typeof fakeGateway>[0], onAuth?: (local: ReturnType<typeof localFixture>) => void) {
  const local = localFixture();
  cleanups.push(local.cleanup);
  const operation = `exception.${entry.kind}.${entry.action}`;
  local.profile.profiles.example.writes = { allowWrites: true, operations: [operation] };
  local.save();
  const input = join(local.directory, "rule.json"), log = join(local.directory, "writes.log");
  const body = { exception_type: entry.type, exception_str: "synthetic-value",
    ...(entry.action === "create" ? create : { comment: "Synthetic replacement" }),
    ...(entry.action === "update" || entry.kind === "malware" ? { exception_payload: payload } : {}) };
  writeFileSync(input, JSON.stringify(body), { mode: 0o600 });
  local.env.CHECKPOINT_AXI_WRITE_LOG = log;
  const requests: { method: string; path: string; body: unknown }[] = [];
  const server = await fakeGateway((request, response, data) => {
    requests.push({ method: request.method!, path: request.url!, body: data });
    if (request.url === "/auth/external") { onAuth?.(local); return response.end(JSON.stringify({ token: "synthetic-token-sentinel" })); }
    expect(JSON.parse(readFileSync(log, "utf8").split("\n")[0]!)).toMatchObject({ kind: "intent", operation });
    if (handler) return handler(request, response, data);
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
  const args = ["exception", entry.action, entry.kind, "--input", input, ...(entry.specific ? ["--specific"] : [])];
  const journal = () => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { local, args, run, input, log, body, requests, operation, journal };
}

test.each(cases)("$kind $action specific=$specific previews then sends once after durable intent", async (entry) => {
  const cli = await setup(entry);
  const preview = await cli.run(cli.args);
  expect(preview.code).toBe(0);
  expect(preview.data.preview).toMatchObject({ operation: cli.operation, noop: false, currentState: { targetState: "unverified", requested: cli.body } });
  expect(preview.data.preview.confirm).toMatch(new RegExp(`^${cli.operation} sha256:[a-f0-9]{64}$`));
  expect(cli.requests).toEqual([]);
  expect(existsSync(cli.log)).toBe(false);
  const result = await cli.run([...cli.args, "--execute", "--confirm", preview.data.preview.confirm]);
  expect(result.code).toBe(0);
  expect(result.data).toMatchObject({ outcome: "accepted", responseSchema: "unverified" });
  expect(cli.requests).toHaveLength(2);
  expect(cli.requests[1]).toEqual({ method: entry.method,
    path: `/app/hec-api/v1.0/sectool-exceptions/${entry.route}${entry.specific ? "/exceptions" : ""}`, body: { requestData: cli.body } });
  expect(cli.journal().map((row) => row.kind)).toEqual(["intent", "outcome"]);
  expect(readFileSync(cli.log, "utf8")).not.toMatch(/synthetic-value|Synthetic rule|synthetic-secret-sentinel|synthetic-token-sentinel/);
});

test.each(families.flatMap((family) => ["remove", "clear"].map((action) => ({ ...family, action }))))(
  "$kind $action refuses the ambiguous delete before configuration, auth or journaling", async (entry) => {
    const cli = await setup();
    cli.local.env.CHECKPOINT_AXI_CONFIG = "/does-not-exist/config.json";
    const result = await cli.run(["exception", entry.action, entry.kind, ...(entry.action === "remove" ? ["synthetic-value"] : []), "--execute", "--confirm", "anything"]);
    expect(result.data.error.code).toBe("ENDPOINT_UNVERIFIED");
    expect(cli.requests).toEqual([]);
    expect(existsSync(cli.log)).toBe(false);
  });

test.each([
  { name: "unknown type", patch: { exception_type: "allow-url" } },
  { name: "blank value", patch: { exception_str: " " } },
  { name: "unknown field", patch: { unexpected: true } },
  { name: "string boolean", patch: { is_exclusive: "true" } },
  { name: "unknown nested field", patch: { exception_payload: { condition: "with_link", unexpected: true } } },
])("rejects $name before auth", async ({ patch }) => {
  const cli = await setup();
  writeFileSync(cli.input, JSON.stringify({ ...cli.body, ...patch }));
  expect((await cli.run(cli.args)).data.error.code).toBe("VALIDATION_ERROR");
  expect(cli.requests).toEqual([]);
});

test.each(["scope", "readonly", "permissions", "positional-id", "dry-run", "journal"])("fails closed on %s", async (gate) => {
  const cli = await setup();
  const preview = await cli.run(cli.args);
  let args = [...cli.args, "--execute", "--confirm", preview.data.preview.confirm];
  if (gate === "scope") { cli.local.profile.profiles.example.writes.operations = ["exception.url.create"]; cli.local.save(); }
  if (gate === "readonly") cli.local.env.CHECKPOINT_AXI_READ_ONLY = "1";
  if (gate === "permissions") chmodSync(cli.input, 0o644);
  if (gate === "positional-id") args = ["exception", "update", "malware", "synthetic-id", "--input", cli.input];
  if (gate === "dry-run") args.push("--dry-run");
  if (gate === "journal") writeFileSync(`${cli.log}.lock`, "", { mode: 0o600 });
  expect((await cli.run(args)).code).not.toBe(0);
  expect(cli.requests).toEqual([]);
});

test.each(["missing", "payload", "route"])("confirmation binds %s", async (change) => {
  const cli = await setup();
  const preview = await cli.run(cli.args);
  if (change === "payload") writeFileSync(cli.input, JSON.stringify({ ...cli.body, comment: "Changed" }));
  const args = [...cli.args, "--execute", ...(change === "route" ? ["--specific"] : []),
    ...(change === "missing" ? [] : ["--confirm", preview.data.preview.confirm])];
  expect((await cli.run(args)).data.error.code).toBe(change === "missing" ? "CONFIRM_REQUIRED" : "CONFIRM_MISMATCH");
  expect(cli.requests).toEqual([]);
  expect(existsSync(cli.log)).toBe(false);
});

test("scope revocation during authentication prevents the mutation", async () => {
  const cli = await setup(undefined, undefined, (local) => { local.env.CHECKPOINT_AXI_READ_ONLY = "1"; });
  const preview = await cli.run(cli.args);
  expect((await cli.run([...cli.args, "--execute", "--confirm", preview.data.preview.confirm])).data.error.code).toBe("WRITES_DISABLED");
  expect(cli.requests).toHaveLength(1);
  expect(cli.journal()[1].outcome).toBe("NOT_SENT");
});

test.each([401, 429, 302, 500, "disconnect", "json", "envelope"] as const)("ambiguous %s acknowledgement never retries", async (status) => {
  const cli = await setup(undefined, (request, response) => {
    if (status === "disconnect") return request.socket.destroy();
    if (status === "json") return response.end("invalid");
    if (status === "envelope") return response.end(JSON.stringify({ responseEnvelope: { responseCode: 500 } }));
    response.writeHead(status);
    response.end("synthetic-secret-sentinel");
  });
  const preview = await cli.run(cli.args);
  const result = await cli.run([...cli.args, "--execute", "--confirm", preview.data.preview.confirm]);
  expect(result.data.error.code).toBe("OUTCOME_UNKNOWN");
  expect(cli.requests).toHaveLength(2);
  expect(cli.journal()[1].outcome).toBe("OUTCOME_UNKNOWN");
  expect(result.output).not.toContain("synthetic-secret-sentinel");
});

test.each(["json", "empty"])("preserves %s acknowledgement with redaction and reconciliation guidance", async (shape) => {
  const cli = await setup(undefined, (_request, response) => {
    if (shape === "empty") { response.writeHead(204); return response.end(); }
    response.end(JSON.stringify({ secret: "synthetic-secret-sentinel", token: "synthetic-token-sentinel", detail: "x".repeat(600) }));
  });
  const preview = await cli.run(cli.args);
  const result = await cli.run([...cli.args, "--execute", "--confirm", preview.data.preview.confirm]);
  expect(result.data.outcome).toBe("accepted");
  expect(result.output).not.toMatch(/synthetic-secret-sentinel|synthetic-token-sentinel/);
  expect(result.data.help).toEqual(["Run checkpoint-axi exception list malware --type hash to inspect unverified JSON and reconcile; never replay automatically"]);
  if (shape === "empty") expect(result.data.response).toBeNull();
  if (shape === "json") expect(result.output).toContain("truncated, 600 chars total");
});

test("transport refuses forged create authorization and every unverified delete", async () => {
  const cli = await setup();
  const store = credentialStore(cli.local.context), profile = store.select(store.load().config);
  const session = gateway(profile, store.credentials(profile), store.redactor, {}, true);
  const authorization = { operation: cli.operation, targets: ["synthetic-value"], profile: profile.name, region: profile.region };
  await expect(session.sectoolsWrite(authorization, "malware", "create", authorization.targets, () => {}, cli.body)).rejects.toMatchObject({ code: "WRITES_DISABLED" });
  await expect(session.sectoolsWrite(authorization, "url", "remove", authorization.targets, () => {})).rejects.toMatchObject({ code: "ENDPOINT_UNVERIFIED" });
  expect(cli.requests).toEqual([]);
});
