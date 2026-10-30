# Contributing agents

Use Node.js 22.12 or later and pnpm through Corepack.
Run `corepack pnpm run build`, `corepack pnpm run lint`, `corepack pnpm test`, `corepack pnpm run spec:check`, `corepack pnpm run docs:check`, and `corepack pnpm run identifiers:check`.
`.no-mistakes.yaml` separates preparation, tests and lint.
Do not add hosted test workflows; only release publication runs on GitHub.

## Layout and boundaries

`src/catalogue.ts` owns executable commands and generated command documentation.
`src/profiles.ts` owns strict profile selection and SecretRefs; `src/private-file.ts` owns file read security.
`docs/design.md` owns security invariants and planned slices.
`inventory/specs.json` pins the vendor PDF URL and byte hash; the PDF is not redistributed.
The planned inventory never enables execution.
Only the seven public region gateways are allowed; never introduce a free origin or arbitrary HTTP.
Secrets never enter argv or output, and tokens belong only in memory.
Writes must require operation scope, preview, exact confirmation and durable redacted intent; forced read-only always wins.

## Tests and public repository hygiene

Tests use synthetic fixtures and deny external network access.
`scripts/isolated.mjs` isolates HOME, XDG directories and agent configuration.
`scripts/test-changes.mjs` runs affected tests plus a fixed safety baseline; shared infrastructure changes run the full suite.
Canonical source: knowttl/bstack revision feeccb1e6f1ae119bf4c74277c8bad328b05afe8, skills/verification/references/testing.md.
<!-- BEGIN canonical test-quality rules -->
**Test quality.** Write and review every test against these rules.
Tests are never required first; a change is verified end to end against the behaviour the user expects.

1. Trust upstream invariants: do not test states that types, schemas or database constraints already rule out.
   Test invalid input only at the boundary that validates it.
2. Assert outcomes from an agreed source (spec, domain rule, ground-truth fixture), never values copied from what the code returns today.
3. Mock only true external boundaries, with schema-valid or recorded payloads.
   Never mock in-process code.
   Delete tests that only check how a mock was set up or called, unless that call is the requirement.
4. Test through the public interface: no private helpers, internal state or internal call counts.
5. Every assertion must be able to fail when the behaviour breaks: no existence-, type- or constant-only assertions.

Exempt: validation-boundary tests, contract tests against an agreed schema or recording, and regression tests that cite the bug they reproduce.
<!-- END canonical test-quality rules -->

Never use live tenants, credentials, customer domains, tenant identifiers or internal hosts in code, fixtures, docs or pull requests.
Keep process notes outside git.
Generate documentation and inventory with the scripts; never hand-edit generated files or changelogs.
Keep each full Markdown sentence on its own line and use plain dashes.
