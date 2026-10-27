import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const mode = process.argv[2];
if (!["--generate", "--check"].includes(mode)) throw new Error("Use --generate or --check, optionally --pdf <local-path>");
const sources = JSON.parse(readFileSync(new URL("inventory/specs.json", root), "utf8"));
if (sources.length !== 1) throw new Error("Expected one pinned PDF source");
const source = sources[0];
if (source.id !== "email-security-api" || !/^https:\/\/sc1\.checkpoint\.com\/documents\/.*\.pdf$/.test(source.url)
  || !/^[a-f0-9]{64}$/.test(source.sha256) || source.pages !== 138 || source.bytes !== 2596219 || source.redistributed !== false) throw new Error("Invalid source pin");
const pdfIndex = process.argv.indexOf("--pdf");
if (pdfIndex !== -1) {
  const bytes = readFileSync(process.argv[pdfIndex + 1]);
  if (bytes.length !== source.bytes || createHash("sha256").update(bytes).digest("hex") !== source.sha256) throw new Error("PDF byte hash mismatch");
}
const design = readFileSync(new URL("docs/design.md", root), "utf8");
const rows = [...design.matchAll(/^\| `([^`]+)` \| (\d+(?:-\d+)?) \| (C\d+) \| (read|write|download|auth|unverified|excluded) \| (.*?) \|$/gm)];
if (rows.length !== 20 || new Set(rows.map((row) => row[1])).size !== rows.length) throw new Error("Incomplete or duplicated PDF coverage ledger");
const capabilities = { schemaVersion: 1, sources, coverage: rows.map(([, capability, pages, slice, disposition, reason]) => ({
  capability, pages, slice, disposition, reason, source: source.id, sourceSha256: source.sha256, executable: slice === "C2",
})) };
const content = `${JSON.stringify(capabilities, null, 2)}\n`;
const target = new URL("inventory/capabilities.json", root);
if (mode === "--generate") writeFileSync(target, content);
else if (readFileSync(target, "utf8") !== content) throw new Error("Stale capability inventory; run spec:generate");
console.log(`${mode === "--generate" ? "Generated" : "Verified"} PDF provenance and ${rows.length} capability groups offline${pdfIndex === -1 ? "; PDF bytes not rechecked (not redistributed)" : "; PDF byte hash verified"}`);
