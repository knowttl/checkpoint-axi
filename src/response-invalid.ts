import { AxiError } from "axi-sdk-js";
import { ResponseDiagnostics } from "./response-diagnostics.js";

export class ResponseInvalidError extends AxiError {
  readonly diagnostics: Record<string, unknown>;

  constructor(message: string, value: unknown, paths: readonly (readonly PropertyKey[])[]) {
    super(message, "RESPONSE_INVALID", ["Check API compatibility using the bounded shape, issue paths, HTTP status and content type before retrying"]);
    const diagnostics = new ResponseDiagnostics({ text: (text) => text }, ["RESPONSE_INVALID"]);
    diagnostics.record(0, new Headers(), value);
    diagnostics.validationFailed(paths.map((path) => ({ path })));
    const { status: _status, contentType: _contentType, ...details } = diagnostics.forError(this);
    this.diagnostics = details;
  }
}

// Never format validator messages or received values: both may contain tenant data.
export function responseInvalid(message: string, value: unknown, paths: readonly (readonly PropertyKey[])[]): AxiError {
  return new ResponseInvalidError(message, value, paths);
}

export function responseErrorDetails(error: unknown, diagnostics?: ResponseDiagnostics): Record<string, unknown> {
  if (!(error instanceof AxiError)) return {};
  if (error.code === "OUTCOME_UNKNOWN" && error.cause) return responseErrorDetails(error.cause, diagnostics);
  return { ...diagnostics?.forError(error), ...(error instanceof ResponseInvalidError ? error.diagnostics : {}) };
}
