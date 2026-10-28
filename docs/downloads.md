# Private downloads

Enable `downloads.allow: true` in a file profile before using `email download <entity-id>`, `attachment download <entity-id> <attachment-id>` or `attachment download-all <entity-id>` (guide pages 131-137).
Every command requires an absolute `--out` path to a new file in an existing directory.
Existing files and symlinks are refused before authentication; filenames from response headers are ignored.
The file is created exclusively with mode 0600 on POSIX or a protected DACL on Windows before any content is written.
Binary content is buffered up to 50 MiB per response, verified against the required `x-av-sha256` header, then written and synced; failed downloads remove their new output file.
No binary content, server filename, headers or response body enters stdout; success prints only `path`, `size` and `sha256`.
Downloads permit one token re-exchange after 401 and two 429 retries respecting Retry-After, within 10 total requests and 60 seconds including authentication.
TLS verification and the fixed regional gateway restriction apply throughout; redirects are refused.

```sh
checkpoint-axi email download <entity-id> --out /absolute/message
checkpoint-axi email download <entity-id> --original --out /absolute/original
checkpoint-axi attachment download <entity-id> <attachment-id> --out /absolute/attachment
checkpoint-axi attachment download-all <entity-id> --out /absolute/attachments
```

Email downloads require profile `scope`, sent verbatim as the comma-separated `scopes` header required on page 131.
`--original` selects the unmodified email; default false includes the service's processing headers.
Attachment commands use optional `--scope` as a query selector, defaulting to profile `scope` when configured; no scope query is sent when both are absent.
Scope authorization and the relationship between the email `scopes` header and attachment `scope` query require manual verification.
The guide specifies `x-av-sha256` for individual attachments (page 134) but omits it for email and ZIP responses (pages 132, 136).
All three commands enforce the approved hash requirement: a missing or malformed header returns `DOWNLOAD_HASH_INVALID`, and a mismatch returns `DOWNLOAD_HASH_MISMATCH`, with output removed.
Email/ZIP hash availability therefore remains unverified and may require a commissioning follow-up before those downloads can succeed live.
An attachment ZIP may contain only the attachments the service could retrieve even on HTTP 200 (page 136); a successful download does not prove attachment completeness.
Archives are saved as received, never extracted automatically.
Environment profiles cannot enable downloads; remote mutation scope and write confirmation remain separate from this download opt-in.
All live-only facts, including token shape/lifetime, delete requests and download scopes, remain unverified; automated tests use only synthetic offline data.

