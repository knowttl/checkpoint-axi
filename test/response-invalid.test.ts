import { expect, test } from "vitest";
import { responseInvalid } from "../src/response-invalid.js";

test("validation diagnostics mask tenant keys and never include their values", () => {
  const response = { responseData: [{ payload: { "sender@example.test": "private-content-sentinel", "line\nbreak": false, valid_key: [] } }] };
  const error = responseInvalid("Invalid response", response, [
    ["responseData", 0, "payload", "sender@example.test"],
    ["responseData", 0, "payload", "line\nbreak"],
    ["responseData", 0, "payload", "valid_key"],
    ["responseData", 0, "entityInfo"],
  ]);
  expect(error.message).toBe("Invalid response ($.responseData[0].payload.<key>: string; $.responseData[0].payload.<key>: boolean; $.responseData[0].payload.valid_key: array; $.responseData[0].entityInfo: missing)");
  expect(error.code).toBe("RESPONSE_INVALID");
});
