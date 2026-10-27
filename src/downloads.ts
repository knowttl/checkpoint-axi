import { AxiError } from "axi-sdk-js";
import { createHash } from "node:crypto";
import { closeSync, constants, fchmodSync, fsyncSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { protectWindowsFile } from "./private-file.js";
import type { credentialStore } from "./profiles.js";
import { gateway } from "./transport.js";

export async function downloadCommand(name: string, entityId: string | undefined, attachmentId: string | undefined,
  flags: Map<string, string>, store: ReturnType<typeof credentialStore>, transport?: Parameters<typeof gateway>[3]): Promise<Record<string, unknown>> {
  const out = flags.get("--out");
  if (!entityId || !/^[A-Za-z0-9_-]{1,256}$/.test(entityId) || name === "attachment download" && (!attachmentId || !/^[A-Za-z0-9_-]{1,256}$/.test(attachmentId))
    || !out || !isAbsolute(out) || out === "-" || out.includes("\0")) {
    throw new AxiError("Supply download IDs and an absolute new --out file path", "VALIDATION_ERROR", ["Run checkpoint-axi " + name + " --help"]);
  }
  store.readOnly();
  const profile = store.select(store.load(flags.get("--config"), true).config, flags.get("--profile"));
  if (!profile.downloads.allow) throw new AxiError("Downloads are disabled", "DOWNLOADS_DISABLED", ["Enable downloads.allow in the selected file profile"]);
  const path = resolve(out);
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW), 0o600);
  } catch {
    throw new AxiError("Cannot create a new output file", "DOWNLOAD_OUTPUT_INVALID", ["Choose a new --out path in an existing directory; existing files are never overwritten"]);
  }
  let complete = false;
  try {
    if (process.platform === "win32") protectWindowsFile(path);
    else fchmodSync(fd, 0o600);
    const api = gateway(profile, store.credentials(profile, true), store.redactor, transport);
    const result = await api.download({ entityId, attachmentId, all: name === "attachment download-all", original: name === "email download" ? flags.has("--original") : undefined,
      scope: flags.get("--scope") ?? (name === "email download" ? undefined : profile.scope) });
    const sha256 = createHash("sha256").update(result.content).digest("hex");
    if (sha256 !== result.sha256) throw new AxiError("Download SHA-256 does not match", "DOWNLOAD_HASH_MISMATCH", ["Discard the failed download and investigate before trying again"]);
    writeFileSync(fd, result.content);
    fsyncSync(fd);
    complete = true;
    return { path, size: result.content.length, sha256 };
  } catch (error) {
    if (error instanceof AxiError) throw error;
    throw new AxiError("Download could not complete", "DOWNLOAD_FAILED", ["Check the output directory and selected profile"]);
  } finally {
    closeSync(fd);
    if (!complete) unlinkSync(path);
  }
}
