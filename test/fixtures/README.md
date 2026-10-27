# Synthetic fixtures

`profile.json` follows the local AXI profile schema and contains no tenant data.
Its region is from the public guide, page 8; its client ID and secret environment name are synthetic placeholders.
`search-page.json` is a synthetic empty response derived from the entity search envelope/data schema on guide pages 20-22, with a reserved synthetic request UUID.
Transport tests derive object response data from the alternative schema shape on pages 35-37.
Authentication tests use synthetic provisional token shapes; page 8 documents the exchange but specifies no response schema or lifetime.
Do not copy the guide's sample identifiers, domains or malformed JSON responses.
