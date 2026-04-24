// --verify コマンドを実行して exit code + stdout/stderr を回収する。
// exit 0 が完遂の必要条件 (十分条件は rebuttal が反証不能)。
import { execCapture } from "./mainAgent.ts";

export interface VerifyResult {
  ok: boolean;           // exit code 0 なら true
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export async function runVerify(cmd: string, cwd?: string, timeoutMs = 5 * 60_000): Promise<VerifyResult> {
  const t0 = Date.now();
  const { stdout, stderr, exitCode } = await execCapture(cmd, cwd ?? process.cwd(), timeoutMs);
  return {
    ok: exitCode === 0,
    exitCode,
    stdout,
    stderr,
    durationMs: Date.now() - t0,
  };
}
