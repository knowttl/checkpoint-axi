import { readFileSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
import { decode } from "@toon-format/toon";
import { main } from "../src/cli.js";
import { fakeGateway } from "./support/fake-gateway.js";
import { localFixture } from "./support/local-cli.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/email-page.json", import.meta.url), "utf8"));
const arrayFixture = JSON.parse(readFileSync(new URL("./fixtures/email-security-array-page.json", import.meta.url), "utf8"));
const window = ["--start-date", "2026-01-01T00:00:00Z", "--end-date", "2026-01-02T00:00:00Z"];
const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); process.exitCode = 0; });
async function setup(handler: Parameters<typeof fakeGateway>[0], timing: { now?: () => number } = {}) {
  const local = localFixture();
  cleanups.push(local.cleanup);
  const server = await fakeGateway((request, response, body) => {
    if (request.url === "/auth/external") return response.end(JSON.stringify({ token: "synthetic-token-sentinel" }));
    handler(request, response, body);
  });
  cleanups.push(server.close);
  return { local, run: async (args: string[]) => {
    let output = "";
    await main(args, { credentials: local.context, transport: { agent: server.agent, ...timing }, stdout: { write: (chunk) => { output += chunk; } } });
    const code = process.exitCode ?? 0;
    process.exitCode = 0;
    return { data: decode(output) as Record<string, any>, output, code };
  } };
}

test("search defaults to 50 compact rows in a 24-hour window", async () => {
  const records = Array.from({ length: 51 }, (_, index) => ({ ...fixture.responseData[0], entityInfo: { entityId: `synthetic-email-${index}` } }));
  let body: any;
  const cli = await setup((request, response, value) => {
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/app/hec-api/v1.0/search/query");
    body = value;
    response.end(JSON.stringify({ ...fixture, responseData: records }));
  });
  const result = await cli.run(["email", "search"]);
  expect(result.code).toBe(0);
  expect(result.data.count).toBe(50);
  expect(result.data.complete).toBe(false);
  expect(result.data.cursor.length).toBeGreaterThan(0);
  expect(result.data.emails[0]).toEqual({ id: "synthetic-email-0", subject: "Synthetic message", state: "", verdict: { ap: "phishing", av: "clean" } });
  expect(body.requestData.entityFilter.saas).toBe("office365_emails");
  expect(Date.parse(body.requestData.entityFilter.endDate) - Date.parse(body.requestData.entityFilter.startDate)).toBe(86_400_000);
});

test.each([
  { shape: "object", page: fixture, id: "synthetic-email-1", verdict: { ap: "phishing", av: "clean" } },
  { shape: "array", page: arrayFixture, id: "synthetic-email-array", verdict: null },
])("unfiltered search and detail accept documented $shape security results", async ({ page, id, verdict }) => {
  const cli = await setup((_request, response) => response.end(JSON.stringify(page)));
  const search = await cli.run(["email", "search", ...window, "--all", "--saas", "office365_emails"]);
  expect(search.code).toBe(0);
  expect(search.data).toMatchObject({ complete: true, count: 1, emails: [{ id, verdict }] });
  const detail = await cli.run(["email", "show", id]);
  expect(detail.code).toBe(0);
  expect(detail.data.email.entitySecurityResults).toEqual(page.responseData[0].entitySecurityResults);
});

test.each([
  { command: "search", array: true, prefix: "$.responseData[0]" },
  { command: "show", array: true, prefix: "$.responseData[0]" },
  { command: "show", array: false, prefix: "$.responseData" },
])("$command names invalid field paths and types without response values (array: $array)", async ({ command, array, prefix }) => {
  const record = structuredClone(fixture.responseData[0]);
  record.entityInfo.entityActionState = null;
  record.entityPayload.subject = { "sender@example.test": "private-response-sentinel" };
  const cli = await setup((_request, response) => response.end(JSON.stringify({ ...fixture, responseData: array ? [record] : record })));
  const result = await cli.run(["email", command, ...(command === "show" ? ["synthetic-email-1"] : [])]);
  expect(result.code).toBe(1);
  expect(result.data.error.code).toBe("RESPONSE_INVALID");
  expect(result.data.error.message).toContain(`${prefix}.entityInfo.entityActionState: null`);
  expect(result.data.error.message).toContain(`${prefix}.entityPayload.subject: object`);
  expect(result.output).not.toMatch(/sender@example\.test|private-response-sentinel/);
});

test("continuation replays a stable page without claiming completeness", async () => {
  const records = [fixture.responseData[0], { ...fixture.responseData[0], entityInfo: { entityId: "synthetic-email-2" } }];
  const cli = await setup((_request, response) => response.end(JSON.stringify({ ...fixture, responseData: records })));
  const first = await cli.run(["email", "search", ...window, "--limit", "1"]);
  const next = await cli.run(["email", "search", "--limit", "1", "--cursor", first.data.cursor]);
  expect(next.data.emails.map((row: any) => row.id)).toEqual(["synthetic-email-2"]);
  expect(first.data.reason).toBe("replay-may-skip-or-repeat");
  expect(next.data).toMatchObject({ complete: false, reason: "replay-may-skip-or-repeat" });
  expect(next.data.help).toContain("Results changed between calls may be skipped or repeated during page replay");
  expect(next.data.cursor).toBeUndefined();
});

test("all follows scrollId with unchanged SaaS and attribute selectors", async () => {
  const bodies: any[] = [];
  const cli = await setup((_request, response, body) => {
    bodies.push(body);
    response.end(JSON.stringify({ ...fixture, responseEnvelope: { ...fixture.responseEnvelope, totalRecordsNumber: 2, scrollId: bodies.length === 1 ? "synthetic-scroll" : "" } }));
  });
  const filter = [{ saasAttrName: "entityPayload.subject", saasAttrOp: "contains", saasAttrValue: "Synthetic" }];
  const result = await cli.run(["email", "search", ...window, "--all", "--saas", "google_mail", "--saas-entity", "google_mail_email", "--filter", JSON.stringify(filter)]);
  expect(result.data).toMatchObject({ count: 2, total: 2, complete: true });
  expect(bodies[1]).toEqual({ requestData: { ...bodies[0].requestData, scrollId: "synthetic-scroll" } });
  expect(bodies[0].requestData.entityFilter).toMatchObject({ saas: "google_mail", saasEntity: "google_mail_email" });
  expect(bodies[0].requestData.entityExtendedFilter).toEqual(filter);
});

test("long continuation cursors stay usable without --full", async () => {
  const scroll = "synthetic-scroll-" + "x".repeat(1000);
  const bodies: any[] = [];
  const cli = await setup((_request, response, body) => {
    bodies.push(body);
    response.end(JSON.stringify({ ...fixture, responseEnvelope: { ...fixture.responseEnvelope, scrollId: bodies.length === 1 ? scroll : "" } }));
  });
  const first = await cli.run(["email", "search", ...window, "--limit", "1"]);
  expect(first.data.cursor.length).toBeGreaterThan(500);
  expect(first.data.cursor).not.toContain("truncated");
  const next = await cli.run(["email", "search", "--cursor", first.data.cursor]);
  expect(bodies[1].requestData.scrollId).toBe(scroll);
  expect(next.data.complete).toBe(true);
  expect(next.data.reason).toBeUndefined();
  expect(next.data.cursor).toBeUndefined();
});

test("search rejects a malformed entity instead of showing a misleading empty row", async () => {
  const cli = await setup((_request, response) => response.end(JSON.stringify({ ...fixture, responseData: [{ entityPayload: {} }] })));
  const result = await cli.run(["email", "search"]);
  expect(result.data.error.code).toBe("RESPONSE_INVALID");
});

test("all stops at the shared ten-request budget and returns continuation", async () => {
  let requests = 0;
  const cli = await setup((_request, response) => {
    requests++;
    response.end(JSON.stringify({ ...fixture, responseEnvelope: { ...fixture.responseEnvelope, scrollId: "synthetic-scroll" } }));
  });
  const result = await cli.run(["email", "search", ...window, "--all"]);
  expect(requests).toBe(9);
  expect(result.data).toMatchObject({ count: 9, complete: false });
  expect(result.data.cursor).toBeTypeOf("string");
});

test("all caps output at 1000 rows and resumes the remaining page", async () => {
  const records = Array.from({ length: 1001 }, (_, index) => ({ ...fixture.responseData[0], entityInfo: { entityId: `synthetic-email-${index}` } }));
  const cli = await setup((_request, response) => response.end(JSON.stringify({ ...fixture, responseData: records })));
  const first = await cli.run(["email", "search", ...window, "--all"]);
  expect(first.data).toMatchObject({ count: 1000, complete: false });
  const next = await cli.run(["email", "search", "--cursor", first.data.cursor]);
  expect(next.data.emails.map((row: any) => row.id)).toEqual(["synthetic-email-1000"]);
  expect(next.data).toMatchObject({ complete: false, reason: "replay-may-skip-or-repeat" });
  expect(next.data.cursor).toBeUndefined();
});

test.each([
  { args: ["--limit", "1"], count: 1 },
  { args: ["--all"], count: 1000 },
])("changed results after a $count-row cap disclose possible omissions", async ({ args, count }) => {
  const records = Array.from({ length: count + 2 }, (_, index) => ({ ...fixture.responseData[0], entityInfo: { entityId: `synthetic-email-${index}` } }));
  let requests = 0;
  const cli = await setup((_request, response) => {
    requests++;
    response.end(JSON.stringify({ ...fixture, responseData: requests === 1 ? records : records.slice(1) }));
  });
  const first = await cli.run(["email", "search", ...window, ...args]);
  const next = await cli.run(["email", "search", "--cursor", first.data.cursor]);
  expect(next.code).toBe(0);
  expect(next.data.emails.map((row: any) => row.id)).toEqual([`synthetic-email-${count + 1}`]);
  expect(next.data).toMatchObject({ complete: false, reason: "replay-may-skip-or-repeat" });
  expect(next.data.help).toContain("Results changed between calls may be skipped or repeated during page replay");
  expect(next.data.cursor).toBeUndefined();
});

test("replay risk survives a later whole-page boundary cursor", async () => {
  const bodies: any[] = [];
  const records = [fixture.responseData[0], { ...fixture.responseData[0], entityInfo: { entityId: "synthetic-email-2" } }];
  const cli = await setup((_request, response, body) => {
    bodies.push(body);
    response.end(JSON.stringify({ ...fixture, responseData: records,
      responseEnvelope: { ...fixture.responseEnvelope, scrollId: bodies.length < 3 ? "synthetic-next" : "" } }));
  });
  const first = await cli.run(["email", "search", ...window, "--limit", "1"]);
  const second = await cli.run(["email", "search", "--limit", "1", "--cursor", first.data.cursor]);
  const third = await cli.run(["email", "search", "--cursor", second.data.cursor, "--fields", "complete,reason,cursor"]);
  expect(second.data.emails.map((row: any) => row.id)).toEqual(["synthetic-email-2"]);
  expect(bodies[2].requestData.scrollId).toBe("synthetic-next");
  expect(third.data).toEqual({ complete: false, reason: "replay-may-skip-or-repeat" });
});

test.each(["time", "bytes"])("all returns partial results and a usable cursor on the %s budget", async (budget) => {
  let clock = 0;
  let requests = 0;
  const cli = await setup((_request, response) => {
    requests++;
    if (requests === 1 && budget === "time") clock = 60_001;
    response.end(JSON.stringify(requests === 2 && budget === "bytes" ? { padding: "x".repeat(8 * 1024 * 1024) }
      : { ...fixture, responseEnvelope: { ...fixture.responseEnvelope, scrollId: "synthetic-next" } }));
  }, { now: () => clock });
  const first = await cli.run(["email", "search", ...window, "--all"]);
  expect(first.data).toMatchObject({ count: 1, complete: false });
  expect(first.data.cursor).toBeTypeOf("string");
});

test.each([
  ["--saas", "google_mail"], ["--saas-entity", "other"], ["--start-date", "2026-01-01T01:00:00Z"],
  ["--filter", "[]"], ["--profile", "other"],
])("cursor refuses changed selector %s before network access", async (...selector) => {
  let requests = 0;
  const cli = await setup((_request, response) => { requests++; response.end(JSON.stringify({ ...fixture, responseEnvelope: { ...fixture.responseEnvelope, scrollId: "synthetic-scroll" } })); });
  const first = await cli.run(["email", "search", ...window, "--limit", "1"]);
  cli.local.profile.profiles.other = { ...cli.local.profile.profiles.example };
  cli.local.save();
  const result = await cli.run(["email", "search", "--cursor", first.data.cursor, ...selector]);
  expect(result.code).toBe(2);
  expect(requests).toBe(1);
});

test("cursor refuses changed region before network access", async () => {
  const cli = await setup((_request, response) => response.end(JSON.stringify({ ...fixture, responseEnvelope: { ...fixture.responseEnvelope, scrollId: "synthetic-scroll" } })));
  const first = await cli.run(["email", "search", ...window, "--limit", "1"]);
  cli.local.profile.profiles.example.region = "us";
  cli.local.save();
  expect((await cli.run(["email", "search", "--cursor", first.data.cursor])).code).toBe(2);
});

test.each([
  ["search", "--limit", "0"], ["search", "--limit", "1001"], ["search", "--limit", "1.5"],
  ["search", "--all", "--limit", "1"], ["search", "--start-date", "invalid"],
  ["search", "--start-date", "2026-01-01T00:00:00Z", "--end-date", "2026-02-02T00:00:00Z"],
  ["search", "--start-date", "2026-01-02T00:00:00Z", "--end-date", "2026-01-01T00:00:00Z"],
  ["search", "--cursor", "invalid"], ["search", "--saas", " "], ["search", "--filter", "{}"],
  ["search", "--filter", "[{\"saasAttrName\":\"subject\",\"saasAttrOp\":\"invalid\",\"saasAttrValue\":\"x\"}]"],
  ["show"], ["show", "../escape"], ["show", "synthetic-email-1", "--all"],
])("invalid email input is rejected before config or network: %j", async (...args) => {
  const local = localFixture();
  cleanups.push(local.cleanup);
  local.env.CHECKPOINT_AXI_CONFIG = "/missing/config.json";
  expect((await local.run(["email", ...args])).code).toBe(2);
});

test("a 31-day window is accepted and zero results are explicit", async () => {
  const cli = await setup((_request, response) => response.end(JSON.stringify({ ...fixture, responseData: [], responseEnvelope: { ...fixture.responseEnvelope, totalRecordsNumber: 0 } })));
  const result = await cli.run(["email", "search", "--start-date", "2026-01-01T00:00:00Z", "--end-date", "2026-02-01T00:00:00Z"]);
  expect(result.data).toMatchObject({ count: 0, total: 0, complete: true, emails: [] });
  expect(result.data.help).toContain("No emails matched this search window and selectors");
});

test("show preserves verdicts and actions, redacts secrets before truncation and supports full output", async () => {
  const record = structuredClone(fixture.responseData[0]);
  record.entityPayload.subject = "synthetic-secret-sentinel " + "s".repeat(501);
  record.entityPayload.note = "synthetic-token-sentinel";
  const cli = await setup((request, response) => {
    expect(request.method).toBe("GET");
    expect(request.url).toBe("/app/hec-api/v1.0/search/entity/synthetic-email-1");
    response.end(JSON.stringify({ ...fixture, responseData: record }));
  });
  const preview = await cli.run(["email", "show", "synthetic-email-1"]);
  expect(preview.code).toBe(0);
  expect(preview.output).not.toContain("synthetic-secret-sentinel");
  expect(preview.output).not.toContain("synthetic-token-sentinel");
  expect(preview.data.email.entityPayload.subject).toContain("truncated");
  expect(preview.data.email.entityActions).toEqual(record.entityActions);
  expect(preview.data.email.entityAvailableActions).toEqual(record.entityAvailableActions);
  const full = await cli.run(["email", "show", "synthetic-email-1", "--full"]);
  expect(full.data.email.entityPayload.subject).toBe("***redacted*** " + "s".repeat(501));
  expect(full.data.email.entityPayload.note).toBe("***redacted***");
});

test("an auth token echoed as scrollId is refused without encoding it into output", async () => {
  const cli = await setup((_request, response) => response.end(JSON.stringify({ ...fixture, responseEnvelope: { ...fixture.responseEnvelope, scrollId: "synthetic-token-sentinel" } })));
  const result = await cli.run(["email", "search"]);
  expect(result.data.error.code).toBe("RESPONSE_INVALID");
  expect(result.output).not.toContain("synthetic-token-sentinel");
});

test.each([{ records: [] }, { records: [{ entityInfo: {} }] }])("show rejects missing or malformed detail: %j", async ({ records }) => {
  const cli = await setup((_request, response) => response.end(JSON.stringify({ ...fixture, responseData: records })));
  expect((await cli.run(["email", "show", "synthetic-email-1"])).code).toBe(1);
});
