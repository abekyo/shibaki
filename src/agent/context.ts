// critic に渡す文脈を収集する helpers。
// 基本方針: 変更ファイルの全文 + テストファイルの全文 + 過去 diff を critic に見せる
// ことで、"diff だけ見て表面分析" から "実装全体を見て深い分析" に昇格させる。
import { readFile, stat } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";

export interface FileSnapshot {
  path: string;    // リポジトリ相対パス
  content: string; // 丸ごと (maxBytes で切り詰め)
  bytes: number;   // オリジナルのバイト長
  truncated: boolean;
}

/** git diff から `+++ b/path` 行を抽出してファイルパス一覧を返す。削除ファイルは除外。 */
export function parseDiffFiles(diff: string): string[] {
  if (!diff) return [];
  const paths = new Set<string>();
  for (const line of diff.split("\n")) {
    // `+++ b/src/foo.ts` または `+++ /dev/null`
    const m = /^\+\+\+ b\/(.+)$/.exec(line);
    if (m && m[1] !== "/dev/null") paths.add(m[1]);
  }
  return [...paths];
}

/** `bun test tests/foo.test.ts` 形式の verify cmd から test ファイルを best-effort で抽出。 */
export function extractTestPaths(verifyCmd: string): string[] {
  if (!verifyCmd) return [];
  const tokens = verifyCmd.split(/\s+/);
  const paths: string[] = [];
  for (const t of tokens) {
    // ".test.ts" or ".spec.ts" 拡張子を持つトークンを test ファイルとみなす
    if (/\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(t)) {
      paths.push(t);
    }
  }
  return paths;
}

/** ファイルを bytes 上限で読む。バイナリ / 存在しないファイルは null を返す。 */
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
    // 先頭 maxBytes に切り詰め (末尾の方が修正されやすいが Phase 1 は単純化)
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

/** 変更ファイル + テストファイル + 追加読み込み対象をまとめて回収。 */
export async function collectContextFiles(opts: {
  cwd: string;
  diff: string;
  verifyCmd: string;
  maxFiles?: number;       // 合計ファイル数上限 (default 8)
  maxBytesPerFile?: number; // 1 ファイル上限バイト数 (default 20000)
}): Promise<{ modifiedFiles: FileSnapshot[]; testFiles: FileSnapshot[] }> {
  const maxFiles = opts.maxFiles ?? 8;
  const maxBytes = opts.maxBytesPerFile ?? 20000;

  const modifiedPaths = parseDiffFiles(opts.diff).slice(0, maxFiles);
  const testPaths = extractTestPaths(opts.verifyCmd);
  // test ファイルが既に modified に含まれていたら重複を避ける
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
  return { modifiedFiles: modifiedSnapshots, testFiles: testSnapshots };
}
