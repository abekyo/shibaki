// Helpers that collect context to be handed to the critic.
// Basic policy: show the critic the full text of changed files + full text of test files + past diff,
// promoting from "surface analysis from diff alone" to "deep analysis viewing the whole implementation".
//
// Phase 1 (1-hop import expansion):
// Auto-bundle files imported via relative paths from the changed files, one hop only.
// This mitigates Cheat 9 class problems (symptom-only fix, root cause left alone) that
// were missed because "the Critic didn't know the behavior of dependencies".
// Zero side effects (no new flags, output schema unchanged, works on all providers) — tokens
// only grow slightly. Size budget caps the upper bound.
import { readFile, stat } from "node:fs/promises";
import { resolve, isAbsolute, dirname, join, normalize } from "node:path";

export interface FileSnapshot {
  path: string;    // Repo-relative path
  content: string; // Whole file (truncated at maxBytes)
  bytes: number;   // Original byte length
  truncated: boolean;
}

/** Extract `+++ b/path` lines from a git diff and return the list of file paths. Deleted files excluded. */
export function parseDiffFiles(diff: string): string[] {
  if (!diff) return [];
  const paths = new Set<string>();
  for (const line of diff.split("\n")) {
    // `+++ b/src/foo.ts` or `+++ /dev/null`
    const m = /^\+\+\+ b\/(.+)$/.exec(line);
    if (m && m[1] !== "/dev/null") paths.add(m[1]);
  }
  return [...paths];
}

/** Extract relative-path import / require / export-from from TS / JS source.
 *  - `from "./foo"` / `from '../bar'` (import / re-export)
 *  - `require("./baz")`
 *  - `import "./side-effect"`
 *  External modules (`react`, `node:fs`, `@scope/pkg`, etc.) are excluded.
 *  Phase 1 is regex-based without an AST. False positives inside comments are tolerated
 *  (the size budget caps things anyway).
 */
export function parseRelativeImports(src: string): string[] {
  if (!src) return [];
  const found = new Set<string>();
  const patterns: RegExp[] = [
    /\bfrom\s+["']([^"']+)["']/g,                  // import X from "..." / export ... from "..."
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,     // require("...")
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,      // dynamic import("...")
    // side-effect import "...". `\bimport\s+["']` only matches when import is followed by
    // space then quote, so it doesn't react to `import X from` (X follows) or `import("...")`
    // (`(` follows). It can also detect multiple imports on one line like
    // `import "./a"; import "./b";` (since no line-anchor is used).
    /\bimport\s+["']([^"']+)["']/g,
  ];
  for (const re of patterns) {
    for (const m of src.matchAll(re)) {
      const p = m[1];
      if (p.startsWith("./") || p.startsWith("../")) {
        found.add(p);
      }
    }
  }
  return [...found];
}

const IMPORT_RESOLVE_EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/** Safety-check candidate paths: reject escape outside cwd / node_modules / absolute paths.
 *  Phase 1 runs enabled by default, so we need a safety net that prevents leaking files
 *  outside the repo to the Critic without the user noticing. Things like `../etc/passwd`
 *  start with `..` after normalization, so they're detectable.
 */
function isSafeRelPath(rel: string): boolean {
  if (!rel) return false;
  if (isAbsolute(rel)) return false;
  if (rel.startsWith("..")) return false;
  // Mid-path escapes like `a/../../b` shouldn't happen after normalize, but just in case
  if (rel.split(/[/\\]/).includes("..")) return false;
  // Paths containing node_modules are not expansion targets (don't stream bundled huge code to Critic)
  if (rel.split(/[/\\]/).includes("node_modules")) return false;
  return true;
}

/** Resolve a relative import to a real file path (cwd-relative). Returns null on failure.
 *  - `./bar` → tries `./bar.ts` / `./bar/index.ts` etc. in order
 *  - `.ts` suffix specifications (NodeNext) are also allowed as-is
 *  - The resulting path is normalized cwd-relative (e.g., "src/utils.ts")
 *  - Returns null for paths outside cwd / node_modules / absolute paths (safety net)
 */
export async function resolveImport(
  fromFile: string,
  importPath: string,
  cwd: string,
): Promise<string | null> {
  const fromDir = dirname(fromFile);
  const baseRel = normalize(join(fromDir, importPath));
  if (!isSafeRelPath(baseRel)) return null;
  // Direct file hit (both with and without extension)
  for (const ext of IMPORT_RESOLVE_EXTS) {
    const candidate = baseRel + ext;
    if (!isSafeRelPath(candidate)) continue;
    const abs = resolve(cwd, candidate);
    try {
      const st = await stat(abs);
      if (st.isFile()) return candidate;
    } catch { /* try next */ }
  }
  // Directory + index.* resolution
  for (const ext of IMPORT_RESOLVE_EXTS.slice(1)) {
    const candidate = join(baseRel, "index" + ext);
    if (!isSafeRelPath(candidate)) continue;
    const abs = resolve(cwd, candidate);
    try {
      const st = await stat(abs);
      if (st.isFile()) return candidate;
    } catch { /* try next */ }
  }
  return null;
}

/** Best-effort extraction of test files from a verify cmd like `bun test tests/foo.test.ts`. */
export function extractTestPaths(verifyCmd: string): string[] {
  if (!verifyCmd) return [];
  const tokens = verifyCmd.split(/\s+/);
  const paths: string[] = [];
  for (const t of tokens) {
    // Tokens with ".test.ts" or ".spec.ts" extensions are treated as test files
    if (/\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(t)) {
      paths.push(t);
    }
  }
  return paths;
}

/** Read a file with a bytes cap. Returns null for binary / missing files. */
export async function readFileBounded(
  path: string,
  cwd: string,
  maxBytes: number,
): Promise<FileSnapshot | null> {
  const abs = isAbsolute(path) ? path : resolve(cwd, path);
  try {
    const st = await stat(abs);
    if (!st.isFile()) return null;
    const full = await readFile(abs, "utf-8");
    const bytes = Buffer.byteLength(full, "utf-8");
    if (bytes <= maxBytes) {
      return { path, content: full, bytes, truncated: false };
    }
    // Truncate to leading maxBytes (the tail is more often modified, but Phase 1 keeps it simple)
    return {
      path,
      content: full.slice(0, maxBytes) + `\n... (truncated, original ${bytes} bytes)`,
      bytes,
      truncated: true,
    };
  } catch {
    return null;
  }
}

/** Collect changed files + test files + additional read targets together.
 *
 *  Phase 1: Auto-bundle files that the changed files import via relative paths,
 *  one hop only (dependencyFiles). Can be disabled with expandImports=false.
 *  Existing callers are auto-enabled by default (no UX impact, only slight token growth).
 */
export async function collectContextFiles(opts: {
  cwd: string;
  diff: string;
  verifyCmd: string;
  maxFiles?: number;            // Total file count cap (default 8)
  maxBytesPerFile?: number;      // Per-file byte cap (default 20000)
  expandImports?: boolean;       // Phase 1: 1-hop import expansion (default true)
  maxDependencyFiles?: number;   // Dependency file count cap (default 5)
  maxDependencyBytes?: number;   // Per-dependency-file byte cap (default 10000)
}): Promise<{
  modifiedFiles: FileSnapshot[];
  testFiles: FileSnapshot[];
  dependencyFiles: FileSnapshot[];
}> {
  const maxFiles = opts.maxFiles ?? 8;
  const maxBytes = opts.maxBytesPerFile ?? 20000;

  const modifiedPaths = parseDiffFiles(opts.diff).slice(0, maxFiles);
  const testPaths = extractTestPaths(opts.verifyCmd);
  // If a test file is already in modified, avoid duplication
  const uniqueTestPaths = testPaths.filter((p) => !modifiedPaths.includes(p));

  const modifiedSnapshots: FileSnapshot[] = [];
  for (const p of modifiedPaths) {
    const snap = await readFileBounded(p, opts.cwd, maxBytes);
    if (snap) modifiedSnapshots.push(snap);
  }
  const testSnapshots: FileSnapshot[] = [];
  for (const p of uniqueTestPaths) {
    const snap = await readFileBounded(p, opts.cwd, maxBytes);
    if (snap) testSnapshots.push(snap);
  }

  // Phase 1: 1-hop import expansion
  const expand = opts.expandImports ?? true;
  const dependencySnapshots: FileSnapshot[] = [];
  if (expand && modifiedSnapshots.length > 0) {
    const maxDeps = opts.maxDependencyFiles ?? 5;
    const maxDepBytes = opts.maxDependencyBytes ?? 10000;
    const seen = new Set<string>([
      ...modifiedSnapshots.map((s) => s.path),
      ...testSnapshots.map((s) => s.path),
    ]);
    const depCandidates: string[] = [];
    for (const snap of modifiedSnapshots) {
      const imports = parseRelativeImports(snap.content);
      for (const imp of imports) {
        const resolved = await resolveImport(snap.path, imp, opts.cwd);
        if (!resolved) continue;
        if (seen.has(resolved)) continue;
        seen.add(resolved);
        depCandidates.push(resolved);
        if (depCandidates.length >= maxDeps) break;
      }
      if (depCandidates.length >= maxDeps) break;
    }
    for (const path of depCandidates) {
      const snap = await readFileBounded(path, opts.cwd, maxDepBytes);
      if (snap) dependencySnapshots.push(snap);
    }
  }

  return {
    modifiedFiles: modifiedSnapshots,
    testFiles: testSnapshots,
    dependencyFiles: dependencySnapshots,
  };
}
