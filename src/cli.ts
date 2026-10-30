import { AxiError, runAxiCli } from "axi-sdk-js";
import { encode } from "@toon-format/toon";
import { DESCRIPTION } from "./catalogue.js";
import { credentialStore, type CredentialContext } from "./profiles.js";
import { localCommand } from "./local-commands.js";
import type { gateway } from "./transport.js";
import { ResponseDiagnostics } from "./response-diagnostics.js";
import { responseErrorDetails } from "./response-invalid.js";

export async function main(argv = process.argv.slice(2), options: { credentials?: CredentialContext; transport?: Parameters<typeof gateway>[3]; stdout?: { write: (chunk: string) => unknown } } = {}): Promise<void> {
  const store = credentialStore(options.credentials);
  const diagnostics = new ResponseDiagnostics(store.redactor, ["RESPONSE_INVALID"]);
  await runAxiCli({
    description: DESCRIPTION,
    argv: ["local"],
    topLevelHelp: "",
    home: () => localCommand([], store),
    stdout: { write: (chunk) => (options.stdout ?? process.stdout).write(store.redactor.text(chunk)) },
    formatError: (error) => ({
      output: `${encode(store.redactor.value(error instanceof AxiError
        ? { error: { code: error.code, message: error.message, ...responseErrorDetails(error, diagnostics) }, help: error.suggestions }
        : { error: { code: "CONFIG_INVALID", message: "Command could not complete" }, help: ["Check local configuration; run checkpoint-axi config path"] }))}\n`,
      exitCode: error instanceof AxiError && error.code === "VALIDATION_ERROR" ? 2 : 1,
    }),
    commands: { local: async () => store.redactor.value(await localCommand(argv, store, { ...options.transport, diagnostics })) as Record<string, unknown> },
  });
}
