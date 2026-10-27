# Design and delivery boundaries

The v1 design covers the full Harmony Email & Collaboration API in twelve slices.
C1 implements the local scaffold; C2 adds authentication, bounded transport and `doctor`; C3 adds email reads; C4 adds event and task reads; C5 adds exception reads; C6 adds the write coordinator and email quarantine/restore.
The executable catalogue is separate from the planned inventory; inventory metadata never enables dispatch.
The source is the [Email Security API Reference Guide, 23 October 2026](https://sc1.checkpoint.com/documents/Harmony_Email_and_Collaboration_API_Reference/CP_Check_Point_Email_Security_API_Reference_Guide.pdf).
`inventory/specs.json` pins its URL, SHA-256, byte length and page count.
Unlike Tenable's committed JSON specs, the vendor PDF stays outside git because redistribution permission is unconfirmed.
This inventory is a page-cited coverage ledger, not a generated OpenAPI schema or a claim of endpoint completeness inferred from PDF samples.
Default spec checks are offline; explicit `--pdf` verification checks supplied bytes.

## Credentials and transport

One strict profile contains `region`, `clientId`, a `clientSecret` SecretRef, optional `saas`, optional `scope`, `downloads` and `writes`.
`saas` defaults to `office365_emails`; `doctor`, `email search` and `event list` expose `--saas` as a per-call override.
Only the fixed seven-gateway region map is supported; profiles cannot supply an origin.
`src/private-file.ts` owns platform read security; configuration and secret source rules follow the AXI credential standard.
Config/profile precedence, strict env-profile completeness and private-file rules are documented in README.
C1-C2 have no private writes or token persistence.
All resolved secret forms are registered for raw, JSON-escaped and URL-encoded output redaction before use.

C2 provides one closed HTTPS transport boundary with TLS verification, redirect refusal and a fresh `x-av-req-id` UUID per request.
The guide uses `POST /auth/external` with `clientId` and `accessKey` (the client secret), then Bearer authorization under `/app/hec-api/v1.0` (pages 8-10).
Tokens stay in memory and are never cached to disk; reads permit at most one token re-exchange per invocation after a 401.
Action requests never reauthenticate or retry, including on 401 or 429.
Token response shape and lifetime are undocumented; the owner will commission all slices together through Artium after the full build.
Only a pass/fail commissioning note may enter this public repository.
Automated tests never contact that tenant.
The provisional token field candidates and commissioning failure code are documented in README.
Doctor performs one page of the default 24-hour entity search for the selected SaaS and discards the data.
The transport normalizes object/array response data and preserves scroll metadata for the read slices.
Auth, re-exchange, retries and delays share the [invocation budgets in README](../README.md#doctor-and-commissioning).
C3-C4 share bound continuation cursors and collection row limits for email search and event list in `src/reads.ts`.

## Read, write and download safety

Email reads decode schema-derived synthetic responses rather than copy inconsistent JSON samples.
Scroll cursors bind profile, client identity, origin, operation and selectors, including the original date window.
Search limits, page replay limitations, completion status and output previews are documented in [README](../README.md#email-reads-c3).
Exception requests are spaced at 1 request/second for Anti-Phishing and 10 requests/second otherwise.
Reads retry 429 at most twice, respecting `Retry-After`; writes never retry.

The C6 write coordinator requires configured `allowWrites` and exact operation scope, preview, `--execute`, exact confirmation naming every target, and durable redacted intent before a single send.
`CHECKPOINT_AXI_READ_ONLY` overrides configured write permission.
Target batches stop at 20; ambiguous outcomes report `OUTCOME_UNKNOWN` and are never replayed.
Entity/event actions return `accepted` and `taskId`, since execution is asynchronous.
The email action transport consumes a one-use coordinator authorization bound to the operation, targets, profile and region.
Before a send, the coordinator re-reads every target and checks that the selected profile has not changed.
The API offers no conditional entity-action request, so this cannot prevent a concurrent server-side change after preflight.
The journal and its lock must be private regular files in a private directory; symlinks, hard-linked journals, insecure modes, an incomplete journal or an existing lock block execution.
POSIX files are created with mode 0600 and the directory with 0700.
On Windows, newly created files and the journal directory receive protected DACLs granting FullControl only to the current user, SYSTEM and Administrators; existing paths must already satisfy this policy.
Journal records contain only redacted metadata, never headers, message bodies, credentials or tokens.
The intent is synced before re-reading and sending; POSIX directory entries are also synced for crash durability.
`src/writes.ts` owns these checks; `test/writes.test.ts` exercises ordering, unsafe journals, scope changes and ambiguous acknowledgements with synthetic data.
Operation names are `email.quarantine`, `email.restore`, `event.action.<name>` and `exception.<kind>.<create|update|remove|remove-items|clear>`.
Event action names must be validated against `availableEventActions`.
Clearing a list requires confirmation including the freshly read count.
Six malware/URL/DLP delete operations stay refused as `ENDPOINT_UNVERIFIED` until manual commissioning resolves the guide's identical create/delete descriptions.
Downloads require `downloads.allow`, a new exclusive 0600 `--out` file, a 50 MiB cap and verified `x-av-sha256`.
They never stream to stdout and report only path, size and SHA-256.
Hosted downloads will reuse Artium's artifact mechanism in C12.

## API coverage ledger

Page numbers are printed guide pages.
Rows remain planned or excluded except the shipped C2 authentication/doctor, C3 email-read, C4 event/task-read, C5 exception-read and C6 email-write capabilities.
Inventory metadata never enables command dispatch.
Legacy whitelist/blacklist reads remain recorded separately from the eight exception kinds: phishing-allow, phishing-block, spam-allow, anomaly, click-time, malware, url and dlp.

| Capability | Pages | Slice | Disposition | Reason |
|---|---|---|---|---|
| `auth exchange and doctor` | 8-9 | C2 | auth | Shipped in C2; commission the undocumented token contract manually. |
| `email search and show` | 10-27 | C3 | read | Shipped in C3; GET entity detail and POST search/query with bounded scroll. |
| `event list and show` | 34-42 | C4 | read | Shipped in C4; GET event detail and POST event/query with bounded scroll. |
| `task show` | 30-33 | C4 | read | Shipped in C4; GET task status and per-action details for asynchronous actions. |
| `legacy exception reads` | 49-55 | C5 | read | Shipped in C5 through phishing-allow and phishing-block list/show; same whitelist/blacklist routes. |
| `exception list and show for eight kinds` | 55-131 | C5 | read | Shipped in C5; documented family/item reads; anomaly show refuses ENDPOINT_UNVERIFIED pending response identity commissioning. |
| `email quarantine and restore` | 28-30 | C6 | write | Shipped in C6; POST action/entity through the gated coordinator with durable intent, exact confirmation, re-read and no retry. |
| `event action` | 42-45 | C7 | write | POST action/event validated against availableEventActions. |
| `phishing create update remove` | 61-69 | C8 | write | Anti-Phishing allow and block CRUD with explicit scope. |
| `spam create update remove` | 75-83 | C8 | write | Spam allow-list CRUD with explicit scope. |
| `anomaly create remove` | 84-87 | C9 | write | Shared sectools/anomaly/exceptions POST needs explicit operation binding. |
| `click-time create update remove remove-items clear` | 91-100 | C9 | write | List and item mutations; body-less clear needs counted confirmation. |
| `malware create update` | 102-106 | C10 | write | Create, create-specific and modify sectool-exceptions/checkpoint2. |
| `url create update` | 113-117 | C10 | write | Create, create-specific and modify sectool-exceptions/avanan_url. |
| `dlp create update` | 123-127 | C10 | write | Create, create-specific and modify sectool-exceptions/avanan_dlp. |
| `malware remove clear` | 107-110 | C10 | unverified | Refuse two ambiguous deletes with ENDPOINT_UNVERIFIED pending commissioning. |
| `url remove clear` | 117-120 | C10 | unverified | Refuse two ambiguous deletes with ENDPOINT_UNVERIFIED pending commissioning. |
| `dlp remove clear` | 128-131 | C10 | unverified | Refuse two ambiguous deletes with ENDPOINT_UNVERIFIED pending commissioning. |
| `email and attachment downloads` | 131-137 | C11 | download | Entity EML, individual attachment and all-attachment ZIP with opt-in. |
| `audit logs` | 138 | C12 | excluded | Outside this API; use Check Point Portal APIs separately. |

## Slices and integration

1. C1: package, strict ESM, local commands, credentials schema, generated docs, PDF provenance and offline checks.
2. C2: regional authentication, transport and bounded `doctor`; owner commissioning follows the full build through Artium.
3. C3: email reads.
4. C4: event and task reads.
5. C5: every exception family's reads.
6. C6: write coordinator and email quarantine/restore.
7. C7: event actions.
8. C8: Anti-Phishing and Spam writes.
9. C9: anomaly and click-time writes.
10. C10: malware, URL and DLP create/update; six deletes implemented but refused.
11. C11: downloads, final skills/docs and 0.1.0 release after trusted-publisher registration.
12. C12: separate Artium PR with credential schema, adapter, write policy, hosted artifacts, tool schema/maps, inventory, exact package/integrity pins and full-content skill overlay.

## Change recipe and tests

The command catalogue generates the README command table, command reference and skill.
`docs:check` detects drift after build, and `spec:check` detects coverage/provenance drift without networking.
The identifier guard permits public vendor gateways, documentation hosts, reserved example domains, documentation IP ranges and explicitly synthetic UUIDs only.
It is a guardrail alongside staged review, not a substitute for checking public-repository hygiene.
Tests use real local commands, isolated HOME/XDG directories, synthetic fixtures and a deny-network preload inherited by subprocesses.
The packaged baseline packs and installs real local dependency tarballs offline before running both bins.
Affected-test selection always includes packaged CLI, profiles, identifier and network safety; shared infrastructure runs all tests.
C2 transport tests use a registered loopback TLS fake gateway without enabling external networking.
There is no hosted test workflow; release publication alone runs hosted verification.
