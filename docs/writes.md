# Write safety and operation reference

[Email](#email-writes) | [Events](#event-actions) | [Phishing and Spam](#anti-phishing-and-spam-writes) | [Anomaly and click-time](#anomaly-and-click-time-writes) | [Malware, URL and DLP](#malware-url-and-dlp-writes)

Read-only by default.
[Profile permissions](configuration.md) grant exact operations; previews also require these permissions.
See [downloads](downloads.md) for the separate local file opt-in and [the safety design](design.md#read-write-and-download-safety) for journal invariants.

## Email writes

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
The [write safety design](design.md#read-write-and-download-safety) defines journal privacy, durability and file requirements.
An intent-recording failure returns `INTENT_NOT_RECORDED` before sending.
An outcome-recording failure returns `OUTCOME_NOT_RECORDED` and requires reconciliation.

Successful submission returns `outcome: accepted`, `auditId` and per-entity `tasks` containing `entityId`, `taskId` and `outcome: accepted`.
Use `checkpoint-axi task show <taskId>` to inspect execution; submission does not establish that an email was changed.
Action requests never retry, including on 401 or 429, and never follow redirects.
A disconnected, invalid, incomplete or otherwise unsuccessful acknowledgement returns `OUTCOME_UNKNOWN` with its audit ID.
Read back every target and reconcile the journal before any further action; never replay automatically.
Write preflights, authentication and the action share the [transport limits](reads.md#doctor-and-transport); read retries also consume that budget.
Automated write verification is offline and synthetic; live action behavior, auth shape and token lifetime require manual verification.

## Event actions

`checkpoint-axi event action --ids <id>[,<id>] --name <action>` previews an action against 1-20 unique events (guide pages 35-37, 42-45).
Enable `writes.allowWrites` and the exact `event.action.<name>` operation in the selected profile; forced read-only always wins.
Execution requires `--execute --confirm 'event.action.<name> <ids>'`, with IDs in the supplied order.
The write coordinator durably records intent, re-reads every event and sends one batch only if the action remains available on every target.
Accepted responses identify a task for every event; use `checkpoint-axi task show <taskId>` to inspect execution.
Ambiguous outcomes are never retried.

`event show <id>` lists all available actions, including parameterized actions that require manual verification before support can be added.
Nonempty `actionParameter` objects and repeated action names refuse `ENDPOINT_UNVERIFIED`, including during preview.
The guide exposes parameter objects on pages 36-37 but requires `eventActionParam` strings on page 43; the CLI does not guess serialization or add a parameter selector.
Name-only actions send `eventActionParam: [""]`; this and all live-only behavior remain uncommissioned.

## Anti-Phishing and Spam writes

`exception create <kind>`, `exception update <kind> <id>` and `exception remove <kind> <id>` support `phishing-allow`, `phishing-block` and `spam-allow` (guide pages 61-69, 75-83).
Every command uses the write coordinator, including previews: the selected file profile needs `writes.allowWrites: true` and the exact operation `exception.<kind>.<create|update|remove>`.
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
Automated exception write verification uses offline synthetic fixtures; live exception behavior, auth shape and token lifetime require manual verification.

## Anomaly and click-time writes

`exception create anomaly`, `exception remove anomaly <rule-id>`, `exception create click-time`, `exception update click-time <item-id>`, `exception remove click-time <item-id>` and `exception remove-items click-time --ids <id1>,<id2>` implement the documented requests on guide pages 84-99.
Every operation uses the write coordinator and requires configured writes.allowWrites, exact operation scope `exception.<kind>.<action>` and no forced read-only override, including for previews.
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
These previews explicitly show targetState: unverified and do not infer existence, identity or no-op state from arbitrary JSON.
Execution requires `--execute` and the preview's exact `--confirm`, even if a target might already be absent or a rule already exists.
Create confirms the complete private payload SHA-256; other commands confirm every caller-supplied ID in order.
Durable redacted intent and final configuration/scope checks precede one send; requests never retry or reauthenticate after a mutation response.
The journal holds metadata only, never input or response bodies.
Successful HTTP status and any supplied successful response envelope return outcome: accepted, auditId, responseSchema: unverified and the bounded raw JSON response, redacted before the usual 500-character string previews.
Never repeat a mutation to retrieve truncated strings; use read-only list or item commands to reconcile.
An empty HTTP 204 is represented as response: null.
No created ID, task ID or count is derived; reconcile using list or item reads, whose response identities also remain unverified.

`exception clear click-time` refuses ENDPOINT_UNVERIFIED before authentication, including previews: the required freshly read count cannot be trusted from an undocumented list shape (pages 87-88, 96-97).
Clear, collection PUT, response identities, existence/no-op detection and acknowledgement shapes require manual verification.
All tests are offline and synthetic; no live behavior or token lifetime has been commissioned.

## Malware, URL and DLP writes

`exception create <malware|url|dlp> --input /absolute/rule.json` sends POST to the family route; add `--specific` to use its documented `/exceptions` create-specific route (guide pages 102-105, 113-116, 123-126).
`exception update <malware|url|dlp> --input /absolute/rule.json` sends PUT to the family route (pages 105-107, 116-117, 126-127).
Updates take no positional ID: `exception_type` and `exception_str` in the body identify the target.
Families map to `checkpoint2`, `avanan_url` and `avanan_dlp` under `/sectool-exceptions/`.
The private input file contains requestData fields directly, without an envelope.
Create requires `exception_type`, `exception_str`, `comment`, `entity_type`, `entity_id`, `file_name`, `created_by_email` and boolean `is_exclusive`.
Malware create additionally requires `exception_payload` with a nonempty string `condition`, for example `{ "condition": "with_link" }`.
Update requires only `exception_type`, `exception_str`, `comment` and `exception_payload` with a nonempty string `condition`.
Types are the same family-specific values listed in [exception reads](reads.md#exception-reads); type, value and entity selectors must be nonempty.
Unknown fields are rejected, including nested payload fields.
These provisional input contracts follow the guide's request bodies: it publishes no parameter tables defining optionality or additional payload fields.

```json
{
  "exception_type": "allow-url",
  "exception_str": "https://example.com/path",
  "comment": "Synthetic rule",
  "entity_type": "user",
  "entity_id": "synthetic-user-1",
  "file_name": "synthetic.json",
  "created_by_email": "sender@example.com",
  "is_exclusive": true
}
```

Every command uses the write coordinator, with the exact operation `exception.<kind>.<create|update>`, configured write opt-in and forced read-only taking precedence.
Commands preview by default; execution requires `--execute` and the exact preview confirmation.
Both create and update confirmations bind the complete normalized payload and create-specific route choice by SHA-256, so changing either requires a new confirmation.
The guide provides no response schemas for existence or no-op checks, so previews mark target state unverified, and initial/final state callbacks retain uncertainty without inferring identity or no-op state.
Durable redacted intent and final scope/configuration checks precede one send; the journal contains metadata only.
Requests never retry or reauthenticate after a mutation response.
Successful HTTP status with valid JSON (or empty HTTP 204) and any supplied successful response envelope returns `accepted`, `auditId`, `responseSchema: unverified` and the bounded redacted response.
No created ID or task ID is inferred; reconcile with `exception list <kind> --type <type>`.
Ambiguous acknowledgements return `OUTCOME_UNKNOWN`; never replay automatically.

All six `exception remove <malware|url|dlp> <value>` and `exception clear <malware|url|dlp>` commands refuse `ENDPOINT_UNVERIFIED` before configuration, credentials, authentication or journaling, including previews.
The guide documents them as identical to create requests (pages 102 vs 107, 104 vs 108, 113 vs 117, 114 vs 119, 123 vs 128, 124 vs 129).
No guessed delete request can be sent through the transport.
Delete contracts, response identities, input optionality, existence/no-op detection, acknowledgement shapes, auth and token lifetime require manual verification.
All automated verification is offline with synthetic requests and arbitrary provisional acknowledgements.

