# Configuration

Configured `home` (also no arguments) shows up to five emails and five events from the past 24 hours.
Each resource is bounded by two HTTP requests including authentication, ten seconds and 8 MiB of JSON.
Inspect each summary's `status`, `count`, optional `total` and `complete`; a limited page is not a full inventory.
Empty summaries succeed; `status: partial` preserves the successful resource and reports the other's error code.
If both resources fail, the command exits 1 with the first structured error.
Use `home --offline` for local profile status without resolving secrets or calling the API.

Run `checkpoint-axi setup hooks` only on explicit request to install or repair user-level Claude Code and Codex SessionStart hooks and an OpenCode ambient context plugin.
Setup preserves unrelated settings, repeats without rewriting unchanged files and repairs executable paths after relocation.
It enables Codex's shared `[features].hooks` flag.
Failures exit 1 with `HOOK_SETUP_FAILED`, identify affected paths and may leave other integrations successfully installed; fix those paths and repeat setup.
The integration runs `checkpoint-axi-hook`, showing the same bounded read-only home view with a 25-second hook timeout.
No ordinary command writes agent configuration, and setup never changes profile permissions.

See [environment variables and platform defaults](../README.md#configuration) for the complete variable table.

`config path` reports platform paths without reading files.
Config defaults to `$XDG_CONFIG_HOME/checkpoint-axi/config.json` (or `~/.config/checkpoint-axi/config.json`) on Linux/macOS, and `%APPDATA%\checkpoint-axi\config.json` on Windows.
State defaults to `$XDG_STATE_HOME/checkpoint-axi` (or `~/.local/state/checkpoint-axi`), and `%LOCALAPPDATA%\checkpoint-axi` on Windows.
Windows ignores XDG variables.
XDG and Windows base-directory overrides must be absolute; relative values use the platform defaults.
If APPDATA or LOCALAPPDATA is absent or relative, the Windows defaults are `~/AppData/Roaming` and `~/AppData/Local` respectively.
No command discovers profile configuration from the current directory or writes profile configuration.
Only explicit `setup hooks` writes agent configuration.

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
The host-facing [credential schema](../axi-credential.schema.json) describes one strict profile.

Config precedence is `--config`, then `CHECKPOINT_AXI_CONFIG`, then the platform path.
Profile precedence is `--profile`, `CHECKPOINT_AXI_PROFILE`, complete env profile, config default, sole file profile, then an explicit missing/ambiguous error.
An env profile requires `CHECKPOINT_AXI_REGION`, `CHECKPOINT_AXI_CLIENT_ID` and `CHECKPOINT_AXI_CLIENT_SECRET` together; optional `CHECKPOINT_AXI_SAAS` and `CHECKPOINT_AXI_SCOPE` cannot stand alone.
File-selected metadata never mixes with env-profile fields, though an explicit SecretRef can name an environment variable.
Environment profiles always disable writes and downloads.
`CHECKPOINT_AXI_READ_ONLY` accepts `1`/`true` or `0`/`false` case-insensitively; any other value fails closed.
`CHECKPOINT_AXI_WRITE_LOG` overrides the write journal, defaulting to `writes.log` in the platform state directory.
An empty override uses that default.

POSIX reads reject symlinks, foreign ownership, group/other-writable config and any group/other access to secret files.
Secret file content is UTF-8 with a leading BOM and trailing whitespace removed.
On Windows, regular files and reparse points are checked without interpreting mode bits; `auth status`, `doctor` and email, event, task and exception API commands also verify a protected DACL for the current user, SYSTEM and Administrators.

## SaaS and scope

`saas` is one non-blank SaaS application name, not a gateway, host or authentication URL.
Obtain the exact API application name for your tenant from its administrator or Check Point support.
If omitted, it defaults to `office365_emails`, selecting Microsoft 365 email; choose the appropriate name when targeting another application.
`office365_emails` is valid; `https://example.test/auth` and `example.test/auth` are invalid because slash (`/`) is not allowed.
A profile takes one value, not a comma-separated list.
`doctor` and `email search` accept `--saas <name>` for a single-call override; `event list --saas <names>` accepts a comma-separated list.

`scope` is a download scope value supplied by your tenant administrator or Check Point support for the intended download.
Use printable ASCII with no spaces (characters `!` through `~`); comma-separated values are sent verbatim.
For example, `synthetic:scope` has a valid form, while `synthetic scope` does not; the example is not a tenant-authorized value.
There is no default: omitted means unset.
Do not guess a tenant-authorized value.
See [download requirements](downloads.md) for how email and attachment commands use scope, the remaining verification limits, and the separate download opt-in and output checks.

## Write and download permissions

File profiles are read-only by default.
Set `writes.allowWrites` to true and list each exact operation in the `writes` object's `operations` array only when that permission is intended.
Environment profiles cannot enable writes or downloads.
`CHECKPOINT_AXI_READ_ONLY=1` overrides all configured write permission.
Downloads require the separate `downloads.allow: true` file-profile opt-in.
See [operation gates](writes.md) and [download requirements](downloads.md); profile permission alone does not execute an operation.

