// `shibaki run` エントリ。args を parse → orchestrator に渡す。
// critic ログを絶対にユーザーに出さない (原則1)。
import { parseRunArgs, ArgError } from "./args.ts";
import { runLoop } from "../loop/orchestrator.ts";
import { runAllPreflight } from "./preflight.ts";
import { autoSelectCritic } from "./autoFallback.ts";
import { HELP_TEXT } from "./help.ts";

export async function cmdRun(argv: string[]): Promise<number> {
  // -h / --help は parseRunArgs より前に intercept する。
  // 普遍的な CLI 慣習 (gh / docker / git) — subcommand --help はそのコマンドの
  // help を出すべきで、"unknown option" を返してはならない。
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

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

  // Zero-setup fallback: 何も export してないユーザーの critic を Plan mode に自動切替。
  // 発動時は stderr に 1 行出して透明性を担保。明示指定 / API key あり / claude 無しのどれかで no-op。
  const fallback = await autoSelectCritic(process.env);
  if (fallback.apply && fallback.message) {
    process.stderr.write(`${fallback.message}\n`);
  }

  // Pre-flight: API key / provider 分離 / CLI 可用性を起動時に検証 (fail-closed)
  const preflightFail = await runAllPreflight(process.env);
  if (preflightFail) {
    process.stderr.write(`✗ pre-flight check failed: ${preflightFail.reason}\n`);
    process.stderr.write(`  ${preflightFail.hint}\n`);
    return 2;
  }

  const result = await runLoop(args);
  return result.ok ? 0 : 1;
}
