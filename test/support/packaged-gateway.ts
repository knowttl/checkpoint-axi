import https from "node:https";
import { readFileSync } from "node:fs";
import { fakeGateway } from "./fake-gateway.ts";

const scenario = process.env.PACKAGED_GATEWAY_SCENARIO;
const fixture = (name: string): {
  responseData: Record<string, unknown>[];
  responseEnvelope: { totalRecordsNumber: number; scrollId?: string };
} => JSON.parse(readFileSync(new URL(`../fixtures/${name}-page.json`, import.meta.url), "utf8"));
const gateway = await fakeGateway((request, response) => {
  const path = request.url;
  let value: ReturnType<typeof fixture> | { token: string };
  if (scenario === "deny") throw new Error("Unexpected API call");
  if (path === "/auth/external") {
    response.statusCode = scenario === "auth-failed" ? 401 : 200;
    value = { token: "synthetic-packaged-token" };
  } else if (path === "/app/hec-api/v1.0/search/query") {
    response.statusCode = scenario === "email-failed" ? 503 : 200;
    value = fixture(scenario === "empty" ? "search" : "email");
    if (scenario === "bounded") {
      value.responseData = Array.from({ length: 8 }, (_, index) => ({ ...(value as ReturnType<typeof fixture>).responseData[0],
        entityInfo: { entityId: `synthetic-email-${index}`, entityActionState: "quarantined" } }));
      value.responseEnvelope.totalRecordsNumber = 8;
    }
    if (scenario === "budget") {
      value.responseEnvelope.scrollId = "synthetic-scroll";
      value.responseEnvelope.totalRecordsNumber = 2;
    }
    if (scenario === "invalid") value.responseData = [{ unexpected: "schema-invalid" }];
  } else if (path === "/app/hec-api/v1.0/event/query") {
    response.statusCode = scenario === "partial" ? 503 : 200;
    value = fixture(scenario === "empty" ? "search" : "event");
  } else throw new Error(`Unexpected API route ${path}`);
  response.end(JSON.stringify(value));
});
https.globalAgent = gateway.agent;
gateway.unref();
process.once("beforeExit", () => { void gateway.close(); });
