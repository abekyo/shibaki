// Level 2: critic に "agent と異なる視点" を渡すための project-wide context 収集。
//
// 設計意図 (self-verification 2026-04-24 の知見):
//   critic は agent の strict subset の情報しか持っていなかったため、
//   別視点を出せず幻覚に走るケースが多かった。
//   project 規約 (CLAUDE.md) / プロジェクト構造 / 依存関係を critic に追加で渡すことで、
//   "agent が見ていない / agent には強制されない" 規約を critic が引っ張れるようにする。
//
// 1 セッション中は frozen (orchestrator が起動時に 1 回収集、毎試行同じものを渡す)
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface ProjectContext {
  conventionDocs: { path: string; content: string }[]; // CLAUDE.md / CONTRIBUTING.md / AGENTS.md
  readmeHead: string;                                    // README.md の冒頭 (規約や設計意図が書かれていることが多い)
  packageJson: string;                                   // dependencies / scripts (tech stack 推察)
  sourceTree: string;                                    // src/ + tests/ の浅いツリー
}

const CONVENTION_FILE_NAMES = ["CLAUDE.md", "AGENTS.md", "CONTRIBUTING.md"];
const README_HEAD_BYTES = 2500;
const CONVENTION_MAX_BYTES = 4000;
const PACKAGE_JSON_MAX_BYTES = 1500;
const SOURCE_TREE_MAX_BYTES = 2000;
const SOURCE_TREE_DIRS = ["src", "lib", "app", "tests", "docs"];
const SOURCE_TREE_MAX_DEPTH = 3;
const SOURCE_TREE_MAX_FILES = 60;

/** project 全体のコンテキストを収集 (Level 2: 別視点の素材) */
export async function collectProjectContext(cwd: string): Promise<ProjectContext> {
  const [conventionDocs, readmeHead, packageJson, sourceTree] = await Promise.all([
    collectConventionDocs(cwd),
    readReadmeHead(cwd),
    readPackageJson(cwd),
    buildSourceTree(cwd),
  ]);
  return { conventionDocs, readmeHead, packageJson, sourceTree };
}

async function collectConventionDocs(cwd: string): Promise<{ path: string; content: string }[]> {
  const out: { path: string; content: string }[] = [];
  for (const name of CONVENTION_FILE_NAMES) {
    const p = join(cwd, name);
    try {
      const s = await stat(p);
      if (!s.isFile()) continue;
      const content = await readFile(p, "utf-8");
      out.push({
        path: name,
        content: content.length > CONVENTION_MAX_BYTES
          ? content.slice(0, CONVENTION_MAX_BYTES) + "\n... (truncated)"
          : content,
      });
    } catch {
      // ignore (file not present)
    }
  }
  return out;
}

async function readReadmeHead(cwd: string): Promise<string> {
  for (const name of ["README.md", "readme.md", "README.MD"]) {
    try {
      const c = await readFile(join(cwd, name), "utf-8");
      return c.length > README_HEAD_BYTES
        ? c.slice(0, README_HEAD_BYTES) + "\n... (truncated)"
        : c;
    } catch {
      // try next
    }
  }
  return "";
}

async function readPackageJson(cwd: string): Promise<string> {
  try {
    const raw = await readFile(join(cwd, "package.json"), "utf-8");
    // dependencies / scripts のみに絞る (license / author 等はノイズ)
    const obj = JSON.parse(raw);
    const filtered: Record<string, unknown> = {};
    for (const k of ["name", "version", "type", "scripts", "dependencies", "devDependencies", "engines"]) {
      if (k in obj) filtered[k] = (obj as Record<string, unknown>)[k];
    }
    const s = JSON.stringify(filtered, null, 2);
    return s.length > PACKAGE_JSON_MAX_BYTES
      ? s.slice(0, PACKAGE_JSON_MAX_BYTES) + "\n... (truncated)"
      : s;
  } catch {
    return "";
  }
}

async function buildSourceTree(cwd: string): Promise<string> {
  const lines: string[] = [];
  let fileCount = 0;
  for (const dir of SOURCE_TREE_DIRS) {
    const dirPath = join(cwd, dir);
    try {
      const s = await stat(dirPath);
      if (!s.isDirectory()) continue;
    } catch {
      continue;
    }
    lines.push(`${dir}/`);
    await walkDir(dirPath, dir, 1, lines, () => fileCount++, () => fileCount);
    if (fileCount >= SOURCE_TREE_MAX_FILES) {
      lines.push("... (file limit reached)");
      break;
    }
  }
  const out = lines.join("\n");
  return out.length > SOURCE_TREE_MAX_BYTES
    ? out.slice(0, SOURCE_TREE_MAX_BYTES) + "\n... (truncated)"
    : out;
}

async function walkDir(
  abs: string,
  rel: string,
  depth: number,
  lines: string[],
  inc: () => void,
  count: () => number,
): Promise<void> {
  if (depth > SOURCE_TREE_MAX_DEPTH || count() >= SOURCE_TREE_MAX_FILES) return;
  let entries: { name: string; isDir: boolean }[];
  try {
    const items = await readdir(abs, { withFileTypes: true });
    entries = items
      .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "dist")
      .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  } catch {
    return;
  }
  const indent = "  ".repeat(depth);
  for (const e of entries) {
    if (count() >= SOURCE_TREE_MAX_FILES) {
      lines.push(`${indent}... (file limit reached)`);
      return;
    }
    if (e.isDir) {
      lines.push(`${indent}${e.name}/`);
      await walkDir(join(abs, e.name), `${rel}/${e.name}`, depth + 1, lines, inc, count);
    } else {
      lines.push(`${indent}${e.name}`);
      inc();
    }
  }
}
