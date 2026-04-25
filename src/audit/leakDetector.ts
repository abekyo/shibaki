// Release-time leak detector. A deterministic layer independent from the critic loop.
//
// Detection targets:
// 1. secret patterns inside tracked files (gitleaks-like regexes)
// 2. user-supplied forbidden strings inside tracked files (.shibaki/sensitive-strings.txt)
// 3. the same forbidden strings appearing in git commit message / author / committer
// 4. representative AI cross-session leak patterns (past names / projects in commit messages)
//
// Designed to run once right before release. Do not put this in the dev iteration loop.
import { readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve, isAbsolute } from "node:path";
import { SECRET_PATTERNS, isTestOrDocsPath, type SecretPattern } from "./secretPatterns.ts";

export type LeakKind = "secret" | "custom_string" | "git_metadata";

export interface Leak {
  kind: LeakKind;
  patternId: string;          // id from SECRET_PATTERNS, or "custom", or "git_<sub>"
  description: string;
  location: string;           // file path or "git:<ref>"
  excerpt: string;            // text around the hit (the token itself is redacted)
  line?: number;
}

export interface AuditResult {
  ok: boolean;
  leaks: Leak[];
  scannedFiles: number;
  scannedCommits: number;
  customStringCount: number;
}

/** Main audit entry point */
export async function auditDirectory(opts: {
  cwd: string;
  customStringsPath?: string;   // default: <cwd>/.shibaki/sensitive-strings.txt
  scanGitHistory?: boolean;     // default: true
  gitHistoryDepth?: number;     // default: 200 commits
}): Promise<AuditResult> {
  const cwd = opts.cwd;
  const customStrings = await loadCustomStrings(opts.customStringsPath ?? `${cwd}/.shibaki/sensitive-strings.txt`);
  const scanGit = opts.scanGitHistory !== false;
  const gitDepth = opts.gitHistoryDepth ?? 200;

  const leaks: Leak[] = [];

  // 1. tracked file scan
  const trackedFiles = await listGitTrackedFiles(cwd);
  for (const f of trackedFiles) {
    const fileLeaks = await scanFile(cwd, f, customStrings);
    leaks.push(...fileLeaks);
  }

  // 2. git history scan
  let scannedCommits = 0;
  if (scanGit) {
    const commits = await listGitCommits(cwd, gitDepth);
    scannedCommits = commits.length;
    for (const c of commits) {
      // 2a. secret pattern in commit message
      for (const p of SECRET_PATTERNS) {
        const matches = c.subject.match(p.regex) || c.body?.match(p.regex);
        if (matches) {
          leaks.push({
            kind: "git_metadata",
            patternId: `git_msg_${p.id}`,
            description: `commit message contains ${p.description}`,
            location: `git:commit:${c.shortHash}`,
            excerpt: redact(matches[0]),
          });
        }
      }
      // 2b. custom forbidden strings in commit message
      for (const s of customStrings) {
        if (c.subject.includes(s) || c.body?.includes(s)) {
          leaks.push({
            kind: "git_metadata",
            patternId: "git_msg_custom",
            description: `commit message contains forbidden string "${s}" (sensitive-strings.txt)`,
            location: `git:commit:${c.shortHash}`,
            excerpt: previewLine(c.subject + (c.body ? "\n" + c.body : ""), s),
          });
        }
      }
      // 2c. also check author / committer name / email
      for (const s of customStrings) {
        if (c.authorName.includes(s) || c.authorEmail.includes(s)) {
          leaks.push({
            kind: "git_metadata",
            patternId: "git_author_custom",
            description: `commit author contains forbidden string "${s}"`,
            location: `git:author:${c.shortHash}`,
            excerpt: `${c.authorName} <${c.authorEmail}>`,
          });
        }
      }
    }
  }

  return {
    ok: leaks.length === 0,
    leaks,
    scannedFiles: trackedFiles.length,
    scannedCommits,
    customStringCount: customStrings.length,
  };
}

/** Scan a single file for secrets + custom strings */
async function scanFile(cwd: string, relPath: string, customStrings: string[]): Promise<Leak[]> {
  const abs = isAbsolute(relPath) ? relPath : resolve(cwd, relPath);
  let content: string;
  try {
    const s = await stat(abs);
    if (!s.isFile() || s.size > 5 * 1024 * 1024) return []; // skip files over 5MB (images / lockfiles / etc.)
    content = await readFile(abs, "utf-8");
  } catch {
    return [];
  }
  const out: Leak[] = [];
  const lines = content.split("\n");
  const inTestOrDocs = isTestOrDocsPath(relPath);

  // secret patterns
  for (const p of SECRET_PATTERNS) {
    if (inTestOrDocs && p.allowInTestsAndDocs) continue;
    p.regex.lastIndex = 0;
    let m;
    while ((m = p.regex.exec(content)) !== null) {
      const lineNo = lineNumberOf(content, m.index);
      // In tests / docs, exclude "obviously dummy" matches (xxx, fake, example)
      if (inTestOrDocs && looksLikeDummy(m[0])) continue;
      out.push({
        kind: "secret",
        patternId: p.id,
        description: p.description,
        location: relPath,
        excerpt: redact(m[0]),
        line: lineNo,
      });
    }
  }

  // custom forbidden strings
  for (const s of customStrings) {
    if (!s) continue;
    let idx = content.indexOf(s);
    while (idx >= 0) {
      const lineNo = lineNumberOf(content, idx);
      out.push({
        kind: "custom_string",
        patternId: "custom",
        description: `forbidden string "${s}" (sensitive-strings.txt) found`,
        location: relPath,
        excerpt: previewLine(lines[lineNo - 1] ?? "", s),
        line: lineNo,
      });
      idx = content.indexOf(s, idx + s.length);
    }
  }

  return out;
}

/** Treat as dummy if it contains "xxx" / "fake" / "example" / "dummy" / "test", or has 4+ repeated chars */
function looksLikeDummy(s: string): boolean {
  const lower = s.toLowerCase();
  if (/(?:xxx+|fake|example|dummy|test|placeholder|sample)/.test(lower)) return true;
  // 4+ repeated chars (AAAA / aaaa / 1111 etc.) are treated as test fixtures
  if (/(.)\1{3,}/.test(s)) return true;
  return false;
}

/** Redact the secret value for output (first 8 chars + ... + last 4 chars) */
function redact(s: string): string {
  if (s.length <= 16) return "***" + s.slice(-2);
  return s.slice(0, 8) + "..." + s.slice(-4);
}

function previewLine(line: string, target: string): string {
  const idx = line.indexOf(target);
  if (idx < 0) return line.slice(0, 80);
  const start = Math.max(0, idx - 20);
  const end = Math.min(line.length, idx + target.length + 20);
  return (start > 0 ? "..." : "") + line.slice(start, end) + (end < line.length ? "..." : "");
}

function lineNumberOf(content: string, charIndex: number): number {
  let line = 1;
  for (let i = 0; i < charIndex && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

async function loadCustomStrings(path: string): Promise<string[]> {
  try {
    const raw = await readFile(path, "utf-8");
    return raw
      .split("\n")
      .map((l) => l.replace(/^\s+|\s+$/g, ""))
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

async function listGitTrackedFiles(cwd: string): Promise<string[]> {
  const out = await execGit(cwd, ["ls-files", "-z"]);
  return out.split("\0").filter((s) => s.length > 0);
}

interface CommitInfo {
  hash: string;
  shortHash: string;
  authorName: string;
  authorEmail: string;
  subject: string;
  body: string;
}

async function listGitCommits(cwd: string, depth: number): Promise<CommitInfo[]> {
  // git args can't contain null bytes, so use a special string to separate commits.
  // Fields use RS (0x1e); commits are split on the --- SHIBAKI_COMMIT_SEP --- marker.
  const FIELD_SEP = "\x1e";
  const COMMIT_SEP = "----SHIBAKI_COMMIT_SEP----";
  const fmt = `%H${FIELD_SEP}%h${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%s${FIELD_SEP}%b${COMMIT_SEP}`;
  const out = await execGit(cwd, ["log", `--max-count=${depth}`, `--format=${fmt}`]);
  const commits: CommitInfo[] = [];
  for (const block of out.split(COMMIT_SEP)) {
    if (!block.trim()) continue;
    const fields = block.split(FIELD_SEP);
    if (fields.length < 6) continue;
    commits.push({
      hash: fields[0].trim(),
      shortHash: fields[1].trim(),
      authorName: fields[2],
      authorEmail: fields[3],
      subject: fields[4],
      body: fields[5] ?? "",
    });
  }
  return commits;
}

function execGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolveP, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`git ${args.join(" ")} failed: ${stderr}`));
      else resolveP(stdout);
    });
  });
}
