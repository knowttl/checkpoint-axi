# checkpoint-axi

Inspect Check Point Email Security through compact, guarded AXI commands

[![npm](https://img.shields.io/npm/v/@knowttl/checkpoint-axi)](https://www.npmjs.com/package/@knowttl/checkpoint-axi) [![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Node](https://img.shields.io/node/v/@knowttl/checkpoint-axi)](package.json) [![Provenance](https://img.shields.io/badge/npm-provenance-blue)](https://www.npmjs.com/package/@knowttl/checkpoint-axi#provenance) [![AXI](https://img.shields.io/badge/AXI-agent%20experience-blue)](https://github.com/knowttl)

[Why](#why-this-exists) | [Quickstart](#quickstart) | [Agents](#use-with-your-agent) | [Coverage](#what-it-covers) | [Safety](#safety) | [Configuration](#configuration) | [Output](#output-and-exit-codes) | [Troubleshooting](#troubleshooting) | [Contributing](#contributing) | [Security](#security) | [License](#license)

## Why this exists

Check Point Email Security (Harmony Email & Collaboration) exposes a large API with inconsistent examples and undocumented response shapes.
Agents need bounded results and explicit uncertainty to avoid guessing routes or replaying disruptive actions.
This CLI returns compact TOON, redacts secret-derived text and provides next-step hints.
Reads have request, byte and time budgets; writes require exact permission, confirmation and durable intent.
Live API contracts still require manual verification; offline fixtures do not establish live compatibility.

## Quickstart

Requires Node.js 22.12 or later.
Install and open the local home view, which needs no credentials or network:

```sh
npm install --global @knowttl/checkpoint-axi
checkpoint-axi
# Or without a global install:
npx -y @knowttl/checkpoint-axi
```

A fresh home view includes `status: not configured` and `count: 0`.
For a read-only environment profile, supply `CHECKPOINT_AXI_CLIENT_SECRET` through your secret manager or private environment before running:

```sh
export CHECKPOINT_AXI_REGION=eu
export CHECKPOINT_AXI_CLIENT_ID=synthetic-client
checkpoint-axi auth status
checkpoint-axi doctor
checkpoint-axi email search --limit 5
```

Replace the synthetic client ID with your API client ID.
`auth status` checks credentials locally; `doctor` authenticates and reads one search page without printing email data.
Use [file profiles](docs/configuration.md) for named credentials and write/download permissions.

## Use with your agent

`checkpoint-axi-hook` is the session entry point: configure your agent's session-start hook to run it on explicit request.
It emits local home context, grants no permissions and makes no API calls.
There is no automatic hook installer or `setup hooks` command.
To remove it, delete the hook entry you added in your agent configuration.

For on-demand discovery, install the skill:

```sh
npx skills add knowttl/checkpoint-axi --skill checkpoint-axi
```

The skill supplies static guidance and the full command table; it grants no credentials or write permission.
Use the hook, the skill or both; neither is required for ordinary CLI use.
Start investigations with the compact [agent guide](docs/agent-guide.md), linked from [SKILL.md](skills/checkpoint-axi/SKILL.md).
Use the [command reference](docs/commands.md) for the full catalogue.

## What it covers

<!-- command-registry:start -->
| Group | Purpose | Access | Reference |
|---|---|---|---|
| attachment | Save hash-verified attachments or ZIPs to new private files | Read / local file write | [Guide](docs/downloads.md) |
| auth | Validate local credential readiness without API calls | Local read | [Guide](docs/configuration.md) |
| config | Show effective configuration and state paths | Local read | [Guide](docs/configuration.md) |
| doctor | Verify authentication and one bounded search | API read | [Guide](docs/reads.md#doctor-and-transport) |
| email | Search, inspect and download emails; preview or request quarantine/restore | Read / gated write / local file write | [Guide](docs/reads.md#email-reads) |
| event | Inspect events and request available name-only actions | Read / gated write | [Guide](docs/writes.md#event-actions) |
| exception | Inspect eight kinds; preview or request supported rule changes | Read / gated write | [Guide](docs/writes.md) |
| home | Show local profile context without resolving secrets | Local read | [Guide](docs/configuration.md) |
| profile | List named file profiles | Local read | [Guide](docs/configuration.md) |
| task | Inspect asynchronous action status without polling | Read | [Guide](docs/reads.md#event-and-task-reads) |
<!-- command-registry:end -->

The command catalogue generates this overview and the full references.
Run `checkpoint-axi <command> --help` for the selected command's flags.
The [coverage ledger](docs/design.md#api-coverage-ledger) records documented routes and refused operations; it never enables execution.

## Safety

Read-only by default: file profiles must explicitly enable `writes.allowWrites` and each exact operation.
Previews also require these permissions; no wildcard or environment-only profile grants writes.
Execution requires `--execute` and the preview's exact `--confirm`, with durable redacted intent before one send.
`CHECKPOINT_AXI_READ_ONLY=1` overrides write permission; invalid values fail closed.
There is no `CHECKPOINT_AXI_ALLOW_*` environment gate.
Ambiguous outcomes are never retried; reconcile using reads before requesting another action.
Downloads separately require file-profile `downloads.allow`, a new private output file and verified SHA-256.
Secrets use environment/file SecretRefs, never inline config values or argv; tokens stay in memory.
Only seven fixed public regional gateways are allowed, with verified TLS and no redirects.
See [write gates and reconciliation](docs/writes.md), [download safety](docs/downloads.md) and [profile permissions](docs/configuration.md#write-and-download-permissions).

## Configuration

No command writes configuration or discovers it from the current directory.
Use `checkpoint-axi config path` to print the effective paths.

| Platform | Default config | Default state directory |
|---|---|---|
| Linux/macOS | `~/.config/checkpoint-axi/config.json` | `~/.local/state/checkpoint-axi` |
| Windows | `%APPDATA%\checkpoint-axi\config.json` | `%LOCALAPPDATA%\checkpoint-axi` |

Config precedence: `--config`, `CHECKPOINT_AXI_CONFIG`, platform path.
Profile precedence: `--profile`, `CHECKPOINT_AXI_PROFILE`, complete environment profile, config default, sole file profile.
File metadata never mixes with environment-profile fields; SecretRefs may explicitly name environment variables.

| Environment variable | Purpose | Default |
|---|---|---|
| `CHECKPOINT_AXI_CONFIG` | Config file override | Platform path |
| `CHECKPOINT_AXI_PROFILE` | Named file profile | Selection order above |
| `CHECKPOINT_AXI_REGION` | Environment-profile region | Required with client ID/secret |
| `CHECKPOINT_AXI_CLIENT_ID` | Environment-profile client ID | Required with region/secret |
| `CHECKPOINT_AXI_CLIENT_SECRET` | Environment secret source | Default SecretRef; required for env profile |
| `CHECKPOINT_AXI_SAAS` | Environment-profile SaaS | `office365_emails` |
| `CHECKPOINT_AXI_SCOPE` | Environment-profile download scope | Unset |
| `CHECKPOINT_AXI_READ_ONLY` | Force read-only: `1`/`true`; `0`/`false` releases override | Unset |
| `CHECKPOINT_AXI_WRITE_LOG` | Write journal path | State directory's `writes.log`; blank uses default |
| `XDG_CONFIG_HOME` | Absolute config base on Linux/macOS | `~/.config` |
| `XDG_STATE_HOME` | Absolute state base on Linux/macOS | `~/.local/state` |
| `APPDATA` | Absolute Windows config base | `~/AppData/Roaming` |
| `LOCALAPPDATA` | Absolute Windows state base | `~/AppData/Local` |

Windows ignores XDG variables; relative base-directory overrides use platform defaults.
SecretRefs may name additional environment variables.
See [configuration](docs/configuration.md) for JSON, file protection, supported regions and scope handling, and the [credential schema](axi-credential.schema.json).

## Output and exit codes

Output, including structured errors and next-step hints, is TOON.
Secret-derived strings are redacted before 500-character previews; `--full` restores complete strings and `--fields` selects top-level output fields where supported.
Never replay a mutation to recover truncated output.
Searches default to 50 rows over 24 hours; `--all` caps rows at 1000 within transport budgets.
Inspect `complete`, `reason` and `cursor`; see [read continuation](docs/reads.md#email-reads) for page replay limitations.
Bare `--version`, `-v` or `-V` prints the package version.

| Exit | Meaning |
|---|---|
| 0 | Success, preview or no-op |
| 1 | Configuration, authentication, transport or operation failure |
| 2 | Invalid command syntax or flags (`VALIDATION_ERROR`) |

## Troubleshooting

| Code | Next action |
|---|---|
| `PROFILE_REQUIRED` | Configure a complete environment profile or a named file profile. |
| `CONFIG_INSECURE` | Apply the [private-file permissions](docs/configuration.md) for your platform. |
| `AUTH_SHAPE_UNVERIFIED` | Verify the undocumented token contract manually; never paste the response into chat. |
| `ENDPOINT_UNVERIFIED` | Read the [operation limitations](docs/writes.md); the CLI refuses to guess. |
| `OUTCOME_UNKNOWN` | Reconcile with read commands and the journal; never replay automatically. |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for offline development checks and release mechanics, and [AGENTS.md](AGENTS.md) for repository boundaries.

## Security

Report vulnerabilities using [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE).
