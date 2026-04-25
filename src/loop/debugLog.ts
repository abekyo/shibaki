// Debug log writer. Not used in normal operation; only enabled via --debug
// when investigating false-negative / false-positive causes. To avoid colliding
// with principle 1 (don't show critic logs to humans), we only write to disk
// when the user explicitly passes the flag.
//
// Output location: ~/.shibaki/logs/<project>-<timestamp>.jsonl
//   - placing under cwd would scatter .shibaki/ directories across many repos
//   - centralizing under user-home lets you grep / bulk-clean / archive logs in one place
//   - including project basename in the filename makes logs from multiple repos easier to tell apart
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";

export interface DebugLogger {
  path: string;
  write(kind: string, payload: any): Promise<void>;
  close(): Promise<void>;
}

export async function openDebugLog(cwd: string): Promise<DebugLogger> {
  const dir = join(homedir(), ".shibaki", "logs");
  await mkdir(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  // project tag: even if multiple repos share a basename, the cwd recorded inside the log
  // disambiguates them, so basename alone is sufficient at the filename level.
  const projectTag = sanitizeForFilename(basename(cwd) || "root");
  const path = join(dir, `${projectTag}-${ts}.jsonl`);
  await writeFile(path, "");
  // Record cwd as the first entry (final disambiguator on basename collisions)
  const headerLine = JSON.stringify({ ts: Date.now(), kind: "session_meta", cwd }) + "\n";
  await appendFile(path, headerLine);
  return {
    path,
    async write(kind, payload) {
      const line = JSON.stringify({ ts: Date.now(), kind, ...payload }) + "\n";
      await appendFile(path, line);
    },
    async close() {
      // No explicit close needed (each append flushes), but kept for future extension
    },
  };
}

/** Replace filename-unsafe characters with _. Whitespace / / / : / control chars, etc. */
function sanitizeForFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);
}

export const NULL_LOGGER: DebugLogger = {
  path: "",
  async write() {},
  async close() {},
};
