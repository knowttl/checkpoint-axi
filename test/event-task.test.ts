import { readFileSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
import { decode } from "@toon-format/toon";
import { main } from "../src/cli.js";
import { fakeGateway } from "./support/fake-gateway.js";
import { localFixture } from "./support/local-cli.js";

const eventPage = JSON.parse(readFileSync(new URL("./fixtures/event-page.json", import.meta.url), "utf8"));
const taskPage = JSON.parse(readFileSync(new URL("./fixtures/task-page.json", import.meta.url), "utf8"));
const window = ["--start-date", "2026-01-01T00:00:00Z", "--end-date", "2026-01-02T00:00:00Z"];
const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); process.exitCode = 0; });
async function setup(handler: Parameters<typeof fakeGateway>[0], timing: { now?: () => number; wait?: (milliseconds: number) => Promise<unknown> } = {}) {
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

test("event list projects selected row fields", async () => {
  const cli = await setup((_request, response) => response.end(JSON.stringify(eventPage)));
  const result = await cli.run(["event", "list", "--fields", "id,type"]);
  expect(result.code, result.output).toBe(0);
  expect(result.data.events).toEqual([{ id: "synthetic-event-1", type: "phishing" }]);
  expect(result.data.count).toBe(1);
});

test.each([
  ["email", "search", "id,subject,state,verdict"],
  ["event", "list", "id,type,state,severity"],
])("%s %s names valid row fields for an unknown field", async (kind, command, valid) => {
  const local = localFixture();
  cleanups.push(local.cleanup);
  local.env.CHECKPOINT_AXI_CONFIG = "/missing/config.json";
  const result = await local.run([kind, command, "--fields", "bogus"]);
  expect(result.code).toBe(2);
  expect(result.output).toContain(valid);
});

test.each(["--event-states", "--states"])("%s rejects unknown states before config access", async (flag) => {
  const local = localFixture();
  cleanups.push(local.cleanup);
  local.env.CHECKPOINT_AXI_CONFIG = "/missing/config.json";
  const result = await local.run(["event", "list", flag, "unknown"]);
  expect(result.code).toBe(2);
  expect(result.output).toContain("new, detected, pending, remediated, dismissed, exception");
});

test.each([
  ["email", "search", "id,count", "emails", "id,subject,state,verdict"],
  ["email", "search", "count,subject", "emails", "id,subject,state,verdict"],
  ["event", "list", "id,count", "events", "id,type,state,severity"],
  ["event", "list", "count,type", "events", "id,type,state,severity"],
])("%s %s rejects mixed field groups %s before config access", async (kind, command, fields, key, rowFields) => {
  const local = localFixture();
  cleanups.push(local.cleanup);
  local.env.CHECKPOINT_AXI_CONFIG = "/missing/config.json";
  const result = await local.run([kind, command, "--fields", fields]);
  expect(result.code).toBe(2);
  expect(result.output).toContain(`valid top-level fields: ${key},count,total,complete,reason,cursor,expansion,help`);
  expect(result.output).toContain(`valid row fields: ${rowFields}`);
});

test.each([" ", "high,", ",high", "high, ,low"])("event list rejects empty severity entries %j before config access", async (severities) => {
  const local = localFixture();
  cleanups.push(local.cleanup);
  local.env.CHECKPOINT_AXI_CONFIG = "/missing/config.json";
  const result = await local.run(["event", "list", "--severities", severities]);
  expect(result.code).toBe(2);
  expect(result.output).toContain("--severities must contain nonempty comma-separated severity strings");
});

test("event list sends severity strings without inventing a fixed value list", async () => {
  let body: any;
  const cli = await setup((_request, response, value) => {
    body = value;
    response.end(JSON.stringify({ ...eventPage, responseData: [] }));
  });
  const result = await cli.run(["event", "list", "--severities", " 9,synthetic-severity "]);
  expect(result.code, result.output).toBe(0);
  expect(body.requestData.severities).toEqual(["9", "synthetic-severity"]);
  expect(result.data.events).toEqual([]);
});

test("event list preserves top-level field projections", async () => {
  const cli = await setup((_request, response) => response.end(JSON.stringify(eventPage)));
  const result = await cli.run(["event", "list", "--fields", "count"]);
  expect(result.code, result.output).toBe(0);
  expect(result.data).toEqual({ count: 1 });
});

test.each(["email", "event", "task"])("%s show maps HTTP 404 to NOT_FOUND", async (kind) => {
  const cli = await setup((_request, response) => { response.writeHead(404); response.end(JSON.stringify({ detail: "private-response-sentinel" })); });
  const result = await cli.run([kind, "show", "synthetic-missing"]);
  expect(result.data.error.code).toBe("NOT_FOUND");
  expect(result.output).not.toContain("private-response-sentinel");
});

test.each(["email", "event", "task"])("%s show HTTP 422 names only the requested ID", async (kind) => {
  const cli = await setup((_request, response) => { response.writeHead(422); response.end(JSON.stringify({ detail: [{ loc: ["path", "id"], msg: "private-response-sentinel", type: "type_error.integer" }] })); });
  const result = await cli.run([kind, "show", "synthetic-invalid"]);
  expect(result.data.error.message).toContain("synthetic-invalid");
  expect(result.output).not.toContain("private-response-sentinel");
  expect(result.output).not.toContain("Check the selected region and credentials");
});

test("event list defaults to 50 compact rows and the profile SaaS in a 24-hour window", async () => {
  const records = Array.from({ length: 51 }, (_, index) => ({ ...eventPage.responseData[0], eventId: `synthetic-event-${index}` }));
  let body: any;
  const cli = await setup((request, response, value) => {
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/app/hec-api/v1.0/event/query");
    body = value;
    response.end(JSON.stringify({ ...eventPage, responseData: records }));
  });
  cli.local.profile.profiles.example.saas = "google_mail";
  cli.local.save();
  const result = await cli.run(["event", "list"]);
  expect(result.code).toBe(0);
  expect(result.data).toMatchObject({ count: 50, complete: false, reason: "replay-may-skip-or-repeat" });
  expect(result.data.events[0]).toEqual({ id: "synthetic-event-0", type: "phishing", state: "new", severity: "high" });
  expect(body.requestData.saas).toEqual(["google_mail"]);
  expect(Date.parse(body.requestData.endDate) - Date.parse(body.requestData.startDate)).toBe(86_400_000);
});

test("event scrolling preserves every selector and reports server totals", async () => {
  const bodies: any[] = [];
  const cli = await setup((_request, response, body) => {
    bodies.push(body);
    response.end(JSON.stringify({ ...eventPage, responseEnvelope: { responseCode: 0, totalRecordsNumber: 2,
      scrollId: bodies.length === 1 ? "synthetic-next" : "" } }));
  });
  const result = await cli.run(["event", "list", ...window, "--all", "--saas", "google_mail,office365_emails",
    "--event-types", "phishing,malware", "--event-states", "new,dismissed", "--severities", "high,low",
    "--event-ids", "synthetic-event-1", "--confidence-indicator", "malicious", "--description", "Synthetic"]);
  expect(result.data).toMatchObject({ count: 2, total: 2, complete: true });
  expect(bodies[0].requestData).toEqual({ startDate: window[1], endDate: window[3], saas: ["google_mail", "office365_emails"],
    eventTypes: ["phishing", "malware"], eventStates: ["new", "dismissed"], severities: ["high", "low"],
    eventIds: ["synthetic-event-1"], confidenceIndicator: "malicious", description: "Synthetic" });
  expect(bodies[1]).toEqual({ requestData: { ...bodies[0].requestData, scrollId: "synthetic-next" } });
});

test("event continuation preserves unread rows and discloses page replay risk", async () => {
  const records = [eventPage.responseData[0], { ...eventPage.responseData[0], eventId: "synthetic-event-2" }];
  const cli = await setup((_request, response) => response.end(JSON.stringify({ ...eventPage, responseData: records })));
  const first = await cli.run(["event", "list", ...window, "--limit", "1"]);
  const next = await cli.run(["event", "list", "--cursor", first.data.cursor]);
  expect(next.data.events.map((row: any) => row.id)).toEqual(["synthetic-event-2"]);
  expect(next.data).toMatchObject({ complete: false, reason: "replay-may-skip-or-repeat" });
  expect(next.data.cursor).toBeUndefined();
});

test.each([
  ["--saas", "google_mail"], ["--event-types", "malware"], ["--event-states", "dismissed"],
  ["--severities", "low"], ["--event-ids", "synthetic-event-2"], ["--confidence-indicator", "clean"],
  ["--description", "other"], ["--profile", "other"], ["--start-date", "2026-01-01T01:00:00Z"],
])("event cursor refuses changed selector %s before network access", async (...selector) => {
  let calls = 0;
  const cli = await setup((_request, response) => { calls++; response.end(JSON.stringify({ ...eventPage,
    responseEnvelope: { responseCode: 0, scrollId: "synthetic-next" } })); });
  const first = await cli.run(["event", "list", ...window, "--limit", "1"]);
  cli.local.profile.profiles.other = { ...cli.local.profile.profiles.example };
  cli.local.save();
  expect((await cli.run(["event", "list", "--cursor", first.data.cursor, ...selector])).code).toBe(2);
  expect(calls).toBe(1);
});

test("event cursor rejects a different operation or region", async () => {
  const cli = await setup((_request, response) => response.end(JSON.stringify({ ...eventPage, responseEnvelope: { responseCode: 0, scrollId: "synthetic-next" } })));
  const first = await cli.run(["event", "list", ...window, "--limit", "1"]);
  expect((await cli.run(["email", "search", "--cursor", first.data.cursor])).code).toBe(2);
  cli.local.profile.profiles.example.region = "us";
  cli.local.save();
  expect((await cli.run(["event", "list", "--cursor", first.data.cursor])).code).toBe(2);
});

test("event all stops at the transport request budget with usable untruncated continuation", async () => {
  let calls = 0;
  const scroll = "synthetic-" + "s".repeat(1000);
  const cli = await setup((_request, response) => { calls++; response.end(JSON.stringify({ ...eventPage,
    responseEnvelope: { responseCode: 0, scrollId: scroll } })); });
  const result = await cli.run(["event", "list", "--all"]);
  expect(result.code, result.output).toBe(0);
  expect(calls).toBe(9);
  expect(result.data).toMatchObject({ count: 9, complete: false });
  expect(result.data.cursor.length).toBeGreaterThan(500);
  expect(result.data.cursor).not.toContain("truncated");
});

test("event all caps at 1000 rows", async () => {
  const records = Array.from({ length: 1001 }, (_, index) => ({ ...eventPage.responseData[0], eventId: `synthetic-event-${index}` }));
  const cli = await setup((_request, response) => response.end(JSON.stringify({ ...eventPage, responseData: records })));
  const result = await cli.run(["event", "list", "--all"]);
  expect(result.data).toMatchObject({ count: 1000, complete: false });
  const next = await cli.run(["event", "list", "--cursor", result.data.cursor]);
  expect(next.data.events.map((row: any) => row.id)).toEqual(["synthetic-event-1000"]);
});

test("empty events are explicit and a 31-day window is accepted", async () => {
  const cli = await setup((_request, response) => response.end(JSON.stringify({ ...eventPage, responseData: [], responseEnvelope: { responseCode: 0, totalRecordsNumber: 0 } })));
  const result = await cli.run(["event", "list", "--start-date", "2026-01-01T00:00:00Z", "--end-date", "2026-02-01T00:00:00Z"]);
  expect(result.data).toMatchObject({ events: [], count: 0, total: 0, complete: true });
  expect(result.data.help).toContain("No events matched this search window and selectors");
});

test.each(["event", "task"])("%s show preserves details, redacts before preview and supports --full", async (kind) => {
  const page = structuredClone(kind === "event" ? eventPage : taskPage);
  const record = kind === "event" ? page.responseData[0] : page.responseData;
  const id = kind === "event" ? "synthetic-event-1" : "123";
  record.description = "synthetic-secret-sentinel " + "x".repeat(501);
  record.note = "synthetic-token-sentinel";
  page.responseData = record;
  const cli = await setup((request, response) => {
    expect(request.method).toBe("GET");
    expect(request.url).toBe(`/app/hec-api/v1.0/${kind}/${id}`);
    response.end(JSON.stringify(page));
  });
  const result = await cli.run([kind, "show", id]);
  expect(result.code).toBe(0);
  expect(result.data[kind].actions).toEqual(record.actions);
  expect(result.data[kind].description).toContain("truncated");
  expect(result.output).not.toContain("synthetic-secret-sentinel");
  expect(result.output).not.toContain("synthetic-token-sentinel");
  const full = await cli.run([kind, "show", id, "--full"]);
  expect(full.data[kind].description).not.toContain("truncated");
  expect(full.output).not.toContain("synthetic-secret-sentinel");
  if (kind === "event") expect(full.data.event.availableEventActions).toEqual(record.availableEventActions);
  else expect(full.data.task).toMatchObject({ status: "completed", progress: 1, total: 1 });
});

test.each(["init", "inprogress", "completed", "failed", "stopped", "paused"])("task show preserves %s status", async (status) => {
  const cli = await setup((_request, response) => response.end(JSON.stringify({ ...taskPage, responseData: [{ ...taskPage.responseData, status }] })));
  expect((await cli.run(["task", "show", "123"])).data.task.status).toBe(status);
});

test.each(["completed", "failed", "stopped"])("task wait reaches terminal %s using only status GETs", async (status) => {
  let time = 0;
  const reads: { method: string | undefined; path: string | undefined; time: number }[] = [];
  const states = ["init", "paused", "inprogress", status];
  const cli = await setup((request, response) => {
    reads.push({ method: request.method, path: request.url, time });
    const state = states[reads.length - 1];
    response.end(JSON.stringify({ ...taskPage, responseData: { ...taskPage.responseData, status: state,
      progress: reads.length === 4 ? 1 : 0, actions: [{ ...taskPage.responseData.actions[0], action_status: state }] } }));
  }, { now: () => time, wait: async (milliseconds) => { time += milliseconds; } });
  cli.local.env.CHECKPOINT_AXI_READ_ONLY = "1";
  const result = await cli.run(["task", "show", "123", "--wait", "--timeout", "30"]);
  expect(result.code, result.output).toBe(0);
  expect(result.data).toMatchObject({ task: { status, progress: 1 }, wait: { terminal: true, polls: 4, reason: "terminal" } });
  expect(reads).toEqual([0, 2_000, 4_000, 6_000].map((time) => ({ method: "GET", path: "/app/hec-api/v1.0/task/123", time })));
});

test("task wait timeout returns the last snapshot and read-only recovery", async () => {
  let time = 0;
  let reads = 0;
  const cli = await setup((_request, response) => {
    reads++;
    response.end(JSON.stringify({ ...taskPage, responseData: { ...taskPage.responseData, status: "inprogress", progress: reads, total: 10 } }));
  }, { now: () => time, wait: async (milliseconds) => { time += milliseconds; } });
  const result = await cli.run(["task", "show", "123", "--wait", "--timeout", "3", "--fields", "task,wait,help"]);
  expect(result.code).toBe(0);
  expect(result.data).toMatchObject({ task: { status: "inprogress", progress: 2 }, wait: { terminal: false, polls: 2, reason: "timeout" } });
  expect(reads).toBe(2);
  expect(time).toBe(3_000);
  expect(result.data.help[0]).toContain("checkpoint-axi task show 123");
  expect(result.data.help[0]).toContain("never resubmit");
});

test("task wait returns an already terminal snapshot without delaying or polling again", async () => {
  let time = 0;
  let reads = 0;
  const cli = await setup((_request, response) => { reads++; response.end(JSON.stringify(taskPage)); },
    { now: () => time, wait: async (milliseconds) => { time += milliseconds; } });
  const result = await cli.run(["task", "show", "123", "--wait", "--timeout", "1"]);
  expect(result.data).toMatchObject({ task: { status: "completed" }, wait: { terminal: true, polls: 1, reason: "terminal" } });
  expect(reads).toBe(1);
  expect(time).toBe(0);
});

test("task wait request cap includes authentication and read retries", async () => {
  let time = 0;
  let reads = 0;
  const cli = await setup((_request, response) => {
    reads++;
    if (reads === 2) {
      response.writeHead(429, { "retry-after": "1" });
      return response.end();
    }
    response.end(JSON.stringify({ ...taskPage, responseData: { ...taskPage.responseData, status: "paused" } }));
  }, { now: () => time, wait: async (milliseconds) => { time += milliseconds; } });
  const result = await cli.run(["task", "show", "123", "--wait", "--timeout", "60", "--wait-requests", "4"]);
  expect(result.code).toBe(0);
  expect(result.data).toMatchObject({ task: { status: "paused" }, wait: { terminal: false, polls: 2, reason: "budget" } });
  expect(reads).toBe(3);
});

test("task wait applies its timeout to Retry-After without discarding the last snapshot", async () => {
  let time = 0;
  let reads = 0;
  const cli = await setup((_request, response) => {
    if (++reads === 2) {
      response.writeHead(429, { "retry-after": "30" });
      return response.end();
    }
    response.end(JSON.stringify({ ...taskPage, responseData: { ...taskPage.responseData, status: "inprogress" } }));
  }, { now: () => time, wait: async (milliseconds) => { time += milliseconds; } });
  const result = await cli.run(["task", "show", "123", "--wait", "--timeout", "5"]);
  expect(result.code).toBe(0);
  expect(result.data).toMatchObject({ task: { status: "inprogress" }, wait: { terminal: false, polls: 1, reason: "timeout" } });
  expect(reads).toBe(2);
});

test("task wait accepts the maximum poll interval without reading at the deadline", async () => {
  let time = 0;
  const readTimes: number[] = [];
  const cli = await setup((_request, response) => {
    readTimes.push(time);
    response.end(JSON.stringify({ ...taskPage, responseData: { ...taskPage.responseData, status: "init" } }));
  }, { now: () => time, wait: async (milliseconds) => { time += milliseconds; } });
  const result = await cli.run(["task", "show", "123", "--wait", "--timeout", "20", "--poll-interval", "10"]);
  expect(result.data.wait).toEqual({ terminal: false, polls: 2, reason: "timeout" });
  expect(readTimes).toEqual([0, 10_000]);
});

test.each([
  ["event", "list", "--limit", "0"], ["event", "list", "--all", "--limit", "1"],
  ["event", "list", "--event-types", "phishing,"], ["event", "list", "--saas", " "],
  ["event", "list", "--description", " "], ["event", "list", "--cursor", "invalid"],
  ["event", "list", "--start-date", "2026-01-01T00:00:00Z", "--end-date", "2026-02-02T00:00:00Z"],
  ["event", "show"], ["task", "show"], ["task", "show", "../escape"],
  ["event", "show", "synthetic-event-1", "--execute"], ["task", "show", "123", "--saas", "google_mail"],
  ["task", "show", "123", "--wait"], ["task", "show", "123", "--timeout", "3"],
  ["task", "show", "123", "--poll-interval", "2"], ["task", "show", "123", "--wait-requests", "2"],
  ...["0", "61", "1.5"].map((value) => ["task", "show", "123", "--wait", "--timeout", value]),
  ...["0", "11", "1.5"].map((value) => ["task", "show", "123", "--wait", "--timeout", "30", "--poll-interval", value]),
  ...["1", "11", "2.5"].map((value) => ["task", "show", "123", "--wait", "--timeout", "30", "--wait-requests", value]),
])("invalid event/task input fails before config access: %j", async (...args) => {
  const local = localFixture();
  cleanups.push(local.cleanup);
  local.env.CHECKPOINT_AXI_CONFIG = "/missing/config.json";
  expect((await local.run(args)).code).toBe(2);
});

test.each([
  ["event", "show", "synthetic-event-1", [{ eventId: "other", type: "phishing", severity: "high", state: "new" }]],
  ["event", "list", undefined, [{}]], ["event", "show", "synthetic-event-1", [null]],
  ["task", "show", "123", [{ ...taskPage.responseData, id: 456 }]],
  ["task", "show", "123", [{ ...taskPage.responseData, status: "unknown" }]],
])("malformed or mismatched %s %s response is rejected", async (kind, command, id, records) => {
  const cli = await setup((_request, response) => response.end(JSON.stringify({ responseEnvelope: { responseCode: 0 }, responseData: records })));
  expect((await cli.run([kind!, command!, ...(id ? [id] : [])] as string[])).data.error.code).toBe("RESPONSE_INVALID");
});
