// CLI-backed provider の共通 subprocess 起動ロジック。
//
// claude-cli / gemini-cli / codex-cli は全て「ローカル CLI に prompt を渡して
// stdout で結果を受け取る」という同じ形。spawn + timeout + 出力上限 cap を
// ここに集約する。
//
// セキュリティ:
//  - 引数は必ず array で spawn (shell なし) — injection 回避
//  - critic から呼ぶので、ユーザーの prompt を混ぜた文字列を shell に渡さない
//
// 注意: CLI のバージョン差で flag が変わる可能性がある。ユーザーが上書きしたい
// 場合は env (CLAUDE_CLI_BIN など) で実バイナリ名だけ差し替えできるようにする。
import { spawn } from "node:child_process";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024; // 2 MiB
const DEFAULT_TIMEOUT_MS = 180_000; // 3 分 (大きい model は応答遅め)

export interface CliSpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface CliSpawnOptions {
  bin: string;
  args: string[];
  stdin?: string;
  timeoutMs?: number;
  /** spawn 時の env override。未指定なら process.env */
  env?: NodeJS.ProcessEnv;
}

export async function cliSpawn(opts: CliSpawnOptions): Promise<CliSpawnResult> {
  const t0 = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const child = spawn(opts.bin, opts.args, {
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutTrunc = false;
    let stderrTrunc = false;
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* swallow */ }
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* swallow */ } }, 3000);
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      if (stdoutTrunc) return;
      const s = d.toString();
      if (stdout.length + s.length > MAX_OUTPUT_BYTES) {
        stdout += s.slice(0, MAX_OUTPUT_BYTES - stdout.length);
        stdoutTrunc = true;
      } else {
        stdout += s;
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderrTrunc) return;
      const s = d.toString();
      if (stderr.length + s.length > MAX_OUTPUT_BYTES) {
        stderr += s.slice(0, MAX_OUTPUT_BYTES - stderr.length);
        stderrTrunc = true;
      } else {
        stderr += s;
      }
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(new Error(
          `CLI not found: ${opts.bin}. ` +
          `Install the CLI or set PATH / override bin via env.`
        ));
        return;
      }
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 0,
        durationMs: Date.now() - t0,
      });
    });

    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();
  });
}

/** system + user を CLI prompt に合成する。
 *  API 系の role 分離が無い CLI (claude -p / codex exec 等) ではこの形で渡すのが一番確実。 */
export function composeCliPrompt(system: string, user: string, jsonMode: boolean): string {
  const parts: string[] = [];
  if (system && system.trim()) {
    parts.push("# System\n" + system.trim());
  }
  if (jsonMode) {
    parts.push(
      "# Output format (strict)\n" +
      "- Reply with EXACTLY ONE valid JSON object.\n" +
      "- Start with `{`, end with `}`.\n" +
      "- Do NOT wrap in code fences (```).\n" +
      "- Do NOT include any text before or after the JSON."
    );
  }
  parts.push("# Task\n" + user);
  return parts.join("\n\n");
}

/** CLI which-check 用。未インストール時 testApiKey で親切なエラーを出すのに使う。 */
export async function cliAvailable(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = spawn("which", [bin], { stdio: "ignore" });
    c.on("close", (code) => resolve(code === 0));
    c.on("error", () => resolve(false));
  });
}
