// debug ログ書き出し。通常運用では使わず、false negative / false positive の
// 原因調査時のみ --debug で起動する。原則1 (critic ログを人間に見せない) と衝突しないよう、
// ユーザーが明示的にフラグを付けた時のみファイルに書き出す。
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";

export interface DebugLogger {
  path: string;
  write(kind: string, payload: any): Promise<void>;
  close(): Promise<void>;
}

export async function openDebugLog(cwd: string): Promise<DebugLogger> {
  const dir = join(cwd, ".shibaki");
  await mkdir(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `run-${ts}.jsonl`);
  await writeFile(path, "");
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

export const NULL_LOGGER: DebugLogger = {
  path: "",
  async write() {},
  async close() {},
};
