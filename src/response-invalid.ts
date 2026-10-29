import { AxiError } from "axi-sdk-js";

// Never format validator messages or received values: both may contain tenant data.
export function responseInvalid(message: string, value: unknown, paths: readonly (readonly PropertyKey[])[]): AxiError {
  const failures = paths.map((path) => {
    let received = value;
    let location = "$";
    for (const key of path) {
      location += typeof key === "number" ? `[${key}]`
        : `.${typeof key === "string" && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : "<key>"}`;
      received = received !== null && typeof received === "object" && Object.hasOwn(received, key)
        ? (received as Record<PropertyKey, unknown>)[key] : undefined;
    }
    const type = received === undefined ? "missing" : received === null ? "null" : Array.isArray(received) ? "array" : typeof received;
    return `${location}: ${type}`;
  });
  return new AxiError(`${message} (${[...new Set(failures)].join("; ")})`, "RESPONSE_INVALID", []);
}
