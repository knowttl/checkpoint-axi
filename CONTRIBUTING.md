# Contributing

Keep changes focused and describe the problem, consequence, fix, scope and verification in the pull request.
Follow [the design](docs/design.md) and use strict ESM, TypeScript and pnpm conventions from [package.json](package.json).
Keep domain data as JSON and encode TOON only at the CLI boundary.
Validate external data once, reject unknown command input, and use precise names.
Do not add arbitrary HTTP, free origins, credential flags or write-policy bypasses.
Do not refactor adjacent code or hand-edit generated artifacts or changelogs.

## Verification

Use Node.js 22.12 or later and pnpm through Corepack.
Install dependencies with `corepack pnpm install --frozen-lockfile --ignore-scripts`, then run these checks before review:

```sh
corepack pnpm run build
corepack pnpm run lint
corepack pnpm test
corepack pnpm run spec:check
corepack pnpm run docs:check
corepack pnpm run identifiers:check
```

Automated checks must work offline with synthetic data, the network-deny guard and isolated HOME/XDG/agent directories.
The test command builds and typechecks, then selects tests affected by changes since the merge base with `origin/main`, including tracked working changes and untracked files.
It always runs the packaged CLI, profile safety, network guard and identifier guard baseline.
Changes to package metadata, lockfile, TypeScript/Vitest config, scripts, test support, fixtures, inventory or no-mistakes configuration run the full suite.
The selector fails if it cannot compute the merge base or find the safety baseline.
Test real outcomes through the CLI or module's public interface; mock only network, clock, randomness or platform ACL boundaries.
Repeat tests that touch async work or I/O after fixing failures.
Never use a live tenant, customer identifiers or real credentials.
Hosted pull-request test CI is deliberately absent; `.no-mistakes.yaml` declares `no_ci: true`.

After catalogue changes, build and run `docs:generate`, then `docs:check`.
After an explicit PDF review, update the source pin and design ledger, run `spec:generate`, then `node scripts/specs.mjs --check --pdf <local-path>`.
Tenable commits its JSON specification snapshots; this project does not commit the Check Point PDF because redistribution permission has not been established.
The default specification check verifies local provenance and generated inventory without fetching the PDF.

## Public repository hygiene

Never commit secrets, authorization headers, tenant responses, customer identifiers, private paths or internal infrastructure details.
Use synthetic examples and page-cited public API facts.
Run the identifier guard and review the staged diff before committing.
Keep process notes outside git, each full Markdown sentence on its own line, and use plain dashes.
Do not add agent co-author trailers automatically.

## Releases

The package version, release manifest, changelog and tags record released versions.
Release-please prepares subsequent versions from conventional commits without a one-time `release-as` override.
The only hosted workflow is `release-please.yml`; pull-request test workflows are deliberately absent.
Release publication runs build, lint, offline tests and metadata checks, then publishes a verified tarball with npm OIDC trusted publishing and provenance.
No npm publishing token is used.
Do not hand-edit the changelog or generated release artifacts.
