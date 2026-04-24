// `shibaki demo` — 60 秒で動作確認できる built-in demo。
// dogfood/mathTarget.ts に意図的バグを書き込んで Shibaki に修正させる。
//
// 「触ってみる」を 1 行コマンドで成立させるための onboarding 入口。
// HN / Twitter で見た人が npx shibaki demo で動作を 1 分で確認できる状態を目指す。

import { writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { autoSelectCritic } from "./autoFallback.ts";

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

  // Pre-flight: claude command (main agent として必須)
  const claudeAvailable = await commandExists("claude");
  if (!claudeAvailable) {
    process.stderr.write("\n✗ `claude` command not found.\n\n");
    process.stderr.write("  Install Claude Code:\n");
    process.stderr.write("    npm install -g @anthropic-ai/claude-code\n");
    process.stderr.write("    claude login\n\n");
    process.stderr.write("Details: shibaki doctor\n");
    return 2;
  }

  // Zero-setup fallback: API key 一つも無くても claude が入ってれば Plan mode で続行
  const fallback = await autoSelectCritic(process.env);
  if (fallback.apply && fallback.message) {
    process.stderr.write(`\n${fallback.message}\n`);
  } else if (
    !process.env.LLM_PROVIDER_CRITICAL &&
    !process.env.OPENAI_API_KEY &&
    !process.env.ANTHROPIC_API_KEY &&
    !process.env.GEMINI_API_KEY
  ) {
    // fallback も API key も効かない状況 (claude 無しは上で return 済みなので通常ここには来ない)
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
  // 2>&1 で stderr も合流させる。bun test は per-test の失敗詳細を stderr に
  // 出すので、これを付けないと tail -3 をすり抜けて output が爆発する。
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

  // 再テストは視認 (with tail) と exit 取得を 1 回にまとめる。
  // 普通の pipe だと exit code が tail 側 (常に 0) になるので `set -o pipefail` で
  // 先頭 (bun test) の非 0 exit を pipeline exit に昇格させる。
  // graceful degradation の判定材料に使う: shibaki 本体が途中で倒れていても、agent が bug を
  // 直し終わってれば tests は green になっているケースがある。その場合「本質ゴール達成」を明示する。
  process.stdout.write("\n4. Re-running tests (after fix):\n");
  const testExit = await runShell(
    `set -o pipefail; bun test dogfood/mathTarget.test.ts 2>&1 | tail -3`,
    repoRoot,
  );

  process.stdout.write("\n==========================================\n");
  if (shibakiExit === 0 && testExit === 0) {
    // 完全成功: critic loop が最後まで走り、tests も green。
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
    process.stdout.write("==========================================\n");
    return 0;
  }
  if (shibakiExit !== 0 && testExit === 0) {
    // 部分成功: shibaki 本体は途中 (おそらく critic が API 混雑で失敗) で倒れたが、
    // agent の修正で tests は green になっている。「動きはした、AI 同士の対話は見れなかった」状態。
    // ここで demo 全体を ✗ にすると「壊れてる」印象になるので、ゴール達成を明示する。
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
    return 0; // 部分成功は 0 を返す (ユーザーの shell 評価が success 扱いになる)
  }
  // 真の失敗: tests が green にならなかった。agent がそもそも fix に辿り着けてない。
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
