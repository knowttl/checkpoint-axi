# Synthetic fixtures

`profile.json` follows the local AXI profile schema and contains no tenant data.
Its region is from the public guide, page 8; its client ID and secret environment name are synthetic placeholders.
`search-page.json` is a synthetic empty response derived from the entity search envelope/data schema on guide pages 20-22, with a reserved synthetic request UUID.
`email-page.json` derives entity detail, payload, verdict and action fields from the schemas on guide pages 11-15 and 21-24.
Its email IDs, reserved example addresses, timestamps and content are invented; pagination tests vary only synthetic records and envelope metadata.
`email-page.json` supplies the object form of `entitySecurityResults` from the guide's JSON examples.
`email-security-array-page.json` supplies the array-of-scan-objects form described in the prose/table on pages 11 and 14, with scan fields from page 14.
Neither fixture purports to reproduce the unobserved live response behind TD-049 or establishes a spam-specific contract.
Transport tests derive object response data from the alternative schema shape on pages 35-37.
`event-page.json` derives event details, action history and available actions from the schemas on guide pages 35-36 and 40-41.
`task-page.json` derives task status, progress and action details from the schema on guide pages 31-32.
All event IDs, task IDs, action IDs, addresses, timestamps and content are synthetic.
`exception-page.json` derives Anti-Phishing/Spam fields from guide pages 50, 56-60 and 70-74, using invented identifiers, content and a reserved example address.
The guide publishes no response schemas for anomaly, click-time, malware, URL or DLP reads (pages 83-123).
Tests for those routes use arbitrary JSON to exercise preservation and bounds, not fabricated vendor schemas; their response contracts remain unverified.
Authentication tests use synthetic provisional token shapes; page 8 documents the exchange but specifies no response schema or lifetime.
`email-action-page.json` derives the per-entity asynchronous task acknowledgement from guide pages 29-30, with invented entity/task IDs and a reserved synthetic request UUID.
Write tests vary entity state and available actions from pages 14-16 and bind the action request to the body schema on pages 28-29.
Do not copy the guide's sample identifiers, domains or malformed JSON responses.
`event-action-page.json` derives event/entity/task acknowledgements from the schemas on guide pages 44-45 with invented IDs.
Event-action tests derive parameterized variants from the schema on pages 35-37, and name-only requests from the body schema on page 43.
They test refusal of uncommissioned parameter serialization, not an assumed object-to-string conversion.
`exception-write.json` derives request fields and boolean types from guide pages 62-66 and 76-80, using invented content and a reserved example address.
`exception-write-page.json` derives the envelope-only acknowledgement from pages 63-64, 67, 77-78 and 80-82.
Exception-write tests derive bodyless removal and envelope code 204 from pages 67-69 and 81-82, rather than copying sample identifiers.
C9 sectools-write tests derive anomaly request bodies from pages 84 and 86, click-time create/update bodies from pages 92-95, remove-items from pages 97-98 and bodyless item removal from pages 98-99.
These pages provide example request bodies but no request parameter tables or response schemas.
All request identifiers and content are invented; acknowledgement JSON and empty HTTP 204 responses are explicitly provisional transport fixtures, not schema-derived vendor responses.
Tests never infer identity, existence, no-op status or a list count from these acknowledgements.
