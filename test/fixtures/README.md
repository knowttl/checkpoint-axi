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
Authentication tests use synthetic provisional token shapes; page 8 documents the exchange but specifies no response schema or lifetime.
Do not copy the guide's sample identifiers, domains or malformed JSON responses.
