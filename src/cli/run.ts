// `shibaki run` entry. Parse args → hand off to orchestrator.
// Never expose critic logs to the user (principle 1).
import { parseRunArgs, ArgError } from "./args.ts";
import { runLoop } from "../loop/orchestrator.ts";
import { runAllPreflight } from "./preflight.ts";
import { autoSelectCritic } from "./autoFallback.ts";
import { HELP_TEXT } from "./help.ts";

export async function cmdRun(argv: string[]): Promise<number> {
  // Intercept -h / --help before parseRunArgs.
  // Universal CLI convention (gh / docker / git) — subcommand --help should
  // print that command's help, not return "unknown option".
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

  // Zero-setup fallback: auto-switch the critic to Plan mode for users who haven't exported anything.
  // When it fires, print one line to stderr for transparency.
  // --quiet (CI / scripting) suppresses the message — fallback still applies, just silently.
  // No-op if explicitly set / API key present / claude missing.
  const fallback = await autoSelectCritic(process.env);
  if (fallback.apply && fallback.message && !args.quiet) {
    process.stderr.write(`${fallback.message}\n`);
  }

  // Pre-flight: verify API key / provider separation / CLI availability at startup (fail-closed)
  const preflightFail = await runAllPreflight(process.env);
  if (preflightFail) {
    process.stderr.write(`✗ pre-flight check failed: ${preflightFail.reason}\n`);
    process.stderr.write(`  ${preflightFail.hint}\n`);
    return 2;
  }

  const result = await runLoop(args);
  return result.ok ? 0 : 1;
}
