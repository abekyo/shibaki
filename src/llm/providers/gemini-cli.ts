// Critic provider via the Gemini CLI (Google @google/gemini-cli).
// Prerequisite: the user has installed and authenticated the `gemini` CLI (Google OAuth or API key).
// Shibaki does not need to hold GEMINI_API_KEY for this path.
//
// Invocation (non-interactive):
//   gemini -p "<prompt>" --model <model>
// stdout is the raw model response text. No JSON wrapping.
//
// Note: the gemini CLI flag scheme changes fairly actively. If the user wants different flags,
// the expectation is to override the binary itself with a wrapper script via GEMINI_CLI_BIN.
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
    // -p selects non-interactive print mode. Prompt goes via stdin (passing as an arg hits the OS arg-length limit on long prompts).
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
