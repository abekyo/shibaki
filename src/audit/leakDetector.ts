// Release-time leak detector。critic loop とは独立した deterministic layer。
//
// 検出対象:
// 1. tracked files 内の secret pattern (gitleaks ライク regex)
// 2. tracked files 内の user-supplied 禁止語 (.shibaki/sensitive-strings.txt)
// 3. git commit message / author / committer にある同じ禁止語
// 4. AI cross-session leak の代表パターン (commit message に過去の名前 / プロジェクト)
//
// release 直前に 1 回走らせる前提。dev iteration loop には入れない。
import { readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve, isAbsolute } from "node:path";
import { SECRET_PATTERNS, isTestOrDocsPath, type SecretPattern } from "./secretPatterns.ts";

export type LeakKind = "secret" | "custom_string" | "git_metadata";

export interface Leak {
  kind: LeakKind;
  patternId: string;          // SECRET_PATTERNS の id or "custom" or "git_<sub>"
  description: string;
  location: string;           // file path or "git:<ref>"
  excerpt: string;            // 検出箇所周辺 (token 自体は伏せる)
  line?: number;
}

export interface AuditResult {
  ok: boolean;
  leaks: Leak[];
  scannedFiles: number;
  scannedCommits: number;
  customStringCount: number;
}

/** メイン audit エントリ */
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
      // 2a. commit message の secret pattern
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
      // 2b. commit message の custom 禁止語
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
      // 2c. author / committer 名 / email も chk
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

/** ファイル単位で secret + custom string を scan */
async function scanFile(cwd: string, relPath: string, customStrings: string[]): Promise<Leak[]> {
  const abs = isAbsolute(relPath) ? relPath : resolve(cwd, relPath);
  let content: string;
  try {
    const s = await stat(abs);
    if (!s.isFile() || s.size > 5 * 1024 * 1024) return []; // 5MB 超は skip (画像 / lock 等)
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
      // テスト / docs では「明らかにダミー」(xxx, fake, example) は除外
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

  // custom 禁止語
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

/** "xxx" / "fake" / "example" / "dummy" / "test" を含む or 同一文字 4 連以上 で dummy 扱い */
function looksLikeDummy(s: string): boolean {
  const lower = s.toLowerCase();
  if (/(?:xxx+|fake|example|dummy|test|placeholder|sample)/.test(lower)) return true;
  // 同一文字 4 連 (AAAA / aaaa / 1111 等) はテスト用 fixture とみなす
  if (/(.)\1{3,}/.test(s)) return true;
  return false;
}

/** secret 値を伏せて出力 (先頭 8 文字 + ... + 末尾 4 文字) */
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
  // git args に null byte は入れられないので、特殊文字列で commit を区切る
  // フィールドは RS (0x1e)、commit は --- SHIBAKI_COMMIT_SEP --- マーカーで区切る
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
