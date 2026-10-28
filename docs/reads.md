# Reads and transport

[Doctor and transport](#doctor-and-transport) | [Email reads](#email-reads) | [Events and tasks](#event-and-task-reads) | [Exceptions](#exception-reads)

## Doctor and transport

`checkpoint-axi doctor --profile <name>` explicitly contacts the selected public regional gateway.
It authenticates and runs one page of email search over the past 24 hours for the selected SaaS.
It reports region, SaaS and pass/fail for auth and read, without email data or credentials; a failed check exits 1.
Home, the hook, command help and `auth status` remain offline.
No commissioning run has been performed by the automated tests.

The vendor guide does not document the token response shape or lifetime (page 8).
The provisional parser accepts one distinct nonempty printable ASCII token without whitespace from `token`, `access_token` or `accessToken` at the root or within `data` or `responseData`.
Unsupported, conflicting or invalid values fail with `AUTH_SHAPE_UNVERIFIED`, requiring owner commissioning rather than printing the response.
Token persistence and reauthentication rules are defined in [the transport design](design.md#credentials-and-transport).
All requests carry a new request UUID; authenticated API calls carry Bearer authorization.
TLS certificate verification stays enabled and redirects are refused.
Read sessions allow at most 10 HTTP requests; write sessions allow at most 44.
Both are bounded by 8 MiB of JSON response bytes and 60 seconds, including auth, re-exchange, read retries and delays.
Download bodies have a separate 50 MiB cap per response within the same request/time budgets.
Reads retry HTTP 429 at most twice, honoring numeric or HTTP-date `Retry-After` within that budget.
Exception reads and writes share separate 1 request/second Anti-Phishing and 10 requests/second other-exception spacers.

## Email reads

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
See [downloads](downloads.md) for private file output.

## Event and task reads

`checkpoint-axi event list` returns compact ID, type, state and severity rows (guide pages 37-42).
`checkpoint-axi event show <id>` preserves event details, action history and available actions (guide pages 34-37).
`checkpoint-axi task show <id>` returns task status, progress and per-action details for asynchronous actions (guide pages 30-33).
Task states are `init`, `inprogress`, `completed`, `failed`, `stopped` and `paused`; task show performs one read without polling.
Event list accepts comma-separated `--event-types`, `--event-states`, `--severities`, `--event-ids` and `--saas`, plus `--confidence-indicator` and `--description` text selectors.
SaaS defaults to the selected profile's value or `office365_emails`; other event selectors default to unfiltered.
Event list uses the same date windows, row and transport budgets, bound continuation and honest page replay flags as [email search](reads.md#email-reads).
Repeat all original event selectors with `--cursor`; the cursor preserves the original date window.
Event and task text is redacted before 500-character previews; use `--full` for full strings and `--fields` to select top-level fields.
For writes, see [event actions](writes.md#event-actions).
These reads are verified offline with synthetic fixtures; authentication, token lifetime and live API behavior require manual verification.

## Exception reads

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
These contracts require manual verification against the live API.

Lists default to 50 rows, accept `--limit <1-1000>` or `--all` capped at 1000 rows, and share the 10-request, 8 MiB and 60-second transport budgets.
No paging request parameter is documented for these GET routes, so each command reads one response without guessing a scroll query.
Truncation, nonempty scroll metadata or a larger advertised total returns `complete: false` and an explanation; there is no exception continuation cursor.
Anti-Phishing list/detail requests share a 1 request/second spacer; all other exception routes share a 10 requests/second spacer within each invocation, including retries and reauthentication replays.
Text is redacted before 500-character previews; `--full` restores complete strings, and `--fields` selects top-level output fields.

