import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { decode } from "@toon-format/toon";
import { main } from "../src/cli.js";
import { localFixture } from "./support/local-cli.js";
import { fakeGateway } from "./support/fake-gateway.js";

// The generated guide is a public artifact: execute its examples, not a copy.
const guide = readFileSync(new URL("../docs/agent-guide.md", import.meta.url), "utf8");
const examples = [...guide.matchAll(/```sh\n([\s\S]*?)```/g)]
  .flatMap((block) => block[1]!.trim().split("\n"));
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}-page.json`, import.meta.url), "utf8"));

test.each(examples)("agent guide example succeeds offline: %s", async (command) => {
  const local = localFixture();
  local.env.CHECKPOINT_AXI_READ_ONLY = "1";
  const task = fixture("task");
  task.responseData.id = "synthetic-task-1";
  const routes: Record<string, unknown> = {
    "/auth/external": { token: "synthetic-token-sentinel" },
    "/app/hec-api/v1.0/search/query": fixture("email"),
    "/app/hec-api/v1.0/search/entity/synthetic-email-1": fixture("email"),
    "/app/hec-api/v1.0/event/query": fixture("event"),
    "/app/hec-api/v1.0/event/synthetic-event-1": fixture("event"),
    "/app/hec-api/v1.0/task/synthetic-task-1": task,
    "/app/hec-api/v1.0/exceptions/blacklist": fixture("exception"),
    "/app/hec-api/v1.0/exceptions/blacklist/synthetic-exception-1": fixture("exception"),
  };
  const server = await fakeGateway((request, response) => {
    const page = routes[request.url!];
    response.statusCode = page === undefined ? 404 : 200;
    response.end(JSON.stringify(page ?? {}));
  });
  try {
    let output = "";
    process.exitCode = 0;
    await main(command.split(" ").slice(1), {
      credentials: local.context, transport: { agent: server.agent },
      stdout: { write: (chunk) => { output += chunk; } },
    });
    expect(process.exitCode, output).toBe(0);
    expect(decode(output)).not.toHaveProperty("error");
    expect(output).not.toContain("synthetic-secret-sentinel");
    expect(output).not.toContain("synthetic-token-sentinel");
  } finally {
    process.exitCode = 0;
    await server.close();
    local.cleanup();
  }
});
