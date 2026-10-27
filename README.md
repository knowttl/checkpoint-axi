# checkpoint-axi

An agent-facing CLI for Check Point Email Security (Harmony Email & Collaboration), modelled on the knowttl AXI tools.
This is slice C1 of 12: an offline scaffold with local profile discovery and validation.
There are no Check Point API calls, live health checks, downloads or remote writes in this slice.
The full API surface and later Artium integration are tracked in [the design](docs/design.md).

## Local use

Requires Node.js 22.12 or later and pnpm through Corepack.

```sh
corepack pnpm install --frozen-lockfile --ignore-scripts
corepack pnpm run build
node bin/checkpoint-axi.js
node bin/checkpoint-axi.js config path
node bin/checkpoint-axi.js profile list
node bin/checkpoint-axi.js auth status --help
```

Output is TOON; errors use stable codes and exit 1, while invalid input exits 2.
Bare `--version`, `-v` and `-V` print the version without loading the command graph.
Strings have 500-character previews; `--full` returns complete strings and `--fields` selects output fields.

<!-- command-registry:start -->
| Command | Purpose |
|---|---|
| `checkpoint-axi auth status` | Validate the selected local profile and secret source without API calls |
| `checkpoint-axi config path` | Show config and state paths without reading files; --profile does not affect paths |
| `checkpoint-axi home` | Show local profile context without resolving secrets or making API calls |
| `checkpoint-axi profile list` | List file profiles without resolving secrets; --profile does not filter this list |
<!-- command-registry:end -->

## Profiles

`config path` reports platform paths without reading files.
Config defaults to `$XDG_CONFIG_HOME/checkpoint-axi/config.json` (or `~/.config/checkpoint-axi/config.json`) on Linux/macOS, and `%APPDATA%\checkpoint-axi\config.json` on Windows.
State defaults to `$XDG_STATE_HOME/checkpoint-axi` (or `~/.local/state/checkpoint-axi`), and `%LOCALAPPDATA%\checkpoint-axi` on Windows.
Windows ignores XDG variables.
No command discovers config from the current directory or writes configuration in C1.

Create a config file with this synthetic shape and protect it from group/other writes:

```json
{
  "version": 1,
  "defaultProfile": "example",
  "profiles": {
    "example": {
      "region": "eu",
      "clientId": "synthetic-client",
      "clientSecret": { "env": "CHECKPOINT_AXI_CLIENT_SECRET" },
      "saas": "office365_emails",
      "downloads": { "allow": false },
      "writes": { "allowWrites": false, "operations": [] }
    }
  }
}
```

Supply the secret through your environment or an absolute private file SecretRef, never chat, argv or an inline config value.
Omitting `clientSecret` defaults its reference to `CHECKPOINT_AXI_CLIENT_SECRET`.
`auth status` resolves the selected reference locally and reports only its kind (`env` or `file`); it never prints the value, client ID, variable name or secret file path.
It confirms local readiness, not API authentication.
`profile list` and home never resolve secret files.
Supported regions are `us`, `eu`, `ca`, `au`, `uk`, `uae` and `in`; there is no origin override.
Optional `saas` defaults to `office365_emails`, and optional `scope` is reserved for downloads.
The host-facing [credential schema](axi-credential.schema.json) describes one strict profile.

Config precedence is `--config`, then `CHECKPOINT_AXI_CONFIG`, then the platform path.
Profile precedence is `--profile`, `CHECKPOINT_AXI_PROFILE`, complete env profile, config default, sole file profile, then an explicit missing/ambiguous error.
An env profile requires `CHECKPOINT_AXI_REGION`, `CHECKPOINT_AXI_CLIENT_ID` and `CHECKPOINT_AXI_CLIENT_SECRET` together; optional `CHECKPOINT_AXI_SAAS` and `CHECKPOINT_AXI_SCOPE` cannot stand alone.
File-selected metadata never mixes with env-profile fields, though an explicit SecretRef can name an environment variable.
Environment profiles always disable writes and downloads.
`CHECKPOINT_AXI_READ_ONLY` accepts `1`/`true` or `0`/`false` case-insensitively; any other value fails closed.
`CHECKPOINT_AXI_WRITE_LOG` reserves the later write-journal path override; C1 creates no journal.

POSIX reads reject symlinks, foreign ownership, group/other-writable config and any group/other access to secret files.
Secret file content is UTF-8 with a leading BOM and trailing whitespace removed.
On Windows, regular files and reparse points are checked without interpreting mode bits; `auth status` also verifies a protected DACL for the current user, SYSTEM and Administrators.

## Agent discovery

`checkpoint-axi-hook` emits local home context and does not install integrations or make API calls.
Use it only when explicitly configuring a session hook.
The generated [skill](skills/checkpoint-axi/SKILL.md) is an alternative on-demand discovery path after publication:

```sh
npx skills add knowttl/checkpoint-axi --skill checkpoint-axi
```

Neither path is needed for ordinary CLI use.
Automatic hook installation and hosted Artium integration are not shipped by C1.

## Development and testing

```sh
corepack pnpm run build
corepack pnpm run lint
corepack pnpm test
corepack pnpm run spec:check
corepack pnpm run docs:check
corepack pnpm run identifiers:check
```

Tests deny external networking, isolate local configuration and exercise an installed tarball offline.
The affected-test selector includes the fixed safety baseline and runs the full suite for shared infrastructure changes.
To regenerate catalogue docs or the planned capability inventory:

```sh
corepack pnpm run build
corepack pnpm run docs:generate
corepack pnpm run spec:generate
```

`inventory/specs.json` pins the [vendor PDF](https://sc1.checkpoint.com/documents/Harmony_Email_and_Collaboration_API_Reference/CP_Check_Point_Email_Security_API_Reference_Guide.pdf) URL and byte hash.
The PDF is not redistributed because its redistribution permission has not been established.
The default check is offline and checks the ledger against generated metadata; it cannot recheck absent PDF bytes.
After downloading a copy outside git, verify its bytes explicitly:

```sh
node scripts/specs.mjs --check --pdf /absolute/path/to/guide.pdf
```

## Releases

The only hosted workflow is `release-please.yml`; no pull-request test workflow is configured.
The package and release manifest start at `0.0.0`, with the first release configured as `0.1.0`.
Release publication runs build, lint, offline tests and metadata checks, then publishes the verified tarball with npm OIDC trusted publishing and provenance.
The owner must register this package's trusted publisher for this repository and workflow before the first release.
No npm publishing token is used.
See [CONTRIBUTING.md](CONTRIBUTING.md) for testing and public-repository rules.
