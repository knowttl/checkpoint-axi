import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test.each([
  "fetch('https://example.test')",
  "(await import('node:http')).get('http://example.test')",
  "(await import('node:https')).get('https://example.test')",
  "(await import('node:tls')).connect({host:'example.test',port:443})",
  "(await import('node:net')).connect({host:'127.0.0.1',port:443})",
  "(await import('node:dgram')).createSocket('udp4').send('x',53,'127.0.0.1')",
])("the offline guard denies network access in subprocesses: %s", (expression) => {
  const guard = fileURLToPath(new URL("./support/deny-network.mjs", import.meta.url));
  const child = spawnSync(process.execPath, ["--import", guard, "--input-type=module", "-e", expression], { encoding: "utf8", timeout: 5_000 });
  expect(child.status).not.toBe(0);
  expect(child.stderr).toContain("Network access is disabled during offline tests");
});
