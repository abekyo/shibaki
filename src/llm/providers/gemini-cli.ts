// Gemini CLI 経由の critic provider (Google @google/gemini-cli)。
// 前提: ユーザーが `gemini` CLI を install + 認証済み (Google OAuth / API key のどちらか)。
// Shibaki 側では GEMINI_API_KEY を持たない運用が可能。
//
// 呼び出し形 (non-interactive):
//   gemini -p "<prompt>" --model <model>
// stdout はモデル応答の raw text。JSON wrap 無し。
//
// 注意: gemini CLI は flag 体系が比較的活発に変わる。ユーザーが別 flag を
// 使いたい場合は GEMINI_CLI_BIN でバイナリ自体を wrapper script に差し替える想定。
import type { LLMProvider, CallOptions, RawResponse } from "../types.ts";
import { cliSpawn, composeCliPrompt } from "./cliShared.ts";

const DEFAULT_BIN = "gemini";

function resolveBin(): string {
  return process.env.GEMINI_CLI_BIN?.trim() || DEFAULT_BIN;
}

export const geminiCliProvider: LLMProvider = {
  name: "gemini-cli",
  async call(opts: CallOptions): Promise<RawResponse> {
    const bin = resolveBin();
    const prompt = composeCliPrompt(opts.system, opts.user, opts.jsonMode ?? false);
    // -p で non-interactive print mode。prompt は stdin 経由 (arg だと長文で OS 上限に当たる)。
    const args = ["-p", "--model", opts.model];

    const res = await cliSpawn({ bin, args, stdin: prompt });
    if (res.exitCode !== 0) {
      throw new Error(
        `gemini CLI exited with code ${res.exitCode}: ${truncate(res.stderr || res.stdout, 400)}`
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
          error: `${resolveBin()} CLI not found in PATH. Install: npm install -g @google/gemini-cli`,
        };
  },
};

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}... (truncated)` : s;
}
