// debug ログ書き出し。通常運用では使わず、false negative / false positive の
// 原因調査時のみ --debug で起動する。原則1 (critic ログを人間に見せない) と衝突しないよう、
// ユーザーが明示的にフラグを付けた時のみファイルに書き出す。
//
// 出力場所: ~/.shibaki/logs/<project>-<timestamp>.jsonl
//   - cwd 配下に置くと複数 repo を跨ぐと .shibaki/ ディレクトリが各所に散らばる
//   - user-home に集約すれば logs を 1 箇所で grep / 一括掃除 / アーカイブ できる
//   - filename に project basename を含めて、複数 repo の log を区別しやすくする
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
  // project tag: 同じ basename の repo が複数あっても、log の中の cwd 記録で
  // 区別できるので filename レベルでは basename だけで十分。
  const projectTag = sanitizeForFilename(basename(cwd) || "root");
  const path = join(dir, `${projectTag}-${ts}.jsonl`);
  await writeFile(path, "");
  // 最初の record として cwd を残す (basename 衝突時の最終的な区別子)
  const headerLine = JSON.stringify({ ts: Date.now(), kind: "session_meta", cwd }) + "\n";
  await appendFile(path, headerLine);
  return {
    path,
    async write(kind, payload) {
      const line = JSON.stringify({ ts: Date.now(), kind, ...payload }) + "\n";
      await appendFile(path, line);
    },
    async close() {
      // 明示的な close は不要 (append ごとに flush される) が将来拡張用に残す
    },
  };
}

/** filename に使えない文字を _ に置換。空白 / / / : / 制御文字など。 */
function sanitizeForFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);
}

export const NULL_LOGGER: DebugLogger = {
  path: "",
  async write() {},
  async close() {},
};
