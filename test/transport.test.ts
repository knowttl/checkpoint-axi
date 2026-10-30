import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { gateway, decodePage, READ_LIMITS } from "../src/transport.js";
import { credentialStore } from "../src/profiles.js";
import { main } from "../src/cli.js";
import { decode } from "@toon-format/toon";
import { fakeGateway } from "./support/fake-gateway.js";
import { localFixture } from "./support/local-cli.js";

const page = JSON.parse(readFileSync(new URL("./fixtures/search-page.json", import.meta.url), "utf8"));
const cleanups: (() => unknown | Promise<unknown>)[] = [];
test.each([
  { body: "<html>private-content-sentinel</html>", contentType: "text/html; charset=utf-8", type: "undefined" },
  { body: '{"responseData":"private-content-sentinel"}', contentType: "application/json", type: "object" },
])("CLI reports safe response diagnostics for $contentType", async ({ body, contentType, type }) => {
  const { f, transport } = await setup((request, response) => {
    if (request.url === "/auth/external") response.end('{"token":"synthetic-token"}');
    else { response.writeHead(200, { "content-type": contentType }); response.end(body); }
  });
  let output = "";
  await main(["email", "search"], { credentials: f.context, transport, stdout: { write: (chunk) => { output += chunk; } } });
  expect(process.exitCode).toBe(1);
  expect(decode(output)).toMatchObject({ error: { code: "RESPONSE_INVALID", status: 200, contentType: contentType.split(";")[0], shape: expect.arrayContaining([{ path: "$", type }]) } });
  expect(output).not.toMatch(/private-content-sentinel|synthetic-token|synthetic-secret|<html>/);
});
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); process.exitCode = 0; });
async function setup(handler: Parameters<typeof fakeGateway>[0], timing: { now?: () => number; wait?: (milliseconds: number) => Promise<unknown> } = {}, trusted = true) {
  const f = localFixture();
  cleanups.push(f.cleanup);
  const fake = await fakeGateway(handler, trusted);
  cleanups.push(fake.close);
  const store = credentialStore(f.context);
  const profile = store.select(store.load().config);
  const transport = { agent: fake.agent, ...timing };
  return { f, store, transport, api: gateway(profile, store.credentials(profile), store.redactor, transport) };
}

test("doctor authenticates once and performs one search with fresh UUIDs and selected SaaS", async () => {
  const calls: { path: string; auth: string | undefined; id: string | string[] | undefined; body: unknown }[] = [];
  const { f, transport } = await setup((request, response, body) => {
    calls.push({ path: request.url!, auth: request.headers.authorization, id: request.headers["x-av-req-id"], body });
    response.end(JSON.stringify(request.url === "/auth/external" ? { data: { token: "synthetic-token" } } : page));
  });
  let output = "";
  await main(["doctor", "--saas", "synthetic_saas"], { credentials: f.context, transport, stdout: { write: (chunk) => { output += chunk; } } });
  expect(decode(output)).toMatchObject({ region: "eu", saas: "synthetic_saas", pass: true, checks: [{ check: "auth", pass: true }, { check: "read", pass: true }] });
  expect(calls.map((call) => call.path)).toEqual(["/auth/external", "/app/hec-api/v1.0/search/query"]);
  expect(calls[0]!.body).toEqual({ clientId: "synthetic-client", accessKey: "synthetic-secret-sentinel" });
  expect(calls[1]!.auth).toBe("Bearer synthetic-token");
  expect(calls[1]!.body).toMatchObject({ requestData: { entityFilter: { saas: "synthetic_saas" } } });
  const filter = (calls[1]!.body as { requestData: { entityFilter: { startDate: string; endDate: string } } }).requestData.entityFilter;
  expect(Date.parse(filter.endDate) - Date.parse(filter.startDate)).toBe(86_400_000);
  expect(new Set(calls.map((call) => call.id)).size).toBe(2);
  expect(calls[0]!.id).toMatch(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
  expect(output).not.toMatch(/synthetic-token|synthetic-secret|synthetic-client|responseData/);
});

test("401 permits exactly one token re-exchange per run", async () => {
  let exchanges = 0, reads = 0;
  const { api } = await setup((request, response) => {
    if (request.url === "/auth/external") { exchanges++; response.end(JSON.stringify({ token: `synthetic-token-${exchanges}` })); }
    else { reads++; response.writeHead(401); response.end("synthetic-secret-sentinel"); }
  });
  await expect(api.read({ path: "/search/query", body: { entityFilter: { saas: "synthetic", startDate: "2026-01-01T00:00:00Z", endDate: "2026-01-02T00:00:00Z" } } })).rejects.toMatchObject({ code: "AUTH_FAILED" });
  expect({ exchanges, reads }).toEqual({ exchanges: 2, reads: 2 });
});

test.each([
  { check: "auth", body: "<html>private-content-sentinel</html>", contentType: "text/html", type: "undefined" },
  { check: "read", body: "<html>private-content-sentinel</html>", contentType: "text/html", type: "undefined" },
  { check: "read", body: '{"responseData":"private-content-sentinel"}', contentType: "application/json", type: "object" },
])("doctor preserves $check response diagnostics for $contentType", async ({ check, body, contentType, type }) => {
  const { f, transport } = await setup((request, response) => {
    if (check === "read" && request.url === "/auth/external") return response.end('{"token":"synthetic-token"}');
    response.writeHead(200, { "content-type": contentType });
    response.end(body);
  });
  let output = "";
  await main(["doctor"], { credentials: f.context, transport, stdout: { write: (chunk) => { output += chunk; } } });
  expect(process.exitCode).toBe(1);
  expect(decode(output)).toMatchObject({ pass: false, checks: expect.arrayContaining([
    expect.objectContaining({ check, pass: false, code: "RESPONSE_INVALID", status: 200, contentType,
      shape: expect.arrayContaining([{ path: "$", type }]) }),
  ]) });
  expect(output).not.toMatch(/private-content-sentinel|synthetic-token|synthetic-secret|<html>/);
});

test.each([{}, { token: "one", access_token: "two" }, { token: "invalid\ntoken" }, { token: "valid", accessToken: "" }])("doctor reports unverified auth shape without echoing it: %j", async (shape) => {
  let requests = 0;
  const { f, transport } = await setup((_request, response) => { requests++; response.end(JSON.stringify(shape)); });
  let output = "";
  await main(["doctor"], { credentials: f.context, transport, stdout: { write: (chunk) => { output += chunk; } } });
  expect(process.exitCode).toBe(1);
  expect(decode(output)).toMatchObject({ pass: false, checks: [{ check: "auth", pass: false, code: "AUTH_SHAPE_UNVERIFIED" }, { check: "read", pass: false, code: "AUTH_NOT_PASSED" }] });
  expect(requests).toBe(1);
});

test.each([["2", 2_000], ["Thu, 01 Jan 2026 00:00:03 GMT", 3_000]])("reads honor Retry-After and stop after two retries: %s", async (header, expected) => {
  let clock = Date.parse("2026-01-01T00:00:00Z");
  const waits: number[] = [];
  let reads = 0;
  const { api } = await setup((request, response) => {
    if (request.url === "/auth/external") response.end('{"access_token":"synthetic-token"}');
    else { reads++; response.writeHead(429, { "retry-after": header }); response.end(); }
  }, { now: () => clock, wait: async (milliseconds) => { waits.push(milliseconds); clock += milliseconds; } });
  await expect(api.read({ path: "/exceptions/spam_whitelist" })).rejects.toMatchObject({ code: "RATE_LIMITED" });
  expect(reads).toBe(3);
  expect(waits[0]).toBe(expected);
});

test.each([["/exceptions/whitelist", 1_000], ["/exceptions/blacklist/synthetic-id", 1_000],
  ["/exceptions/spam_whitelist", 100], ["/sectools/anomaly/exceptions", 100],
  ["/sectools/click_time_protection/exceptions/items/synthetic-id", 100],
  ["/sectool-exceptions/checkpoint2/exceptions/hash", 100],
  ["/sectool-exceptions/avanan_url/exceptions/allow-url", 100],
  ["/sectool-exceptions/avanan_dlp/exceptions/hash/synthetic-value", 100]] as const)("exception route spacers apply across reads: %s", async (path, expected) => {
  let clock = 0;
  const waits: number[] = [];
  const { api } = await setup((request, response) => response.end(JSON.stringify(request.url === "/auth/external" ? { token: "synthetic-token" } : page)),
    { now: () => clock, wait: async (milliseconds) => { waits.push(milliseconds); clock += milliseconds; } });
  await api.read({ path });
  await api.read({ path });
  expect(waits).toEqual([expected]);
});

test.each([[302, "HTTP_ERROR"], [403, "HTTP_ERROR"], [500, "HTTP_ERROR"]])("HTTP %s is never followed or replayed", async (status, code) => {
  let reads = 0;
  const { api } = await setup((request, response) => {
    if (request.url === "/auth/external") response.end('{"token":"synthetic-token"}');
    else { reads++; response.writeHead(status, { location: "https://example.test/unsafe" }); response.end(); }
  });
  await expect(api.read({ path: "/exceptions/whitelist" })).rejects.toMatchObject({ code });
  expect(reads).toBe(1);
});

test("response byte budget bounds streamed bodies", async () => {
  const { api } = await setup((request, response) => response.end(request.url === "/auth/external" ? '{"token":"synthetic-token"}' : "a".repeat(READ_LIMITS.bytes + 1)));
  await expect(api.read({ path: "/exceptions/whitelist" })).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
});

test("Retry-After exceeding the remaining time budget fails without retry", async () => {
  const { api } = await setup((request, response) => {
    if (request.url === "/auth/external") response.end('{"token":"synthetic-token"}');
    else { response.writeHead(429, { "retry-after": "61" }); response.end(); }
  });
  await expect(api.read({ path: "/exceptions/whitelist" })).rejects.toMatchObject({ code: "TIME_BUDGET" });
});

test("reads reuse the token and resend selectors with a returned scrollId", async () => {
  let exchanges = 0;
  const bodies: unknown[] = [];
  const { api, store } = await setup((request, response, body) => {
    if (request.url === "/auth/external") { exchanges++; response.end('{"accessToken":"synthetic-token"}'); }
    else { bodies.push(body); response.end(JSON.stringify({ ...page, responseEnvelope: { ...page.responseEnvelope, scrollId: "synthetic-scroll" } })); }
  });
  const entityFilter = { saas: "synthetic", startDate: "2026-01-01T00:00:00Z", endDate: "2026-01-02T00:00:00Z" };
  const first = await api.read({ path: "/search/query", body: { entityFilter } });
  await api.read({ path: "/search/query", body: { entityFilter, scrollId: first.scrollId } });
  expect(exchanges).toBe(1);
  expect(bodies).toEqual([{ requestData: { entityFilter } }, { requestData: { entityFilter, scrollId: "synthetic-scroll" } }]);
  expect(store.redactor.text("synthetic-token Bearer synthetic-token")).not.toContain("synthetic-token");
});

test("the request budget includes auth and prevents an eleventh HTTP request", async () => {
  let requests = 0;
  const { api } = await setup((request, response) => {
    requests++;
    response.end(JSON.stringify(request.url === "/auth/external" ? { token: "synthetic-token" } : page));
  });
  const body = { entityFilter: { saas: "synthetic", startDate: "2026-01-01T00:00:00Z", endDate: "2026-01-02T00:00:00Z" } };
  for (let index = 0; index < READ_LIMITS.requests - 1; index++) await api.read({ path: "/search/query", body });
  await expect(api.read({ path: "/search/query", body })).rejects.toMatchObject({ code: "REQUEST_BUDGET" });
  expect(requests).toBe(READ_LIMITS.requests);
});

test("TLS rejects an untrusted fake gateway certificate", async () => {
  let requests = 0;
  const { api } = await setup((_request, response) => { requests++; response.end('{"token":"synthetic-token"}'); }, {}, false);
  await expect(api.authenticate()).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  expect(requests).toBe(0);
});

test("the total deadline aborts a stalled read", async () => {
  let received!: () => void;
  const seen = new Promise<void>((resolve) => { received = resolve; });
  const { api } = await setup((request, response) => {
    if (request.url === "/auth/external") response.end('{"token":"synthetic-token"}');
    else received();
  });
  await api.authenticate();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const reading = expect(api.read({ path: "/exceptions/whitelist" })).rejects.toMatchObject({ code: "TIME_BUDGET" });
    await seen;
    await vi.advanceTimersByTimeAsync(READ_LIMITS.milliseconds);
    await reading;
  } finally { vi.useRealTimers(); }
});

test.each(["/auth/external", "/app/hec-api/v1.0/exceptions/whitelist"])("truncated responses release the deadline timer: %s", async (path) => {
  const { api } = await setup((request, response) => {
    if (request.url === path) {
      response.writeHead(200, { "content-length": "100", connection: "close" });
      response.end("{");
    } else response.end('{"token":"synthetic-token"}');
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await expect(api.read({ path: "/exceptions/whitelist" })).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

test("envelope normalization preserves scroll and accepts object records", () => {
  expect(decodePage({ responseEnvelope: { responseCode: 0, scrollId: "synthetic-scroll", totalRecordsNumber: 2 }, responseData: { entityId: "synthetic-entity" } }))
    .toEqual({ records: [{ entityId: "synthetic-entity" }], dataIsArray: false, scrollId: "synthetic-scroll", total: 2 });
});
test.each([{}, { ...page, responseEnvelope: { responseCode: 403 } }, { ...page, responseData: "invalid" }])("invalid or failed envelopes cannot pass a read: %j", (value) => {
  expect(() => decodePage(value)).toThrow();
});
