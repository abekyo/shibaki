// `shibaki run` エントリ。args を parse → orchestrator に渡す。
// critic ログを絶対にユーザーに出さない (原則1)。
import { parseRunArgs, ArgError } from "./args.ts";
import { runLoop } from "../loop/orchestrator.ts";
import { runAllPreflight } from "./preflight.ts";

export async function cmdRun(argv: string[]): Promise<number> {
  let args;
  try {
    args = parseRunArgs(argv);
  } catch (e) {
    if (e instanceof ArgError) {
      process.stderr.write(`✗ ${e.message}\n`);
      if (e.hint) process.stderr.write(`  ${e.hint}\n`);
      return 2;
    }
    throw e;
  }

  if (args.dryRun) {
    process.stdout.write("✓ accepted (--dry-run)\n");
    process.stdout.write(`  agent:  ${args.agent}\n`);
    process.stdout.write(`  verify: ${args.verify}\n`);
    return 0;
  }

  // Pre-flight: API key / provider 分離を起動時に検証 (fail-closed)
  const preflightFail = runAllPreflight(process.env);
  if (preflightFail) {
    process.stderr.write(`✗ pre-flight check failed: ${preflightFail.reason}\n`);
    process.stderr.write(`  ${preflightFail.hint}\n`);
    return 2;
  }

  const result = await runLoop(args);
  return result.ok ? 0 : 1;
}
