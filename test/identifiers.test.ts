import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { identifierViolations } from "../scripts/check-identifiers.mjs";

test.each([
  ["customer" + ".com", "unapproved domain or internal host"],
  ["customer" + ".security", "unapproved domain or internal host"],
  ["mail" + ".internal", "unapproved domain or internal host"],
  [["12345678", "1234", "4234", "8234", "123456789abc"].join("-"), "non-synthetic UUID"],
  [["10", "0", "0", "1"].join("."), "non-synthetic IP address"],
])("identifier guard refuses non-synthetic identifiers: %s", (input, violation) => {
  expect(identifierViolations(input)).toContain(violation);
});

test("identifier guard accepts public gateways and reserved synthetic examples", () => {
  expect(identifierViolations("cloudinfra-gw.ca.portal.checkpoint.com user@example.test 192.0.2.1 00000000-0000-4000-8000-000000000001")).toEqual([]);
});

test("documentation and fixtures contain only approved identifiers", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/check-identifiers.mjs", import.meta.url))], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
});
