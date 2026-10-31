import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, createServer } from "node:https";
import { connect, type ConnectionOptions } from "node:tls";
import type { IncomingMessage, ServerResponse } from "node:http";
import { allowFakeServer } from "./deny-network.ts";

export async function fakeGateway(handler: (request: IncomingMessage, response: ServerResponse, body: unknown) => void, trusted = true) {
  const directory = mkdtempSync(join(tmpdir(), "checkpoint-axi-tls-"));
  const key = join(directory, "key.pem"), cert = join(directory, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", key, "-out", cert,
    "-subj", "/CN=cloudinfra-gw.portal.checkpoint.com", "-addext", "subjectAltName=DNS:cloudinfra-gw.portal.checkpoint.com"], { stdio: "ignore" });
  const certificate = readFileSync(cert);
  const server = createServer({ key: readFileSync(key), cert: certificate }, (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => handler(request, response, chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const unregister = allowFakeServer(server);
  const port = (server.address() as { port: number }).port;
  class LoopbackAgent extends Agent {
    override createConnection(options: ConnectionOptions) {
      return connect({ ...options, host: "127.0.0.1", port, ...(trusted ? { ca: certificate } : {}) });
    }
  }
  const agent = new LoopbackAgent();
  return { agent, unref: () => server.unref(), close: async () => {
    agent.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    unregister();
    rmSync(directory, { recursive: true, force: true });
  } };
}
