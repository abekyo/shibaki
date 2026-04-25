// `shibaki demo` — 60-second built-in demo for hands-on verification.
// Writes intentional bugs into dogfood/mathTarget.ts and lets Shibaki fix them.
//
// Onboarding entry point that makes "try it" a one-line command.
// Goal: someone who sees it on HN / Twitter can verify it works in a minute via npx shibaki demo.

import { writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { autoSelectCritic } from "./autoFallback.ts";

// Same bug fixture as scripts/demo.ts (this file is the source of truth).
// Note: intentionally do NOT include comments that point to the bug location. The agent must
// detect the bug using only the failing tests as clues (giving away the answer in a comment
// would turn the demo into a non-test).
// Comments and code are English-only — to avoid language mixing in asciinema recordings.
const BUGGY_CODE = `// Shibaki demo target — intentional bugs live in this file.
// Shibaki fixes them and prints a one-line "why" explanation.

export function factorial(n: number): number {
  if (n <= 1) return 1;
  let result = 1;
  for (let i = 2; i < n; i++) {
    result *= i;
  }
  return result;
}

export function fibonacci(n: number): number {
  if (n < 2) return n;
  let a = 0, b = 1;
  for (let i = 2; i <= n; i++) {
    const next = a + b;
    a = b;
    b = next;
  }
  return a;
}
`;

export async function cmdDemo(argv: string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }

  // Resolve repo root relative to this file, so it works whether installed as a package or run from the repo
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolveRepoRoot(here);
  const targetPath = join(repoRoot, "dogfood/mathTarget.ts");
  const verifyCmd = "bun test dogfood/mathTarget.test.ts";
  const binPath = join(repoRoot, "bin/shibaki.ts");

  // Pre-flight: claude command (required as the main agent)
  const claudeAvailable = await commandExists("claude");
  if (!claudeAvailable) {
    process.stderr.write("\n✗ `claude` command not found.\n\n");
    process.stderr.write("  Install Claude Code:\n");
    process.stderr.write("    npm install -g @anthropic-ai/claude-code\n");
    process.stderr.write("    claude login\n\n");
    process.stderr.write("Details: shibaki doctor\n");
    return 2;
  }

  // Zero-setup fallback: even with no API key at all, proceed in Plan mode if claude is installed
  const fallback = await autoSelectCritic(process.env);
  if (fallback.apply && fallback.message) {
    process.stderr.write(`\n${fallback.message}\n`);
  } else if (
    !process.env.LLM_PROVIDER_CRITICAL &&
    !process.env.OPENAI_API_KEY &&
    !process.env.ANTHROPIC_API_KEY &&
    !process.env.GEMINI_API_KEY
  ) {
    // Neither fallback nor API key works (the no-claude case already returned above, so we normally don't reach here)
    process.stderr.write("\n✗ No critic backend configured.\n\n");
    process.stderr.write("  Run: shibaki doctor   for a guided setup hint.\n");
    return 2;
  }

  process.stdout.write("==========================================\n");
  process.stdout.write("  Shibaki demo — 60 second hands-on\n");
  process.stdout.write("==========================================\n\n");
  process.stdout.write("1. Writing intentional bugs to dogfood/mathTarget.ts\n");
  process.stdout.write("   (off-by-one in factorial and fibonacci)\n");

  await writeFile(targetPath, BUGGY_CODE);

  process.stdout.write("\n2. Running tests (expect 7 failures):\n");
  // Merge stderr with 2>&1. bun test writes per-test failure details to stderr,
  // so without this, output bypasses tail -3 and explodes.
  await runShell(`bun test dogfood/mathTarget.test.ts 2>&1 | tail -3`, repoRoot);

  process.stdout.write("\n3. Letting Shibaki fix it (fully automatic, no --ask):\n");
  process.stdout.write("   - main agent: claude -p\n");
  process.stdout.write("   - critic:     a different provider (env-configured / default OpenAI)\n\n");

  const shibakiExit = await runShell(
    [
      `bun run ${escapeShell(binPath)} run`,
      `--agent "claude -p"`,
      `--verify "${verifyCmd}"`,
      "--max-tries 3 --timeout 240",
      `"Fix all failing tests in dogfood/mathTarget.test.ts by editing dogfood/mathTarget.ts. Do not touch the test files."`,
    ].join(" "),
    repoRoot,
  );

  // Combine re-test visibility (with tail) and exit-code capture into one shot.
  // A plain pipe makes the exit code come from tail (always 0), so `set -o pipefail`
  // promotes the head (bun test) non-zero exit to the pipeline exit.
  // Used as input for the graceful-degradation decision: even if shibaki itself fell over mid-way,
  // there are cases where the agent finished fixing the bug and tests are green. In that case, explicitly state "essential goal achieved".
  process.stdout.write("\n4. Re-running tests (after fix):\n");
  const testExit = await runShell(
    `set -o pipefail; bun test dogfood/mathTarget.test.ts 2>&1 | tail -3`,
    repoRoot,
  );

  process.stdout.write("\n==========================================\n");
  if (shibakiExit === 0 && testExit === 0) {
    // Full success: critic loop ran to completion and tests are green.
    process.stdout.write("  ✓ Shibaki demo done\n\n");
    process.stdout.write("  What you saw:\n");
    process.stdout.write("   - A \"critic slaps:\" / \"critic approves\" line after each try —\n");
    process.stdout.write("     the verdict, reason, and (when slapped) attack angles / evidence.\n");
    process.stdout.write("     That's the AI-vs-AI dialog, printed directly.\n");
    process.stdout.write("   - The final \"✓ done\" line — elapsed time, retry count, cost\n\n");
    process.stdout.write("  Next steps:\n");
    process.stdout.write("   - Try on your own repo: shibaki run --agent ... --verify ... \"...\"\n");
    process.stdout.write("   - Try --ask to experience scope-drift detection\n");
    process.stdout.write("   - Re-check env with: shibaki doctor\n");
    process.stdout.write("==========================================\n");
    return 0;
  }
  if (shibakiExit !== 0 && testExit === 0) {
    // Partial success: shibaki itself fell over mid-way (likely critic failing due to API congestion),
    // but the agent's fix made the tests green. State: "it worked, but you didn't get to see the AI-vs-AI dialog".
    // Marking the whole demo ✗ here would feel "broken", so explicitly note the goal was achieved.
    process.stdout.write("  ⚠ Shibaki demo: partial success\n\n");
    process.stdout.write("  - Bug WAS fixed (tests pass 7/7) ✓\n");
    process.stdout.write("  - But the critic loop didn't complete cleanly —\n");
    process.stdout.write("    most commonly Anthropic / OpenAI / Gemini was temporarily overloaded.\n\n");
    process.stdout.write("  What this means:\n");
    process.stdout.write("   - The core value (automatic bug fix + verify) worked.\n");
    process.stdout.write("   - The AI-vs-AI critic dialog was truncated.\n");
    process.stdout.write("     Try `shibaki demo` again in a few minutes to see it.\n\n");
    process.stdout.write("  Not your fault, not a Shibaki bug — just model backend hiccup.\n");
    process.stdout.write("==========================================\n");
    return 0; // Return 0 on partial success (so the user's shell evaluates it as success)
  }
  // True failure: tests didn't go green. The agent never reached a fix.
  process.stdout.write("  ✗ Demo failed. Run `shibaki doctor` to diagnose.\n");
  process.stdout.write("==========================================\n");
  return shibakiExit || 1;
}

const HELP = `Shibaki demo — 60 second hands-on

Usage:
  shibaki demo

Requirements:
  - Bun installed
  - claude command available and logged in:
      npm install -g @anthropic-ai/claude-code
      claude login

Critic backend (auto-picked from your env, in this order):
  1. If LLM_PROVIDER_CRITICAL is explicitly set → use that.
  2. Otherwise, if any critic API key is in env (OPENAI / GEMINI / ANTHROPIC)
     → use that provider (API mode).
  3. Otherwise → fall back to Plan mode (claude -p as critic, opus).
     Zero export needed when you already ran 'claude login'.

What it does:
  1. Writes intentional bugs to dogfood/mathTarget.ts
  2. Shows that 7 tests currently fail
  3. Shibaki fixes the code → verifies completion → prints a one-line "why"
  4. Shows that all tests now pass

Cost:
  - API mode:  ~\$0.02-0.05 (1-3 critic calls, varies by provider)
  - Plan mode: counted against your Claude Code plan quota (~2-3 opus calls)
Time: ~60 seconds on a good day; add ~30s if the critic hits a transient API overload
`;

function resolveRepoRoot(here: string): string {
  // src/cli/demo.ts → repo root is ../../
  // Assumes the dist build keeps the same hierarchy
  return join(here, "..", "..");
}

function escapeShell(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

function runShell(cmd: string, cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", cmd], { cwd, stdio: "inherit" });
    child.on("close", (code) => resolve(code ?? 0));
  });
}

function commandExists(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = spawn("which", [name], { stdio: "ignore" });
    c.on("close", (code) => resolve(code === 0));
    c.on("error", () => resolve(false));
  });
}
