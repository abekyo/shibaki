// `shibaki demo` — 60 秒で動作確認できる built-in demo。
// dogfood/mathTarget.ts に意図的バグを書き込んで Shibaki に修正させる。
//
// 「触ってみる」を 1 行コマンドで成立させるための onboarding 入口。
// HN / Twitter で見た人が npx shibaki demo で動作を 1 分で確認できる状態を目指す。

import { writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// scripts/demo.ts と同じバグ fixture (本ファイルが正本)
const BUGGY_CODE = `// Shibaki demo target — このファイルにわざとバグが入っています
// Shibaki がこれを修正して "なぜ" を 1 行で説明する様子を見てください

export function factorial(n: number): number {
  if (n <= 1) return 1;
  let result = 1;
  // BUG: i <= n であるべきところを i < n
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
  // BUG: b を返すべき
  return a;
}
`;

export async function cmdDemo(argv: string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }

  // shibaki-installed-package or repo どっちでも動くよう、本ファイルから相対で repo root を解決
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolveRepoRoot(here);
  const targetPath = join(repoRoot, "dogfood/mathTarget.ts");
  const verifyCmd = "bun test dogfood/mathTarget.test.ts";
  const binPath = join(repoRoot, "bin/shibaki.ts");

  // Pre-flight: API key
  if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY && !process.env.GEMINI_API_KEY) {
    process.stderr.write("\n✗ No critic API key is set.\n\n");
    process.stderr.write("  Export ONE of the following:\n\n");
    process.stderr.write("  export GEMINI_API_KEY=AIza...      # free tier: https://aistudio.google.com/apikey\n");
    process.stderr.write("  export LLM_PROVIDER_CRITICAL=gemini\n\n");
    process.stderr.write("  or: export OPENAI_API_KEY=sk-...   # https://platform.openai.com/api-keys\n");
    process.stderr.write("  or: export ANTHROPIC_API_KEY=sk-ant-...\n\n");
    process.stderr.write("Details: shibaki doctor\n");
    return 2;
  }

  // Pre-flight: claude command
  const claudeAvailable = await commandExists("claude");
  if (!claudeAvailable) {
    process.stderr.write("\n✗ `claude` command not found.\n\n");
    process.stderr.write("  Install Claude Code:\n");
    process.stderr.write("    npm install -g @anthropic-ai/claude-code\n");
    process.stderr.write("    claude login\n\n");
    process.stderr.write("Details: shibaki doctor\n");
    return 2;
  }

  process.stdout.write("==========================================\n");
  process.stdout.write("  Shibaki demo — 60 second hands-on\n");
  process.stdout.write("==========================================\n\n");
  process.stdout.write("1. Writing intentional bugs to dogfood/mathTarget.ts\n");
  process.stdout.write("   (off-by-one in factorial and fibonacci)\n");

  await writeFile(targetPath, BUGGY_CODE);

  process.stdout.write("\n2. Running tests (expect 7 failures):\n");
  // 2>&1 で stderr も合流させる。bun test は per-test の失敗詳細を stderr に
  // 出すので、これを付けないと tail -3 をすり抜けて output が爆発する。
  await runShell(`bun test dogfood/mathTarget.test.ts 2>&1 | tail -3`, repoRoot);

  process.stdout.write("\n3. Letting Shibaki fix it (fully automatic, no --ask):\n");
  process.stdout.write("   - main agent: claude -p\n");
  process.stdout.write("   - critic:     a different provider (env-configured / default OpenAI)\n\n");

  const exitCode = await runShell(
    [
      `bun run ${escapeShell(binPath)} run`,
      `--agent "claude -p"`,
      `--verify "${verifyCmd}"`,
      "--max-tries 3 --timeout 240",
      `"Fix all failing tests in dogfood/mathTarget.test.ts by editing dogfood/mathTarget.ts. Do not touch the test files."`,
    ].join(" "),
    repoRoot,
  );

  process.stdout.write("\n4. Re-running tests (after fix):\n");
  await runShell(`bun test dogfood/mathTarget.test.ts 2>&1 | tail -3`, repoRoot);

  process.stdout.write("\n==========================================\n");
  if (exitCode === 0) {
    process.stdout.write("  ✓ Shibaki demo done\n\n");
    process.stdout.write("  What you saw:\n");
    process.stdout.write("   - A \"critic:\" block after each try — the critic's verdict,\n");
    process.stdout.write("     reason, and (when refuted) attack angles / evidence.\n");
    process.stdout.write("     That's the AI-vs-AI dialog, printed directly.\n");
    process.stdout.write("   - The final \"✓ done\" line — elapsed time, retry count, cost\n\n");
    process.stdout.write("  Next steps:\n");
    process.stdout.write("   - Try on your own repo: shibaki run --agent ... --verify ... \"...\"\n");
    process.stdout.write("   - Try --ask to experience scope-drift detection\n");
    process.stdout.write("   - Re-check env with: shibaki doctor\n");
  } else {
    process.stdout.write("  ✗ Demo failed. Run `shibaki doctor` to diagnose.\n");
  }
  process.stdout.write("==========================================\n");
  return exitCode;
}

const HELP = `Shibaki demo — 60 second hands-on

Usage:
  shibaki demo

Requirements:
  - Bun installed
  - claude command available (npm install -g @anthropic-ai/claude-code)
  - One critic API key exported (OPENAI_API_KEY / GEMINI_API_KEY / ANTHROPIC_API_KEY)

What it does:
  1. Writes intentional bugs to dogfood/mathTarget.ts
  2. Shows that 7 tests currently fail
  3. Shibaki fixes the code → verifies completion → prints a one-line "why"
  4. Shows that all tests now pass

Cost: ~$0.02-0.05 (1-3 critic calls)
Time: ~60 seconds
`;

function resolveRepoRoot(here: string): string {
  // src/cli/demo.ts → repo root は ../../
  // dist build の場合も同様の階層を保つ前提
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
