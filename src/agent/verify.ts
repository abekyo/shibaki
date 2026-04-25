// Run the --verify command and collect exit code + stdout/stderr.
// exit 0 is a necessary condition for completion (the sufficient condition is that the rebuttal is irrefutable).
import { execCapture } from "./mainAgent.ts";

export interface VerifyResult {
  ok: boolean;           // true if exit code is 0
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
