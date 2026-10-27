# Design and delivery boundaries

The v1 design covers the full Harmony Email & Collaboration API in twelve slices.
C1 implements the local scaffold; C2 adds authentication, bounded transport and `doctor`.
The executable catalogue is separate from the planned inventory; inventory metadata never enables dispatch.
The source is the [Email Security API Reference Guide, 23 October 2026](https://sc1.checkpoint.com/documents/Harmony_Email_and_Collaboration_API_Reference/CP_Check_Point_Email_Security_API_Reference_Guide.pdf).
`inventory/specs.json` pins its URL, SHA-256, byte length and page count.
Unlike Tenable's committed JSON specs, the vendor PDF stays outside git because redistribution permission is unconfirmed.
This inventory is a page-cited coverage ledger, not a generated OpenAPI schema or a claim of endpoint completeness inferred from PDF samples.
Default spec checks are offline; explicit `--pdf` verification checks supplied bytes.

## Credentials and transport

One strict profile contains `region`, `clientId`, a `clientSecret` SecretRef, optional `saas`, optional `scope`, `downloads` and `writes`.
`saas` defaults to `office365_emails`; `doctor` exposes `--saas` as a per-call override.
Only the fixed seven-gateway region map is supported; profiles cannot supply an origin.
`src/private-file.ts` owns platform read security; configuration and secret source rules follow the AXI credential standard.
Config/profile precedence, strict env-profile completeness and private-file rules are documented in README.
C1-C2 have no private writes or token persistence.
All resolved secret forms are registered for raw, JSON-escaped and URL-encoded output redaction before use.

C2 provides one closed HTTPS transport boundary with TLS verification, redirect refusal and a fresh `x-av-req-id` UUID per request.
The guide uses `POST /auth/external` with `clientId` and `accessKey` (the client secret), then Bearer authorization under `/app/hec-api/v1.0` (pages 8-10).
Tokens stay in memory once per run with one re-exchange on 401.
Token response shape and lifetime are undocumented; the owner will run `doctor` once manually after C2 against a test tenant.
Only a pass/fail commissioning note may enter this public repository.
Automated tests never contact that tenant.
The provisional token field candidates and commissioning failure code are documented in README.
Doctor performs one page of the default 24-hour entity search for the selected SaaS and discards the data.
The transport normalizes object/array response data and preserves scroll metadata for the read slices.
Auth, re-exchange and retries share a 10-request, 8 MiB and 60-second invocation budget.
User-facing bound continuation cursors and collection row limits arrive with the C3 read commands.

## Read, write and download safety

Read slices will decode schema-derived synthetic responses rather than copy inconsistent JSON samples.
Scroll cursors bind profile, origin, operation and selectors.
Lists default to 50 rows and a 24-hour window, with a maximum 31-day window.
`--all` stops at 10 requests, 1,000 rows, 60 seconds or 8 MiB and returns incomplete status with a continuation cursor.
Exception requests are spaced at 1 request/second for Anti-Phishing and 10 requests/second otherwise.
Reads retry 429 at most twice, respecting `Retry-After`; writes never retry.
All text uses 500-character previews with an explicit `--full` escape hatch.

The future write coordinator requires configured `allowWrites` and exact operation scope, preview, `--execute`, exact confirmation naming every target, and durable redacted intent before a single send.
`CHECKPOINT_AXI_READ_ONLY` overrides configured write permission.
Target batches stop at 20; ambiguous outcomes report `OUTCOME_UNKNOWN` and are never replayed.
Entity/event actions return `accepted` and `taskId`, since execution is asynchronous.
Operation names are `email.quarantine`, `email.restore`, `event.action.<name>` and `exception.<kind>.<create|update|remove|remove-items|clear>`.
Event action names must be validated against `availableEventActions`.
Clearing a list requires confirmation including the freshly read count.
Six malware/URL/DLP delete operations stay refused as `ENDPOINT_UNVERIFIED` until manual commissioning resolves the guide's identical create/delete descriptions.
Downloads require `downloads.allow`, a new exclusive 0600 `--out` file, a 50 MiB cap and verified `x-av-sha256`.
They never stream to stdout and report only path, size and SHA-256.
Hosted downloads will reuse Artium's artifact mechanism in C12.

## API coverage ledger

Page numbers are printed guide pages.
Rows remain planned or excluded except the shipped C2 authentication and doctor capability.
Inventory metadata never enables command dispatch.
Legacy whitelist/blacklist reads remain recorded separately from the eight exception kinds: phishing-allow, phishing-block, spam-allow, anomaly, click-time, malware, url and dlp.

| Capability | Pages | Slice | Disposition | Reason |
|---|---|---|---|---|
| `auth exchange and doctor` | 8-9 | C2 | auth | Shipped in C2; commission the undocumented token contract manually. |
| `email search and show` | 10-27 | C3 | read | GET entity detail and POST search/query with bounded scroll. |
| `event list and show` | 34-42 | C4 | read | GET event detail and POST event/query with bounded scroll. |
| `task show` | 30-33 | C4 | read | GET task status for asynchronous entity and event actions. |
| `legacy exception reads` | 49-55 | C5 | read | GET whitelist/blacklist list and detail. |
| `exception list and show for eight kinds` | 55-131 | C5 | read | All documented family and item reads, including click-time items. |
| `email quarantine and restore` | 28-30 | C6 | write | POST action/entity through the common write coordinator. |
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
2. C2: regional authentication, transport and bounded `doctor`; owner commissioning follows.
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
