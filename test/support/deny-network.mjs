import net from "node:net";
import dgram from "node:dgram";
import { syncBuiltinESMExports } from "node:module";

const stateKey = Symbol.for("checkpoint-axi.test-network");
const state = globalThis[stateKey] ??= { ports: new Set(), connect: net.Socket.prototype.connect };
const deny = () => { throw new Error("Network access is disabled during offline tests"); };
net.Socket.prototype.connect = function (...args) {
  const values = Array.isArray(args[0]) ? args[0] : args;
  const options = values[0];
  const port = typeof options === "object" ? options.port : options;
  const host = typeof options === "object" ? options.host : values[1];
  if (host !== "127.0.0.1" || !state.ports.has(Number(port))) return deny();
  return state.connect.apply(this, args);
};
dgram.Socket.prototype.send = deny;
globalThis.fetch = deny;
syncBuiltinESMExports();

// A later slice's loopback gateway must hold the listening server to register a port.
export function allowFakeServer(server) {
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== "127.0.0.1") return deny();
  state.ports.add(address.port);
  return () => state.ports.delete(address.port);
}
