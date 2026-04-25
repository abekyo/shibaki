// Level 2: project-wide context collection to give the critic "a viewpoint different from the agent".
//
// Design intent (insight from self-verification 2026-04-24):
//   The critic had only a strict subset of the agent's info, so it often couldn't offer a
//   different viewpoint and ran into hallucinations.
//   By additionally handing project conventions (CLAUDE.md) / project structure / dependencies
//   to the critic, the critic can pull in conventions that "the agent isn't looking at / isn't enforced on the agent".
//
// Frozen during one session (orchestrator collects once at startup, passes the same one every try)
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface ProjectContext {
  conventionDocs: { path: string; content: string }[]; // CLAUDE.md / CONTRIBUTING.md / AGENTS.md
  readmeHead: string;                                    // Head of README.md (conventions and design intent are often written here)
  packageJson: string;                                   // dependencies / scripts (infer tech stack)
  sourceTree: string;                                    // Shallow tree of src/ + tests/
}

const CONVENTION_FILE_NAMES = ["CLAUDE.md", "AGENTS.md", "CONTRIBUTING.md"];
const README_HEAD_BYTES = 2500;
const CONVENTION_MAX_BYTES = 4000;
const PACKAGE_JSON_MAX_BYTES = 1500;
const SOURCE_TREE_MAX_BYTES = 2000;
const SOURCE_TREE_DIRS = ["src", "lib", "app", "tests", "docs"];
const SOURCE_TREE_MAX_DEPTH = 3;
const SOURCE_TREE_MAX_FILES = 60;

/** Collect project-wide context (Level 2: material for a different viewpoint) */
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
    // Narrow to dependencies / scripts only (license / author etc. are noise)
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
