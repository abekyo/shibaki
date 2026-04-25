// Failure-mode / success-pattern dictionary (Hermes-style markdown with § separators, persisted).
//
// At session start (= one Shibaki run), load the whole file → inject into the critic system
// prompt as a frozen snapshot. New patterns observed mid-session are not re-injected
// (preserves the frozen snapshot + keeps the Anthropic prompt cache consistent).
// At session end, batch-write everything back to the file.
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export type PatternType = "failure" | "success";

export interface Pattern {
  type: PatternType;
  pattern_name: string;     // snake_case
  description: string;      // one line
  hits: number;             // observation count
  last_seen: string;        // ISO date (yyyy-mm-dd)
}

const SEPARATOR = "\n§\n";

/** Parse patterns.md and return Pattern[]. Returns an empty array if the file is missing. */
export async function loadPatterns(path: string): Promise<Pattern[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return [];
  }
  const blocks = raw.split(SEPARATOR).map((b) => b.trim()).filter(Boolean);
  const patterns: Pattern[] = [];
  for (const block of blocks) {
    const p = parseBlock(block);
    if (p) patterns.push(p);
  }
  return patterns;
}

function parseBlock(block: string): Pattern | null {
  const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
  const fields: Record<string, string> = {};
  for (const line of lines) {
    const m = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (m) fields[m[1]] = m[2];
  }
  const type = (fields.type === "success" ? "success" : "failure") as PatternType;
  const pattern_name = fields.pattern_name?.trim();
  if (!pattern_name) return null;
  return {
    type,
    pattern_name,
    description: fields.description ?? "",
    hits: Math.max(1, Number(fields.hits ?? "1") || 1),
    last_seen: fields.last_seen ?? new Date().toISOString().slice(0, 10),
  };
}

/** Write back to patterns.md. Hermes-style § separators. */
export async function savePatterns(path: string, patterns: Pattern[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const blocks = patterns.map(formatBlock);
  // Placing a separator at the head makes appends easier
  const body = blocks.length > 0 ? SEPARATOR.trimStart() + blocks.join(SEPARATOR) + "\n" : "";
  await writeFile(path, body);
}

function formatBlock(p: Pattern): string {
  return [
    `type: ${p.type}`,
    `pattern_name: ${p.pattern_name}`,
    `description: ${p.description}`,
    `hits: ${p.hits}`,
    `last_seen: ${p.last_seen}`,
  ].join("\n");
}

/** Merge a new observation into existing patterns. Same (type, pattern_name) → hits++ and update last_seen. */
export function mergeObservation(
  patterns: Pattern[],
  observation: { type: PatternType; pattern_name: string; description: string },
  today: string = new Date().toISOString().slice(0, 10),
): Pattern[] {
  if (!observation.pattern_name) return patterns;
  const idx = patterns.findIndex(
    (p) => p.type === observation.type && p.pattern_name === observation.pattern_name,
  );
  if (idx >= 0) {
    const next = [...patterns];
    next[idx] = {
      ...next[idx],
      hits: next[idx].hits + 1,
      last_seen: today,
      // Adopt the new description if it's more specific (non-empty and longer)
      description:
        observation.description && observation.description.length > next[idx].description.length
          ? observation.description
          : next[idx].description,
    };
    return next;
  }
  return [
    ...patterns,
    {
      type: observation.type,
      pattern_name: observation.pattern_name,
      description: observation.description,
      hits: 1,
      last_seen: today,
    },
  ];
}

/** Prune older entries against a character cap (Hermes uses 2200; Shibaki tentatively uses 4000). */
export function prunePatterns(patterns: Pattern[], maxChars: number = 4000): Pattern[] {
  // Keep by hits desc; on ties, by last_seen desc
  const sorted = [...patterns].sort((a, b) => {
    if (b.hits !== a.hits) return b.hits - a.hits;
    return b.last_seen.localeCompare(a.last_seen);
  });
  const kept: Pattern[] = [];
  let total = 0;
  for (const p of sorted) {
    const block = formatBlock(p);
    if (total + block.length + SEPARATOR.length > maxChars) break;
    kept.push(p);
    total += block.length + SEPARATOR.length;
  }
  return kept;
}

/** Default save location for patterns.md. CWD/.shibaki/patterns.md */
export function defaultPatternsPath(cwd: string = process.cwd()): string {
  return join(cwd, ".shibaki", "patterns.md");
}

/** Check whether the existing file exists (for debug). */
export async function patternsFileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}
