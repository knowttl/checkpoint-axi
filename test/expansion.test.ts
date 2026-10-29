import { readFileSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
import { decode } from "@toon-format/toon";
import { main } from "../src/cli.js";
import { fakeGateway } from "./support/fake-gateway.js";
import { localFixture } from "./support/local-cli.js";

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); process.exitCode = 0; });

async function setup(kind: "email" | "event", count: number,
  handler?: Parameters<typeof fakeGateway>[0], timing: { now?: () => number } = {}) {
  const local = localFixture();
  local.env.CHECKPOINT_AXI_READ_ONLY = "1";
  cleanups.push(local.cleanup);
  const page = JSON.parse(readFileSync(new URL(`./fixtures/${kind}-page.json`, import.meta.url), "utf8"));
  const records = Array.from({ length: count }, (_, index) => kind === "email"
    ? { ...page.responseData[0], entityInfo: { ...page.responseData[0].entityInfo, entityId: `synthetic-email-${index + 1}` } }
    : { ...page.responseData[0], eventId: `synthetic-event-${index + 1}` });
  const listPath = `/app/hec-api/v1.0/${kind === "email" ? "search" : "event"}/query`;
  const detailPath = `/app/hec-api/v1.0/${kind === "email" ? "search/entity" : "event"}/`;
  const requests: { method: string | undefined; path: string | undefined }[] = [];
  const server = await fakeGateway((request, response, body) => {
    requests.push({ method: request.method, path: request.url });
    if (request.url === "/auth/external") return response.end(JSON.stringify({ token: "synthetic-token-sentinel" }));
    if (handler) return handler(request, response, body);
    const data = request.url === listPath ? records : records.filter((record) => request.url === detailPath + (kind === "email" ? record.entityInfo.entityId : record.eventId));
    response.end(JSON.stringify({ ...page, responseData: data, responseEnvelope: { responseCode: 0, totalRecordsNumber: data.length } }));
  });
  cleanups.push(server.close);
  return { local, page, records, requests, listPath, detailPath, run: async (flags: string[] = []) => {
    let output = "";
    await main([kind, kind === "email" ? "search" : "list", ...flags], {
      credentials: local.context, transport: { agent: server.agent, ...timing }, stdout: { write: (chunk) => { output += chunk; } },
    });
    const code = process.exitCode ?? 0;
    process.exitCode = 0;
    return { data: decode(output) as Record<string, any>, output, code };
  } };
}

for (const kind of ["email", "event"] as const) {
  const rows = kind === "email" ? "emails" : "events";
  test(`${kind} lists do not fetch or emit detail by default`, async () => {
    const cli = await setup(kind, 1);
    const result = await cli.run();
    expect(result.code).toBe(0);
    expect(result.data[rows]).toHaveLength(1);
    expect(result.data[rows][0]).not.toHaveProperty("detail");
    expect(result.data).not.toHaveProperty("expansion");
    expect(cli.requests).toEqual([{ method: "POST", path: "/auth/external" }, { method: "POST", path: cli.listPath }]);
  });

  test(`${kind} expansion defaults to five read-only show details and keeps capped rows`, async () => {
    const cli = await setup(kind, 7);
    const result = await cli.run(["--expand"]);
    expect(result.code, result.output).toBe(0);
    expect(result.data[rows]).toHaveLength(7);
    expect(result.data[rows].slice(0, 5).map((row: any) => row.detail)).toEqual(cli.records.slice(0, 5));
    expect(result.data.expansion).toEqual({ expanded: 5, attempted: 5, itemLimit: 5, requestLimit: 10, complete: false,
      notExpanded: [6, 7].map((index) => ({ id: `synthetic-${kind}-${index}`, reason: "item-cap-reached" })) });
    expect(cli.requests.slice(2)).toEqual([1, 2, 3, 4, 5].map((index) => ({ method: "GET", path: cli.detailPath + `synthetic-${kind}-${index}` })));
  });

  test(`${kind} expansion counts auth, list and retry requests against the caller cap`, async () => {
    let calls = 0;
    const page = JSON.parse(readFileSync(new URL(`./fixtures/${kind}-page.json`, import.meta.url), "utf8"));
    const cli = await setup(kind, 1, (request, response) => {
      calls++;
      if (request.method === "GET") { response.statusCode = 429; response.setHeader("retry-after", "0"); }
      response.end(JSON.stringify(page));
    });
    const result = await cli.run(["--expand", "--expand-requests", "4"]);
    expect(result.code, result.output).toBe(0);
    expect(calls).toBe(3);
    expect(cli.requests).toHaveLength(4);
    expect(result.data[rows]).toHaveLength(1);
    expect(result.data.expansion).toMatchObject({ expanded: 0, complete: false,
      notExpanded: [{ id: `synthetic-${kind}-1`, reason: "request-cap-reached", code: "REQUEST_BUDGET" }] });
  });

  test(`${kind} expansion completes at the maximum item and request caps`, async () => {
    const cli = await setup(kind, 8);
    const result = await cli.run(["--expand", "--expand-limit", "8"]);
    expect(result.code).toBe(0);
    expect(result.data[rows].map((row: any) => row.detail)).toEqual(cli.records);
    expect(result.data.expansion).toEqual({ expanded: 8, attempted: 8, itemLimit: 8, requestLimit: 10, complete: true, notExpanded: [] });
    expect(cli.requests).toHaveLength(10);
  });

  test(`${kind} expansion retains successful details when the request cap stops later items`, async () => {
    const cli = await setup(kind, 3);
    const result = await cli.run(["--expand", "--expand-requests", "3"]);
    expect(result.code).toBe(0);
    expect(result.data[rows]).toHaveLength(3);
    expect(result.data[rows][0].detail).toEqual(cli.records[0]);
    expect(result.data.expansion).toMatchObject({ expanded: 1, complete: false,
      notExpanded: [2, 3].map((index) => ({ id: `synthetic-${kind}-${index}`, reason: "request-cap-reached", code: "REQUEST_BUDGET" })) });
    expect(cli.requests).toHaveLength(3);
  });

  test(`${kind} expansion preserves completed detail and reports remaining items on time exhaustion`, async () => {
    let clock = 0;
    const page = JSON.parse(readFileSync(new URL(`./fixtures/${kind}-page.json`, import.meta.url), "utf8"));
    const records = [1, 2, 3].map((index) => kind === "email"
      ? { ...page.responseData[0], entityInfo: { ...page.responseData[0].entityInfo, entityId: `synthetic-email-${index}` } }
      : { ...page.responseData[0], eventId: `synthetic-event-${index}` });
    const cli = await setup(kind, 3, (request, response) => {
      if (request.method === "GET") clock = 60_001;
      response.end(JSON.stringify({ ...page, responseData: request.method === "GET" ? records[0] : records }));
    }, { now: () => clock });
    const result = await cli.run(["--expand"]);
    expect(result.code, result.output).toBe(0);
    expect(result.data[rows][0].detail).toEqual(records[0]);
    expect(result.data[rows]).toHaveLength(3);
    expect(result.data.expansion).toMatchObject({ expanded: 1, complete: false,
      notExpanded: [2, 3].map((index) => ({ id: `synthetic-${kind}-${index}`, reason: "budget-exhausted", code: "TIME_BUDGET" })) });
    expect(cli.requests).toHaveLength(3);
  });

  test(`${kind} expansion continues after a per-item HTTP failure`, async () => {
    const page = JSON.parse(readFileSync(new URL(`./fixtures/${kind}-page.json`, import.meta.url), "utf8"));
    const second = kind === "email"
      ? { ...page.responseData[0], entityInfo: { ...page.responseData[0].entityInfo, entityId: "synthetic-email-2" } }
      : { ...page.responseData[0], eventId: "synthetic-event-2" };
    const cli = await setup(kind, 2, (request, response) => {
      if (request.url!.endsWith(`synthetic-${kind}-1`)) { response.statusCode = 404; return response.end("synthetic-secret-sentinel"); }
      response.end(JSON.stringify({ ...page, responseData: request.method === "GET" ? second : [page.responseData[0], second] }));
    });
    const result = await cli.run(["--expand", "--fields", `${rows},expansion`]);
    expect(result.code, result.output).toBe(0);
    expect(result.data[rows]).toHaveLength(2);
    expect(result.data[rows][1].detail).toEqual(second);
    expect(result.data.expansion).toMatchObject({ expanded: 1, attempted: 2, complete: false,
      notExpanded: [{ id: `synthetic-${kind}-1`, reason: "per-item-error", code: "HTTP_ERROR" }] });
    expect(result.output).not.toContain("synthetic-secret-sentinel");
  });

  test(`${kind} all retains pagination and rows when listing consumes the expansion request budget`, async () => {
    const page = JSON.parse(readFileSync(new URL(`./fixtures/${kind}-page.json`, import.meta.url), "utf8"));
    let index = 0;
    const cli = await setup(kind, 1, (_request, response) => {
      index++;
      const record = kind === "email"
        ? { ...page.responseData[0], entityInfo: { ...page.responseData[0].entityInfo, entityId: `synthetic-email-${index}` } }
        : { ...page.responseData[0], eventId: `synthetic-event-${index}` };
      response.end(JSON.stringify({ ...page, responseData: [record], responseEnvelope: { responseCode: 0, scrollId: "synthetic-next" } }));
    });
    const result = await cli.run(["--all", "--expand", "--expand-requests", "3"]);
    expect(result.code, result.output).toBe(0);
    expect(result.data).toMatchObject({ count: 2, complete: false, expansion: { expanded: 0, complete: false,
      notExpanded: [1, 2].map((index) => ({ id: `synthetic-${kind}-${index}`, reason: "request-cap-reached", code: "REQUEST_BUDGET" })) } });
    expect(result.data.cursor).toBeTypeOf("string");
    expect(result.data[rows]).toHaveLength(2);
    expect(cli.requests).toHaveLength(3);
  });

  test(`${kind} expansion rejects mismatched detail identity without losing the row`, async () => {
    const page = JSON.parse(readFileSync(new URL(`./fixtures/${kind}-page.json`, import.meta.url), "utf8"));
    const other = kind === "email"
      ? { ...page.responseData[0], entityInfo: { ...page.responseData[0].entityInfo, entityId: "synthetic-other" } }
      : { ...page.responseData[0], eventId: "synthetic-other" };
    const cli = await setup(kind, 1, (request, response) => response.end(JSON.stringify({ ...page,
      responseData: request.method === "GET" ? other : page.responseData })));
    const result = await cli.run(["--expand"]);
    expect(result.code).toBe(0);
    expect(result.data[rows]).toHaveLength(1);
    expect(result.data[rows][0]).not.toHaveProperty("detail");
    expect(result.data.expansion).toMatchObject({ expanded: 0,
      notExpanded: [{ id: `synthetic-${kind}-1`, reason: "per-item-error", code: "RESPONSE_INVALID" }] });
  });

  test.each([
    ["--expand-limit", "1"], ["--expand-requests", "3"],
    ["--expand", "--expand-limit", "0"], ["--expand", "--expand-limit", "9"],
    ["--expand", "--expand-requests", "1"], ["--expand", "--expand-requests", "11"],
  ])(`${kind} rejects invalid expansion bounds before config access: %j`, async (...flags) => {
    const local = localFixture();
    cleanups.push(local.cleanup);
    local.env.CHECKPOINT_AXI_CONFIG = "/missing/config.json";
    expect((await local.run([kind, kind === "email" ? "search" : "list", ...flags])).code).toBe(2);
  });
}
