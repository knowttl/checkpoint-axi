# checkpoint-axi

An agent-facing CLI for Check Point Email Security (Harmony Email & Collaboration), modelled on the knowttl AXI tools.
Slices C1-C9 of 12 ship local profile discovery, regional authentication, a bounded live `doctor` check, email search/detail reads, event/task reads, exception reads, gated email quarantine/restore, name-only event actions, Anti-Phishing/Spam exception writes and anomaly/click-time item writes.
Downloads, other writes and Artium integration arrive in later slices.
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

Output is TOON; errors use stable codes and exit 1, while invalid command syntax or flags exit 2.
Bare `--version`, `-v` and `-V` print the version without loading the command graph.
`--fields` selects output fields; see [email reads](#email-reads-c3) for string previews and continuation behavior.

<!-- command-registry:start -->
| Command | Purpose |
|---|---|
| `checkpoint-axi auth status` | Validate the selected local profile and secret source without API calls |
| `checkpoint-axi config path` | Show config and state paths without reading files; --profile does not affect paths |
| `checkpoint-axi doctor` | Check regional API authentication and one bounded email search without printing tenant data |
| `checkpoint-axi email quarantine` | Preview or request asynchronous email quarantine through the gated write coordinator (guide pages 28-30) |
| `checkpoint-axi email restore` | Preview or request asynchronous email restore through the gated write coordinator (guide pages 28-30) |
| `checkpoint-axi email search` | Search emails with a bounded date window and scroll continuation (API guide pages 18-27) |
| `checkpoint-axi email show` | Show one email with verdicts, actions and available actions (API guide pages 10-18) |
| `checkpoint-axi event action` | Preview or request a name-only event action; parameterized actions refuse ENDPOINT_UNVERIFIED pending commissioning (guide pages 35-37, 42-45) |
| `checkpoint-axi event list` | List security events with bounded scroll continuation (API guide pages 37-42) |
| `checkpoint-axi event show` | Show one event, actions taken and available actions (API guide pages 34-37) |
| `checkpoint-axi exception clear` | Refuse click-time clear with ENDPOINT_UNVERIFIED until commissioning provides a trustworthy pre-read count (guide pages 87-88, 96-97) |
| `checkpoint-axi exception create` | Preview or create one phishing-allow, phishing-block, spam-allow, anomaly or click-time exception; C9 response identities are unverified (guide pages 61-64, 75-78, 84-85, 91-93) |
| `checkpoint-axi exception list` | List bounded exceptions for phishing-allow, phishing-block, spam-allow, anomaly, click-time, malware, url or dlp (guide pages 49-123) |
| `checkpoint-axi exception remove` | Preview or remove one phishing-allow, phishing-block, spam-allow, anomaly rule or click-time item by ID (guide pages 67-69, 81-82, 85-87, 98-99) |
| `checkpoint-axi exception remove-items` | Preview or remove 1-20 click-time items by caller-supplied IDs; existence is unverified (guide pages 97-98) |
| `checkpoint-axi exception show` | Show an exception by kind and ID/value; anomaly refuses ENDPOINT_UNVERIFIED pending commissioning (guide pages 52-123) |
| `checkpoint-axi exception update` | Preview or replace one phishing-allow, phishing-block, spam-allow or click-time exception by ID; click-time is single-item only (guide pages 64-67, 78-81, 94-96) |
| `checkpoint-axi home` | Show local profile context without resolving secrets or making API calls |
| `checkpoint-axi profile list` | List file profiles without resolving secrets; --profile does not filter this list |
| `checkpoint-axi task show` | Show asynchronous task status and per-action details (API guide pages 30-33) |
<!-- command-registry:end -->

## Event actions (C7)

`checkpoint-axi event action --ids <id>[,<id>] --name <action>` previews an action against 1-20 unique events (guide pages 35-37, 42-45).
Enable `writes.allowWrites` and the exact `event.action.<name>` operation in the selected profile; forced read-only always wins.
Execution requires `--execute --confirm 'event.action.<name> <ids>'`, with IDs in the supplied order.
The C6 coordinator durably records intent, re-reads every event and sends one batch only if the action remains available on every target.
Accepted responses identify a task for every event; use `checkpoint-axi task show <taskId>` to inspect execution.
Ambiguous outcomes are never retried.

`event show <id>` lists all available actions, including parameterized actions deferred until live commissioning through Artium.
Nonempty `actionParameter` objects and repeated action names refuse `ENDPOINT_UNVERIFIED`, including during preview.
The guide exposes parameter objects on pages 36-37 but requires `eventActionParam` strings on page 43; C7 does not guess serialization or add a parameter selector.
Name-only actions send `eventActionParam: [""]`; this and all live-only behavior remain uncommissioned.

## Profiles

`config path` reports platform paths without reading files.
Config defaults to `$XDG_CONFIG_HOME/checkpoint-axi/config.json` (or `~/.config/checkpoint-axi/config.json`) on Linux/macOS, and `%APPDATA%\checkpoint-axi\config.json` on Windows.
State defaults to `$XDG_STATE_HOME/checkpoint-axi` (or `~/.local/state/checkpoint-axi`), and `%LOCALAPPDATA%\checkpoint-axi` on Windows.
Windows ignores XDG variables.
No command discovers config from the current directory or writes configuration.

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
Optional `saas` defaults to `office365_emails`; `doctor`, `email search` and `event list` accept `--saas <name>` to override it for that call.
Optional `scope` is reserved for downloads.
The host-facing [credential schema](axi-credential.schema.json) describes one strict profile.

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

## Doctor and commissioning

`checkpoint-axi doctor --profile <name>` explicitly contacts the selected public regional gateway.
It authenticates and runs one page of email search over the past 24 hours for the selected SaaS.
It reports region, SaaS and pass/fail for auth and read, without email data or credentials; a failed check exits 1.
Home, the hook, command help and `auth status` remain offline.
The owner will commission authentication and all other slices together through Artium after the full build (Q4).
Only a pass/fail commissioning note enters this public repository, never tenant identifiers, raw responses, secrets or tokens.
No commissioning run has been performed by the automated tests.

The vendor guide does not document the token response shape or lifetime (page 8).
The provisional parser accepts one distinct nonempty printable ASCII token without whitespace from `token`, `access_token` or `accessToken` at the root or within `data` or `responseData`.
Unsupported, conflicting or invalid values fail with `AUTH_SHAPE_UNVERIFIED`, requiring owner commissioning rather than printing the response.
Token persistence and reauthentication rules are defined in [the transport design](docs/design.md#credentials-and-transport).
All requests carry a new request UUID; authenticated API calls carry Bearer authorization.
TLS certificate verification stays enabled and redirects are refused.
Read sessions allow at most 10 HTTP requests; write sessions allow at most 44.
Both are bounded by 8 MiB of response bytes and 60 seconds, including auth, re-exchange, read retries and delays.
Reads retry HTTP 429 at most twice, honoring numeric or HTTP-date `Retry-After` within that budget.
Exception reads and writes share separate 1 request/second Anti-Phishing and 10 requests/second other-exception spacers.

## Email reads (C3)

`checkpoint-axi email search` reads compact ID, subject, action state and combined verdict rows (guide pages 18-27).
`checkpoint-axi email show <id>` returns the entity payload, security results, actions taken and available actions (guide pages 10-18).
Search defaults to the past 24 hours and 50 rows; `--start-date` and `--end-date` accept ISO timestamps with timezones, with a positive window of at most 31 days.
`--saas` overrides the selected profile and `--saas-entity` optionally selects the entity type.
`--filter` accepts a JSON array of the documented `saasAttrName`, `saasAttrOp` and `saasAttrValue` filters (guide pages 19-20).
For example, `--filter '[{"saasAttrName":"entityPayload.subject","saasAttrOp":"contains","saasAttrValue":"Synthetic"}]'` selects a subject substring.
Use `--limit <1-1000>` or `--all`, which stops at 1,000 rows, 10 HTTP requests, 60 seconds or 8 MiB, including authentication and retries.
Incomplete searches return `complete: false`; when an opaque `cursor` is present, repeat with `--cursor <cursor>` and the same original selectors to continue.
Cursors preserve the original window, bind profile/client identity, regional origin, operation and selectors, and retain an offset when a row limit splits a server page.
The API has no page-size parameter, so continuation within a page replays that page; results changed between calls may be skipped or repeated.
Searches that split a page and all their continuations report `complete: false` with `reason: replay-may-skip-or-repeat`, even after reaching the final page, when no cursor is returned.
Continuation at a whole-page boundary can report `complete: true` on reaching the final page if no earlier page was split.
Treat cursors as sensitive search state and do not edit them.
Cursor strings are never truncated; email text is redacted before 500-character previews, with `--full` for complete text.
Downloads remain reserved for C11.

## Event and task reads (C4)

`checkpoint-axi event list` returns compact ID, type, state and severity rows (guide pages 37-42).
`checkpoint-axi event show <id>` preserves event details, action history and available actions (guide pages 34-37).
`checkpoint-axi task show <id>` returns task status, progress and per-action details for asynchronous actions (guide pages 30-33).
Task states are `init`, `inprogress`, `completed`, `failed`, `stopped` and `paused`; task show performs one read without polling.
Event list accepts comma-separated `--event-types`, `--event-states`, `--severities`, `--event-ids` and `--saas`, plus `--confidence-indicator` and `--description` text selectors.
SaaS defaults to the selected profile's value or `office365_emails`; other event selectors default to unfiltered.
Event list uses the same date windows, row and transport budgets, bound continuation and honest page replay flags as [email search](#email-reads-c3).
Repeat all original event selectors with `--cursor`; the cursor preserves the original date window.
Event and task text is redacted before 500-character previews; use `--full` for full strings and `--fields` to select top-level fields.
For writes, see [event actions](#event-actions-c7).
These reads are verified offline with synthetic fixtures; authentication, token lifetime and live API behavior remain uncommissioned until the owner tests everything together through Artium.

## Exception reads (C5)

`checkpoint-axi exception list <kind>` and `exception show <kind> <id-or-value>` cover `phishing-allow`, `phishing-block`, `spam-allow`, `anomaly`, `click-time`, `malware`, `url` and `dlp` (guide pages 49-123).
Legacy whitelist/blacklist reads use the same routes as phishing-allow/phishing-block, without duplicate commands (pages 49-60).
Phishing and Spam lists return compact ID, sender, subject and comment fields; show preserves the full record and verifies the returned entity ID (pages 56-60, 70-74).
Click-time defaults to list routes; add `--items` to list or show for item routes (pages 87-91).
Malware, URL and DLP require `--type` on both commands:

| Kind | Types | Guide pages |
|---|---|---|
| malware | `hash`, `micro_hash`, `file_type`, `ppat_sender_name`, `allow_file_type`, `sender_email` | 100-102 |
| url | `allow-url`, `allow-domain`, `block-url`, `block-domain` | 110-112 |
| dlp | `hash`, `text_content`, `sender_email`, `recipient_email` | 120-123 |

For example, `checkpoint-axi exception show url 'https://example.com/path' --type allow-url` encodes the supplied value as one path segment.
Anomaly has only a documented list GET, with no detail endpoint or response identity schema (pages 83-84).
`exception show anomaly <id>` therefore refuses with `ENDPOINT_UNVERIFIED` before authentication until owner commissioning settles the contract.
The guide also publishes no response schemas for click-time, malware, URL or DLP reads.
These families and anomaly list preserve JSON values, marked `responseSchema: unverified`, without inventing identity fields or claiming live compatibility.
Unknown-shape detail results are arrays of returned JSON values; documented Phishing/Spam details return one validated object.
Live commissioning of these contracts happens later with all slices together through Artium.

Lists default to 50 rows, accept `--limit <1-1000>` or `--all` capped at 1000 rows, and share the 10-request, 8 MiB and 60-second transport budgets.
No paging request parameter is documented for these GET routes, so each command reads one response without guessing a scroll query.
Truncation, nonempty scroll metadata or a larger advertised total returns `complete: false` and an explanation; there is no exception continuation cursor.
Anti-Phishing list/detail requests share a 1 request/second spacer; all other exception routes share a 10 requests/second spacer within each invocation, including retries and reauthentication replays.
Text is redacted before 500-character previews; `--full` restores complete strings, and `--fields` selects top-level output fields.

## Email writes (C6)

`checkpoint-axi email quarantine --ids <id1>,<id2>` and `email restore --ids <id1>,<id2>` preview asynchronous email actions (guide pages 28-30).
The selected file profile must opt in with `writes: { "allowWrites": true, "operations": ["email.quarantine", "email.restore"] }`, listing only the exact operations it needs.
Wildcards never grant scope, environment-only profiles cannot write, and `CHECKPOINT_AXI_READ_ONLY` always wins.
These gates apply to previews too.
Supply 1-20 unique entity IDs, comma-separated without spaces.
Previews read each entity, verify its identity and email type, check the available action and show current state.
An explicit `--dry-run` also previews and cannot combine with `--execute`.

Every action is disruptive.
Sending an action requires `--execute` plus exact confirmation containing the operation, a space and the comma-separated supplied IDs in order:

```sh
checkpoint-axi email restore --ids synthetic-email-1 --execute --confirm 'email.restore synthetic-email-1'
```

Quarantine is a no-op when `isQuarantined` is true; restore is a no-op only when `isRestored` is true and `isQuarantined` is false.
An entirely no-op batch returns without confirmation or a send; a mixed batch sends only targets still needing the action after re-read.
The confirmation still names the full requested batch.
Before sending, the coordinator records and syncs a redacted JSON-lines `kind: intent` record with `auditId`, operation, profile, region and targets.
It re-reads every target, checks the profile has not changed, and sends at most one action request.
Previews and initial no-ops create no journal.
The [write safety design](docs/design.md#read-write-and-download-safety) defines journal privacy, durability and file requirements.
An intent-recording failure returns `INTENT_NOT_RECORDED` before sending.
An outcome-recording failure returns `OUTCOME_NOT_RECORDED` and requires reconciliation.

Successful submission returns `outcome: accepted`, `auditId` and per-entity `tasks` containing `entityId`, `taskId` and `outcome: accepted`.
Use `checkpoint-axi task show <taskId>` to inspect execution; submission does not establish that an email was changed.
Action requests never retry, including on 401 or 429, and never follow redirects.
A disconnected, invalid, incomplete or otherwise unsuccessful acknowledgement returns `OUTCOME_UNKNOWN` with its audit ID.
Read back every target and reconcile the journal before any further action; never replay automatically.
Write preflights, authentication and the action share the [transport limits](#doctor-and-commissioning); read retries also consume that budget.
All C6 verification is offline and synthetic; live action behavior, auth shape and token lifetime remain unverified until owner commissioning through Artium.

## Anti-Phishing and Spam writes (C8)

`exception create <kind>`, `exception update <kind> <id>` and `exception remove <kind> <id>` support `phishing-allow`, `phishing-block` and `spam-allow` (guide pages 61-69, 75-83).
Every command uses the C6 coordinator, including previews: the selected file profile needs `writes.allowWrites: true` and the exact operation `exception.<kind>.<create|update|remove>`.
`CHECKPOINT_AXI_READ_ONLY` always wins.
Each invocation targets one rule; update/remove require its exception ID.
Create/update require `--input /absolute/rule.json`, a private regular JSON file (POSIX mode 0600; Windows protected DACL) containing the documented `requestData` fields directly, without an envelope:

```json
{
  "senderEmail": "sender@example.com",
  "senderEmailMatching": "contains",
  "subject": "Synthetic exception",
  "subjectMatching": "contains",
  "comment": "Synthetic rule",
  "ignoringSpfCheck": false
}
```

Allowed string fields are `entityId`, `attachmentMd5`, `senderEmail`, `senderName`, `recipient`, `senderClientIp`, `senderDomain`, `senderIp`, `linkDomains`, `subject`, `comment`, `actionNeeded`, `subjectMatching`, `linkDomainMatching`, `senderNameMatching`, `senderDomainMatching`, `senderEmailMatching` and `recipientMatching`.
`ignoringSpfCheck` is boolean, following the parameter tables rather than the guide's string-boolean examples.
At least one nonempty matching criterion is required; metadata or matching operators alone cannot create a rule.
Unknown fields and a supplied update `entityId` that differs from the positional ID are rejected before authentication.
Update sends the supplied fields as a replacement PUT, so supply the complete intended rule rather than a partial patch.
Remove sends a bodyless POST to the documented delete route.

```sh
checkpoint-axi exception create phishing-allow --input /absolute/rule.json
checkpoint-axi exception update spam-allow synthetic-exception-1 --input /absolute/rule.json
checkpoint-axi exception remove phishing-block synthetic-exception-1
```

Commands preview by default; `--dry-run` makes that explicit.
Inspect the requested rule and current state, then repeat with `--execute` and the exact `--confirm` emitted by the preview.
Create confirmation is `exception.<kind>.create sha256:<digest>`, binding the canonical payload; update/remove confirmation is `exception.<kind>.<action> <id>`.
Create reads a complete bounded list to detect an identical rule; incomplete lists refuse execution because no continuation parameter is documented.
Update/remove validate one matching detail response or an empty result; an absent update returns `NOT_FOUND`.
Identical creates/replacements and absent removals detected on the initial read are no-ops without confirmation, a journal or a send.
If the final read detects a no-op, the command returns `outcome: noop` with `auditId` and records `NOT_SENT` in the journal.
After exact confirmation, durable redacted intent precedes a final state read, profile check and single send.
The journal contains operation/target metadata, never the JSON payload.
Preflight reads and the mutation share the exception rate spacer and the write transport budgets.

Successful envelopes return `outcome: accepted` and `auditId`; these exception endpoints provide no task ID or created ID.
Use `exception list <kind>` after create or `exception show <kind> <id>` after update/remove to reconcile.
The remove acknowledgement also accepts the guide's envelope code 204.
HTTP errors, redirects, disconnections and invalid acknowledgements become `OUTCOME_UNKNOWN`, without retries or token re-exchange.
Reconcile before any further action and never replay automatically.
All C8 verification uses offline synthetic fixtures; live exception behavior, auth shape and token lifetime remain unverified until owner commissioning through Artium.

## Anomaly and click-time writes (C9)

`exception create anomaly`, `exception remove anomaly <rule-id>`, `exception create click-time`, `exception update click-time <item-id>`, `exception remove click-time <item-id>` and `exception remove-items click-time --ids <id1>,<id2>` implement the documented requests on guide pages 84-99.
Every operation uses the C6 coordinator and requires configured writes.allowWrites, exact operation scope `exception.<kind>.<action>` and no forced read-only override, including for previews.
Create and update read a private absolute `--input` JSON file containing the requestData fields directly, without an envelope.
Anomaly create accepts `addedBy` and `requestJson` with `whitelist-option:new_country`, `apply-to-past` (`Yes` or `No`), `anomaly-comment` and `event_id`:

```json
{
  "addedBy": "",
  "requestJson": {
    "whitelist-option:new_country": "synthetic-country-1",
    "apply-to-past": "Yes",
    "anomaly-comment": "Synthetic rule",
    "event_id": "synthetic-event-1"
  }
}
```

Click-time create accepts `listItemName`, `listId` and `createdBy`; update additionally requires `listItemId` matching the positional item ID:

```json
{
  "listItemName": "https://example.com/path",
  "listId": "synthetic-list-1",
  "createdBy": ""
}
```

IDs contain 1-256 letters, digits, underscores or hyphens; remove-items requires 1-20 unique IDs.
Unknown fields fail before authentication.
Anomaly create/remove share a POST route, distinguished by their documented request bodies; remove sends `{ "requestData": { "ruleId": "<rule-id>" } }`.
Click-time create and remove-items share POST items, distinguished by create fields or listItemIds; update sends PUT items/{item_id}, and remove sends a bodyless POST items/{item_id}.
Collection PUT items (pages 93-94) is deferred until commissioning; update requires one positional item ID.

The guide does not document response schemas for anomaly/click-time reads or acknowledgements.
C9 previews explicitly show targetState: unverified and do not infer existence, identity or no-op state from arbitrary JSON.
Execution requires `--execute` and the preview's exact `--confirm`, even if a target might already be absent or a rule already exists.
Create confirms the complete private payload SHA-256; other commands confirm every caller-supplied ID in order.
Durable redacted intent and final configuration/scope checks precede one send; requests never retry or reauthenticate after a mutation response.
The journal holds metadata only, never input or response bodies.
Successful HTTP status and any supplied successful response envelope return outcome: accepted, auditId, responseSchema: unverified and the bounded raw JSON response, redacted before the usual 500-character string previews.
Never repeat a mutation to retrieve truncated strings; use read-only list or item commands to reconcile.
An empty HTTP 204 is represented as response: null.
No created ID, task ID or count is derived; reconcile using list or item reads, whose response identities also remain unverified.

`exception clear click-time` refuses ENDPOINT_UNVERIFIED before authentication, including previews: the required freshly read count cannot be trusted from an undocumented list shape (pages 87-88, 96-97).
Clear, collection PUT, response identities, existence/no-op detection and acknowledgement shapes remain live-commissioning follow-ups through Artium.
All tests are offline and synthetic; no live behavior or token lifetime has been commissioned.

## Agent discovery

`checkpoint-axi-hook` emits local home context and does not install integrations or make API calls.
Use it only when explicitly configuring a session hook.
The generated [skill](skills/checkpoint-axi/SKILL.md) is an alternative on-demand discovery path after publication:

```sh
npx skills add knowttl/checkpoint-axi --skill checkpoint-axi
```

Neither path is needed for ordinary CLI use.
Automatic hook installation and hosted Artium integration are not shipped yet.

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
To regenerate catalogue docs or the capability inventory:

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
