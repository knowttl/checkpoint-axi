import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const publicHosts = new Set([
  "github.com", "nodejs.org", "registry.npmjs.org", "json-schema.org", "toonformat.dev",
  "img.shields.io", "www.npmjs.com",
  "sc1.checkpoint.com", "cloudinfra-gw-us.portal.checkpoint.com", "cloudinfra-gw.portal.checkpoint.com",
  "cloudinfra-gw.ca.portal.checkpoint.com", "cloudinfra-gw.ap.portal.checkpoint.com", "cloudinfra-gw.uk.portal.checkpoint.com",
  "cloudinfra-gw.me.portal.checkpoint.com", "cloudinfra-gw.in.portal.checkpoint.com",
]);

export function identifierViolations(text) {
  const violations = [];
  for (const match of text.matchAll(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi)) {
    if (!/^00000000-0000-4000-8000-0000000000[0-9a-f]{2}$/i.test(match[0])) violations.push("non-synthetic UUID");
  }
  const domains = text.matchAll(/\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}\b/gi);
  for (const [domain] of domains) {
    const host = domain.toLowerCase();
    // Source filenames and documented operation identifiers are not DNS names.
    if (/\.(?:md|json|ts|mts|mjs|js|yaml|yml|log|pdf)$/.test(host)
      || /^exception\.(?:phishing-allow|phishing-block|spam-allow)\.(?:create|update|remove)$/.test(host)
      || /^exception\.anomaly\.(?:create|remove)$/.test(host)
      || /^exception\.click-time\.(?:create|update|remove|remove-items|clear)$/.test(host)
      || ["email.quarantine", "email.restore", "event.action", "event.action.dismiss", "writes.allowwrites", "downloads.allow", "entitypayload.subject"].includes(host)) continue;
    if (!publicHosts.has(host) && !/(^|\.)(example\.(com|net|org)|test|invalid|example)$/.test(host)) violations.push("unapproved domain or internal host");
  }
  for (const [address] of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
    if (address !== "127.0.0.1" && !/^(192\.0\.2|198\.51\.100|203\.0\.113)\./.test(address)) violations.push("non-synthetic IP address");
  }
  return [...new Set(violations)];
}

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const targets = [...files(join(root, "docs")), ...files(join(root, "skills")), ...files(join(root, "test/fixtures")),
    ...["README.md", "AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"].map((path) => join(root, path))];
  let failed = false;
  for (const path of targets) {
    const violations = identifierViolations(readFileSync(path, "utf8"));
    if (violations.length) { console.error(`${path.slice(root.length)}: ${violations.join(", ")}`); failed = true; }
  }
  if (failed) process.exitCode = 1;
  else console.log("Verified synthetic identifiers in fixtures and documentation");
}
