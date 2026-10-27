# Synthetic fixtures

`profile.json` follows the local AXI profile schema and contains no tenant data.
Its region is from the public guide, page 8; its client ID and secret environment name are synthetic placeholders.
`search-page.json` is a synthetic empty response derived from the entity search envelope/data schema on guide pages 20-22, with a reserved synthetic request UUID.
`email-page.json` derives entity detail, payload, verdict and action fields from the schemas on guide pages 11-15 and 21-24.
Its email IDs, reserved example addresses, timestamps and content are invented; pagination tests vary only synthetic records and envelope metadata.
Transport tests derive object response data from the alternative schema shape on pages 35-37.
`event-page.json` derives event details, action history and available actions from the schemas on guide pages 35-36 and 40-41.
`task-page.json` derives task status, progress and action details from the schema on guide pages 31-32.
All event IDs, task IDs, action IDs, addresses, timestamps and content are synthetic.
`exception-page.json` derives Anti-Phishing/Spam fields from guide pages 50, 56-60 and 70-74, using invented identifiers, content and a reserved example address.
The guide publishes no response schemas for anomaly, click-time, malware, URL or DLP reads (pages 83-123).
Tests for those routes use arbitrary JSON to exercise preservation and bounds, not fabricated vendor schemas; their response contracts remain unverified.
Authentication tests use synthetic provisional token shapes; page 8 documents the exchange but specifies no response schema or lifetime.
Do not copy the guide's sample identifiers, domains or malformed JSON responses.
