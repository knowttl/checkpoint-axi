import type { Server } from "node:net";
export function allowFakeServer(server: Server): () => void;
