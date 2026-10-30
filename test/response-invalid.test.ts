import { expect, test } from "vitest";
import { responseInvalid, ResponseInvalidError } from "../src/response-invalid.js";

test("validation diagnostics mask tenant keys and never include their values", () => {
  const response = { responseData: [{ payload: { "sender@example.test": "private-content-sentinel", "line\nbreak": false, valid_key: [] } }] };
  const error = responseInvalid("Invalid response", response, [
    ["responseData", 0, "payload", "sender@example.test"],
    ["responseData", 0, "payload", "line\nbreak"],
    ["responseData", 0, "payload", "valid_key"],
    ["responseData", 0, "entityInfo"],
  ]);
  expect(error.message).toBe("Invalid response");
  expect((error as ResponseInvalidError).diagnostics).toMatchObject({ issues: [
    { path: '$["responseData"][*]["payload"]["<key>"]', received: "string" },
    { path: '$["responseData"][*]["payload"]["<key>"]', received: "boolean" },
    { path: '$["responseData"][*]["payload"]["valid_key"]', received: "array" },
    { path: '$["responseData"][*]["entityInfo"]', received: "undefined" },
  ] });
  expect(JSON.stringify(error)).not.toMatch(/sender@example|line\\nbreak|private-content-sentinel/);
  expect(error.code).toBe("RESPONSE_INVALID");
});
