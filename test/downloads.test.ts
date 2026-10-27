import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterEach, expect, test } from "vitest";
import { main } from "../src/cli.js";
import { DOWNLOAD_LIMIT } from "../src/transport.js";
import { fakeGateway } from "./support/fake-gateway.js";
import { localFixture } from "./support/local-cli.js";

// Synthetic binary responses follow guide pp.131-137, not the broken curl samples.
// Email/ZIP hash headers are an approved safety requirement, unverified live.
const content = Buffer.from("Synthetic attachment\0\xff", "latin1");
const sha256 = createHash("sha256").update(content).digest("hex");
const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); process.exitCode = 0; });

async function setup(handler?: Parameters<typeof fakeGateway>[0], timing = {}) {
  const f = localFixture();
  cleanups.push(f.cleanup);
  f.profile.profiles.example.downloads = { allow: true };
  f.profile.profiles.example.scope = "synthetic:scope";
  f.save();
  const calls: { path: string; scopes: unknown; authorization: unknown; requestId: unknown }[] = [];
  const fake = await fakeGateway((request, response, body) => {
    calls.push({ path: request.url!, scopes: request.headers.scopes, authorization: request.headers.authorization, requestId: request.headers["x-av-req-id"] });
    if (request.url === "/auth/external") response.end('{"token":"synthetic-download-token"}');
    else if (handler) handler(request, response, body);
    else { response.writeHead(200, { "x-av-sha256": sha256, "content-disposition": 'attachment; filename="../../unsafe"' }); response.end(content); }
  });
  cleanups.push(fake.close);
  const path = join(f.directory, "download.bin");
  const run = async (args: string[]) => {
    let output = "";
    await main(args, { credentials: f.context, transport: { agent: fake.agent, ...timing }, stdout: { write: (chunk) => { output += chunk; } } });
    return { output, code: process.exitCode ?? 0, data: decode(output) };
  };
  return { f, path, calls, run };
}

test.each([
  [["email", "download", "synthetic-email"], "/download/entity/synthetic-email?original=false", "synthetic:scope"],
  [["email", "download", "synthetic-email", "--original"], "/download/entity/synthetic-email?original=true", "synthetic:scope"],
  [["attachment", "download", "synthetic-email", "synthetic-attachment"], "/download/entity/synthetic-email/attachment/synthetic-attachment?scope=synthetic%3Ascope", undefined],
  [["attachment", "download-all", "synthetic-email", "--scope", "synthetic:override"], "/download/entity/synthetic-email/attachments?scope=synthetic%3Aoverride", undefined],
] as const)("downloads verified bytes privately with correct selectors: %j", async (args, route, scopes) => {
  const { path, calls, run } = await setup();
  const result = await run([...args, "--out", path]);
  expect(result.code).toBe(0);
  expect(result.data).toEqual({ path, size: content.length, sha256 });
  expect(readFileSync(path)).toEqual(content);
  if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(calls.map((call) => call.path)).toEqual(["/auth/external", `/app/hec-api/v1.0${route}`]);
  expect(calls[1]).toMatchObject({ scopes, authorization: "Bearer synthetic-download-token" });
  expect(new Set(calls.map((call) => call.requestId)).size).toBe(2);
  expect(result.output).not.toMatch(/Synthetic attachment|synthetic-download-token|synthetic-secret|unsafe/);
});

test("attachment scope is optional", async () => {
  const { f, path, calls, run } = await setup();
  delete f.profile.profiles.example.scope;
  f.save();
  expect((await run(["attachment", "download-all", "synthetic-email", "--out", path])).code).toBe(0);
  expect(calls[1]!.path).toBe("/app/hec-api/v1.0/download/entity/synthetic-email/attachments");
});

test.each([undefined, "invalid", "0".repeat(64)])("missing, malformed or mismatched hash removes output: %s", async (hash) => {
  const { path, run } = await setup((_request, response) => {
    response.writeHead(200, hash ? { "x-av-sha256": hash } : {}); response.end(content);
  });
  const result = await run(["email", "download", "synthetic-email", "--out", path]);
  expect(result.code).toBe(1);
  expect(result.data).toMatchObject({ error: { code: hash?.length === 64 ? "DOWNLOAD_HASH_MISMATCH" : "DOWNLOAD_HASH_INVALID" } });
  expect(existsSync(path)).toBe(false);
});

test.each([302, 403, 404, 500])("HTTP %s fails without replay, output or echoed body", async (status) => {
  const { path, calls, run } = await setup((_request, response) => {
    response.writeHead(status, { location: "https://example.com/unsafe" }); response.end("synthetic-secret-sentinel");
  });
  const result = await run(["email", "download", "synthetic-email", "--out", path]);
  expect(result.data).toMatchObject({ error: { code: "HTTP_ERROR" } });
  expect(calls).toHaveLength(2);
  expect(existsSync(path)).toBe(false);
  expect(result.output).not.toContain("synthetic-secret");
});

test("oversize streamed response aborts and removes the new file", async () => {
  const { path, run } = await setup((_request, response) => { response.writeHead(200, { "x-av-sha256": sha256 }); response.end(Buffer.alloc(DOWNLOAD_LIMIT + 1)); });
  expect((await run(["email", "download", "synthetic-email", "--out", path])).data).toMatchObject({ error: { code: "RESPONSE_TOO_LARGE" } });
  expect(existsSync(path)).toBe(false);
});

test("truncated body fails and removes output", async () => {
  const { path, run } = await setup((_request, response) => { response.writeHead(200, { "x-av-sha256": sha256, "content-length": 100 }); response.end(content); });
  expect((await run(["email", "download", "synthetic-email", "--out", path])).data).toMatchObject({ error: { code: "NETWORK_ERROR" } });
  expect(existsSync(path)).toBe(false);
});

test("download opt-in is required before authentication or file creation", async () => {
  const { f, path, calls, run } = await setup();
  f.profile.profiles.example.downloads.allow = false; f.save();
  expect((await run(["email", "download", "synthetic-email", "--out", path])).data).toMatchObject({ error: { code: "DOWNLOADS_DISABLED" } });
  expect(calls).toHaveLength(0);
  expect(existsSync(path)).toBe(false);
});

test.each([false, true])("existing output or symlink cannot be overwritten: %s", async (symlink) => {
  const { f, path, calls, run } = await setup();
  const target = join(f.directory, "existing.bin");
  writeFileSync(target, "keep");
  if (symlink) symlinkSync(target, path); else writeFileSync(path, "keep");
  expect((await run(["email", "download", "synthetic-email", "--out", path])).data).toMatchObject({ error: { code: "DOWNLOAD_OUTPUT_INVALID" } });
  expect(readFileSync(path, "utf8")).toBe("keep");
  expect(calls).toHaveLength(0);
});

test.each([
  { args: ["email", "download", "../unsafe"] }, { args: ["attachment", "download", "synthetic-email"] },
  { args: ["email", "download", "synthetic-email", "--out", "-"] },
  { args: ["email", "download", "synthetic-email", "--scope", "synthetic"] },
  { args: ["attachment", "download-all", "synthetic-email", "--original"] },
])("invalid selectors fail before API access: $args", async ({ args }) => {
  const { path, calls, run } = await setup();
  const result = await run([...args, ...(args.includes("--out") ? [] : ["--out", path])]);
  expect(result.code).toBe(2);
  expect(calls).toHaveLength(0);
  expect(existsSync(path)).toBe(false);
});

test("email scope is required before authentication", async () => {
  const { f, path, calls, run } = await setup();
  delete f.profile.profiles.example.scope; f.save();
  expect((await run(["email", "download", "synthetic-email", "--out", path])).data).toMatchObject({ error: { code: "DOWNLOAD_SCOPE_REQUIRED" } });
  expect(calls).toHaveLength(0);
  expect(existsSync(path)).toBe(false);
});

test("download rate retries honor Retry-After and stop after two retries", async () => {
  const waits: number[] = [];
  let clock = 0;
  const { path, calls, run } = await setup((_request, response) => { response.writeHead(429, { "retry-after": "2" }); response.end(); },
    { now: () => clock, wait: async (milliseconds: number) => { waits.push(milliseconds); clock += milliseconds; } });
  expect((await run(["email", "download", "synthetic-email", "--out", path])).data).toMatchObject({ error: { code: "RATE_LIMITED" } });
  expect(waits).toEqual([2000, 2000]);
  expect(calls).toHaveLength(4);
  expect(existsSync(path)).toBe(false);
});

test("download permits only one token re-exchange", async () => {
  const { path, calls, run } = await setup((_request, response) => { response.writeHead(401); response.end(); });
  expect((await run(["email", "download", "synthetic-email", "--out", path])).data).toMatchObject({ error: { code: "AUTH_FAILED" } });
  expect(calls.map((call) => call.path).filter((path) => path === "/auth/external")).toHaveLength(2);
  expect(calls).toHaveLength(4);
  expect(existsSync(path)).toBe(false);
});
