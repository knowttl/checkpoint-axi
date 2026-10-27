import { readFileSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
import { decode } from "@toon-format/toon";
import { main } from "../src/cli.js";
import { fakeGateway } from "./support/fake-gateway.js";
import { localFixture } from "./support/local-cli.js";

const page = JSON.parse(readFileSync(new URL("./fixtures/exception-page.json", import.meta.url), "utf8"));
const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); process.exitCode = 0; });
async function setup(handler: Parameters<typeof fakeGateway>[0]) {
  const local = localFixture();
  cleanups.push(local.cleanup);
  const server = await fakeGateway((request, response, body) => {
    if (request.url === "/auth/external") return response.end(JSON.stringify({ token: "synthetic-token-sentinel" }));
    handler(request, response, body);
  });
  cleanups.push(server.close);
  return { run: async (args: string[]) => {
    let output = "";
    await main(args, { credentials: local.context, transport: { agent: server.agent }, stdout: { write: (chunk) => { output += chunk; } } });
    const code = process.exitCode ?? 0;
    process.exitCode = 0;
    return { data: decode(output) as Record<string, any>, output, code };
  } };
}

test.each([
  ["phishing-allow", "whitelist"], ["phishing-block", "blacklist"], ["spam-allow", "spam_whitelist"],
])("%s list and show use documented GET routes and validate identity", async (kind, route) => {
  const paths: string[] = [];
  const cli = await setup((request, response, body) => {
    expect(request.method).toBe("GET");
    expect(body).toBeUndefined();
    paths.push(request.url!);
    response.end(JSON.stringify(page));
  });
  const list = await cli.run(["exception", "list", kind!]);
  expect(list.code, list.output).toBe(0);
  expect(list.data).toMatchObject({ exceptions: [{ id: "synthetic-exception-1", sender: "sender@example.com", subject: "Synthetic exception", comment: "Synthetic rule" }], count: 1, total: 1, complete: true });
  const detail = await cli.run(["exception", "show", kind!, "synthetic-exception-1"]);
  expect(detail.data.exception).toEqual(page.responseData[0]);
  expect(paths).toEqual([`/app/hec-api/v1.0/exceptions/${route}`, `/app/hec-api/v1.0/exceptions/${route}/synthetic-exception-1`]);
  expect((await cli.run(["exception", "show", kind!, "other"])).data.error.code).toBe("RESPONSE_INVALID");
});

// No response schemas are published for these endpoints (guide pages 83-123).
// Arbitrary JSON here tests preservation, not a claimed vendor schema.
test.each([
  ["anomaly", "/sectools/anomaly/exceptions", []],
  ["click-time", "/sectools/click_time_protection/exceptions", []],
  ["click-time", "/sectools/click_time_protection/exceptions/items", ["--items"]],
  ...["hash", "micro_hash", "file_type", "ppat_sender_name", "allow_file_type", "sender_email"].map((type) => ["malware", `/sectool-exceptions/checkpoint2/exceptions/${type}`, ["--type", type]]),
  ...["allow-url", "allow-domain", "block-url", "block-domain"].map((type) => ["url", `/sectool-exceptions/avanan_url/exceptions/${type}`, ["--type", type]]),
  ...["hash", "text_content", "sender_email", "recipient_email"].map((type) => ["dlp", `/sectool-exceptions/avanan_dlp/exceptions/${type}`, ["--type", type]]),
] as [string, string, string[]][])("%s list preserves unspecified JSON on %s", async (kind, path, flags) => {
  const cli = await setup((request, response) => {
    expect(request.method).toBe("GET");
    expect(request.url).toBe(`/app/hec-api/v1.0${path}`);
    response.end(JSON.stringify([{ synthetic: ["value", 7, null, false] }]));
  });
  const result = await cli.run(["exception", "list", kind, ...flags]);
  expect(result.code, result.output).toBe(0);
  expect(result.data).toMatchObject({ exceptions: [{ synthetic: ["value", 7, null, false] }], responseSchema: "unverified", complete: true });
});

test.each([
  ["click-time", "/sectools/click_time_protection/exceptions", []],
  ["click-time", "/sectools/click_time_protection/exceptions/items", ["--items"]],
  ["malware", "/sectool-exceptions/checkpoint2/exceptions/hash", ["--type", "hash"]],
  ["url", "/sectool-exceptions/avanan_url/exceptions/allow-url", ["--type", "allow-url"]],
  ["dlp", "/sectool-exceptions/avanan_dlp/exceptions/text_content", ["--type", "text_content"]],
] as [string, string, string[]][])("%s show encodes values as one path segment", async (kind, path, flags) => {
  const value = "https://example.com/a?x=1#text /%";
  const cli = await setup((request, response) => {
    expect(request.url).toBe(`/app/hec-api/v1.0${path}/${encodeURIComponent(value)}`);
    response.end(JSON.stringify({ responseEnvelope: { responseCode: 200 }, responseData: { synthetic: "detail" } }));
  });
  expect((await cli.run(["exception", "show", kind, value, ...flags])).data).toEqual({ exception: [{ synthetic: "detail" }], responseSchema: "unverified" });
});

test.each([[undefined, ""], [100, ""], [undefined, "synthetic-scroll"]])("exception lists disclose metadata requiring undocumented continuation: %s %s", async (total, scrollId) => {
  const cli = await setup((_request, response) => response.end(JSON.stringify({ ...page,
    responseEnvelope: { responseCode: 200, totalRecordsNumber: total, scrollId } })));
  const result = await cli.run(["exception", "list", "spam-allow"]);
  expect(result.data.complete).toBe(total === undefined && !scrollId);
});

test("exception lists default to 50 and --all caps at 1000 without undocumented follow-up requests", async () => {
  let calls = 0;
  const cli = await setup((_request, response) => {
    calls++;
    response.end(JSON.stringify({ responseEnvelope: { responseCode: 200 }, responseData: Array.from({ length: 1001 }, () => page.responseData[0]) }));
  });
  const first = await cli.run(["exception", "list", "phishing-allow"]);
  expect(first.data).toMatchObject({ count: 50, complete: false });
  const all = await cli.run(["exception", "list", "phishing-allow", "--all"]);
  expect(all.data).toMatchObject({ count: 1000, complete: false });
  const limited = await cli.run(["exception", "list", "phishing-allow", "--limit", "2"]);
  expect(limited.data.count).toBe(2);
  expect(calls).toBe(3);
});

test("exception detail redacts before preview and --full restores long strings", async () => {
  const record = { ...page.responseData[0], comment: "synthetic-secret-sentinel " + "x".repeat(501), note: "synthetic-token-sentinel" };
  const cli = await setup((_request, response) => response.end(JSON.stringify({ ...page, responseData: record })));
  const preview = await cli.run(["exception", "show", "spam-allow", "synthetic-exception-1"]);
  expect(preview.data.exception.comment).toContain("truncated");
  expect(preview.output).not.toMatch(/synthetic-secret-sentinel|synthetic-token-sentinel/);
  const full = await cli.run(["exception", "show", "spam-allow", "synthetic-exception-1", "--full"]);
  expect(full.data.exception.comment).not.toContain("truncated");
  expect(full.output).not.toMatch(/synthetic-secret-sentinel|synthetic-token-sentinel/);
});

test("empty exception lists are explicit", async () => {
  const cli = await setup((_request, response) => response.end(JSON.stringify({ ...page, responseData: [], responseEnvelope: { responseCode: 200 } })));
  const result = await cli.run(["exception", "list", "spam-allow"]);
  expect(result.data).toMatchObject({ exceptions: [], count: 0, complete: true, help: ["No spam-allow exceptions found"] });
  expect((await cli.run(["exception", "show", "spam-allow", "synthetic-exception-1"])).data.error.code).toBe("NOT_FOUND");
});

test.each([
  ["list"], ["list", "unknown"], ["list", "malware"], ["list", "url", "--type", "hash"],
  ["list", "dlp", "--type", "allow-url"], ["list", "anomaly", "--type", "hash"],
  ["list", "spam-allow", "--items"], ["show", "spam-allow"], ["show", "spam-allow", "../escape"],
  ["show", "dlp", "..", "--type", "text_content"], ["list", "click-time", "--cursor", "synthetic"],
  ["list", "anomaly", "--limit", "0"], ["list", "anomaly", "--limit", "1001"],
  ["list", "anomaly", "--limit", "1", "--all"], ["show", "anomaly", "id", "--all"],
  ["list", "spam-allow", "--execute"], ["show", "malware", "id", "--type", "hash", "extra"],
])("invalid exception input fails before config: %j", async (...args) => {
  const local = localFixture();
  cleanups.push(local.cleanup);
  local.env.CHECKPOINT_AXI_CONFIG = "/missing/config.json";
  expect((await local.run(["exception", ...args])).code).toBe(2);
});

test("anomaly show refuses the unverified endpoint before config or authentication", async () => {
  const local = localFixture();
  cleanups.push(local.cleanup);
  local.env.CHECKPOINT_AXI_CONFIG = "/missing/config.json";
  expect((await local.run(["exception", "show", "anomaly", "synthetic-id"])).data).toMatchObject({ error: { code: "ENDPOINT_UNVERIFIED" } });
});

test.each([[null], [{}], [{ entityId: 123 }]])("documented exception families reject malformed records: %j", async (record) => {
  const cli = await setup((_request, response) => response.end(JSON.stringify({ ...page, responseData: [record] })));
  expect((await cli.run(["exception", "list", "spam-allow"])).data.error.code).toBe("RESPONSE_INVALID");
});
