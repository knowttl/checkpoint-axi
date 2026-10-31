#!/usr/bin/env node
import { tryFastPath } from "axi-sdk-js/fast-path";
import { VERSION } from "./version.js";

// Hook installation is available only through the explicit setup command.
if (!tryFastPath(process.argv.slice(2), { version: VERSION })) {
  const { main } = await import("../dist/src/cli.js");
  await main(process.argv.length === 2 ? ["home"] : process.argv.slice(2));
}
