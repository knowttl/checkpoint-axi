import { AxiError } from "axi-sdk-js";
import type { credentialStore } from "./profiles.js";
import { gateway } from "./transport.js";
import { responseErrorDetails } from "./response-invalid.js";

export async function doctor(store: ReturnType<typeof credentialStore>, config?: string, selected?: string, override?: string, transport?: Parameters<typeof gateway>[3]): Promise<Record<string, unknown>> {
  store.readOnly();
  const profile = store.select(store.load(config, true).config, selected);
  const saas = override?.trim() ?? profile.saas;
  if (!saas) throw new AxiError("--saas must not be blank", "VALIDATION_ERROR", ["Run checkpoint-axi doctor --help"]);
  const api = gateway(profile, store.credentials(profile, true), store.redactor, transport);
  const checks: { check: string; pass: boolean; code?: string }[] = [];
  for (const check of ["auth", "read"] as const) {
    try {
      if (check === "auth") await api.authenticate();
      else {
        const end = new Date();
        // One page of the default 24-hour window, not an --all scan (guide pages 18-21).
        await api.read({ path: "/search/query", body: { entityFilter: { saas,
          startDate: new Date(end.getTime() - 86_400_000).toISOString(), endDate: end.toISOString() } } });
      }
      checks.push({ check, pass: true });
    } catch (error) {
      checks.push({ check, pass: false, code: error instanceof AxiError ? error.code : "API_ERROR", ...responseErrorDetails(error, transport?.diagnostics) });
      if (check === "auth") checks.push({ check: "read", pass: false, code: "AUTH_NOT_PASSED" });
      break;
    }
  }
  const pass = checks.every((check) => check.pass);
  if (!pass) process.exitCode = 1;
  return { region: profile.region, saas, checks, pass, ...(!pass ? { help: [
    "Check the regional credentials and API access; AUTH_SHAPE_UNVERIFIED requires owner commissioning of the undocumented token response (guide page 8)",
    "Run checkpoint-axi auth status to check local credential readiness; never share credentials or raw API responses",
  ] } : {}) };
}
