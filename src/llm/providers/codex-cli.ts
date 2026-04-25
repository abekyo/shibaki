// Critic provider via the Codex CLI (OpenAI codex CLI).
// Prerequisite: the user has installed the `codex` CLI and run `codex login`.
// Shibaki itself does not need to hold OPENAI_API_KEY for this path.
//
// Invocation (non-interactive):
//   codex exec --model <model> [--skip-git-repo-check] < stdin
// stdout is the raw response text.
//
// Note: the codex CLI flag scheme is version-dependent. To let the user swap in a wrapper,
// CODEX_CLI_BIN can override the actual binary.
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
    // exec = non-interactive, prompt via stdin. --skip-git-repo-check is set so
    // codex doesn't refuse when Shibaki's working cwd is inside a sandbox.
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
