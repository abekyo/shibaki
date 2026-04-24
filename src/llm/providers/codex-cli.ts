// Codex CLI 経由の critic provider (OpenAI codex CLI)。
// 前提: ユーザーが `codex` CLI を install + `codex login` 済み。
// Shibaki 側では OPENAI_API_KEY を持たない運用が可能。
//
// 呼び出し形 (non-interactive):
//   codex exec --model <model> [--skip-git-repo-check] < stdin
// stdout は raw response text。
//
// 注意: codex CLI の flag 体系はバージョン依存。ユーザーが wrapper で差し替えたい場合は
// CODEX_CLI_BIN で実バイナリを上書き可能にしている。
import type { LLMProvider, CallOptions, RawResponse } from "../types.ts";
import { cliSpawn, composeCliPrompt } from "./cliShared.ts";

const DEFAULT_BIN = "codex";

function resolveBin(): string {
  return process.env.CODEX_CLI_BIN?.trim() || DEFAULT_BIN;
}

export const codexCliProvider: LLMProvider = {
  name: "codex-cli",
  async call(opts: CallOptions): Promise<RawResponse> {
    const bin = resolveBin();
    const prompt = composeCliPrompt(opts.system, opts.user, opts.jsonMode ?? false);
    // exec = non-interactive, prompt via stdin。--skip-git-repo-check は
    // Shibaki の作業 cwd がサンドボックス内だったときに codex が拒否しないよう付ける。
    const args = ["exec", "--model", opts.model, "--skip-git-repo-check"];

    const res = await cliSpawn({ bin, args, stdin: prompt });
    if (res.exitCode !== 0) {
      throw new Error(
        `codex CLI exited with code ${res.exitCode}: ${truncate(res.stderr || res.stdout, 400)}`
      );
    }
    return {
      text: res.stdout.trim(),
      model: opts.model,
      request_id: null,
      usage: undefined,
    };
  },
  async testApiKey() {
    const { cliAvailable } = await import("./cliShared.ts");
    const ok = await cliAvailable(resolveBin());
    return ok
      ? { ok: true }
      : {
          ok: false,
          error: `${resolveBin()} CLI not found in PATH. Install: npm install -g @openai/codex`,
        };
  },
};

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}... (truncated)` : s;
}
