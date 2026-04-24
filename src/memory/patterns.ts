// 失敗モード / 成功パターン辞書 (Hermes 式 markdown + § 区切り永続化)
//
// セッション (= 1 Shibaki run) 開始時に丸ごと load → critic system prompt に
// frozen snapshot として注入。session 中に新規 pattern を観測しても再注入はしない
// (frozen snapshot 維持 + Anthropic prompt cache 整合)。
// session 終了時にまとめてファイルへ書き戻す。
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export type PatternType = "failure" | "success";

export interface Pattern {
  type: PatternType;
  pattern_name: string;     // snake_case
  description: string;      // 1 行
  hits: number;             // 観測回数
  last_seen: string;        // ISO date (yyyy-mm-dd)
}

const SEPARATOR = "\n§\n";

/** patterns.md をパースして Pattern[] を返す。ファイルが無ければ空配列。 */
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

/** patterns.md に書き戻す。Hermes 式 § 区切り。 */
export async function savePatterns(path: string, patterns: Pattern[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const blocks = patterns.map(formatBlock);
  // 先頭にも区切りを置いておくと append しやすい
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

/** 既存 patterns に新規観測を merge。同じ (type, pattern_name) なら hits++ + last_seen 更新。 */
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
      // description は新規の方が具体的なら採用 (空でなく長い方)
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

/** 文字数上限で古いものを prune (Hermes は 2200 字、Shibaki は 4000 字を仮置き)。 */
export function prunePatterns(patterns: Pattern[], maxChars: number = 4000): Pattern[] {
  // hits 多い順、同点なら last_seen 新しい順で残す
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

/** patterns.md のデフォルト保存先。CWD/.shibaki/patterns.md */
export function defaultPatternsPath(cwd: string = process.cwd()): string {
  return join(cwd, ".shibaki", "patterns.md");
}

/** 既存ファイル存在確認 (debug 用)。 */
export async function patternsFileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}
