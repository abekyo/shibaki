// Critic provider via the Claude Code CLI.
// Prerequisite: the user has run `claude login` (Claude Code plan subscription or API key, either works).
// Shibaki itself does not hold an API key.
//
// Invocation:
//   claude -p --output-format json --model <model> [--system-prompt <sys>] < stdin
//
// Output (--output-format json) looks like:
//   {"type":"result","subtype":"success","is_error":false,"result":"...","session_id":"..."}
// The "result" field is the text body. If is_error is set, raise an exception.
import type { LLMProvider, CallOptions, RawResponse } from "../types.ts";
import { cliSpawn } from "./cliShared.ts";

const DEFAULT_BIN = "claude";

function resolveBin(): string {
  return process.env.CLAUDE_CLI_BIN?.trim() || DEFAULT_BIN;
}

export const claudeCliProvider: LLMProvider = {
  name: "anthropic-cli",
  async call(opts: CallOptions): Promise<RawResponse> {
    const bin = resolveBin();
    const args = [
      "-p",
      "--output-format", "json",
      "--model", opts.model,
    ];
    if (opts.system && opts.system.trim()) {
      args.push("--system-prompt", opts.system);
    }
    // User prompt goes via stdin. Append output-format instructions when jsonMode is set.
    const stdin = opts.jsonMode
      ? opts.user + "\n\nReply with EXACTLY ONE valid JSON object. Start with `{`, end with `}`. No code fences, no prose."
      : opts.user;

    const res = await cliSpawn({ bin, args, stdin });
    if (res.exitCode !== 0) {
      throw new Error(
        `claude CLI exited with code ${res.exitCode}: ${truncate(res.stderr || res.stdout, 400)}`
      );
    }

    const text = extractResultText(res.stdout);
    return {
      text,
      model: opts.model,
      request_id: null,
      // The CLI does not reliably return usage, so skip it. Cost calculation is fine with the API path alone.
      usage: undefined,
    };
  },
  async testApiKey() {
    // CLI providers don't hold an API key. Just confirm the CLI exists.
    // This duplicates the which-based check in doctor.ts, but we still check it here
    // so the provider can determine its own health on its own.
    const { cliAvailable } = await import("./cliShared.ts");
    const ok = await cliAvailable(resolveBin());
    return ok
      ? { ok: true }
      : {
          ok: false,
          error: `${resolveBin()} CLI not found in PATH. Install: npm install -g @anthropic-ai/claude-code`,
        };
  },
};

/** Extract the body text from `claude -p --output-format json` stdout.
 *  Expected shape: {"type":"result","result":"...","is_error":false,...}
 *
 *  When is_error === true, throw. The caller (callText / callJson) goes through withRetry,
 *  so if "overloaded" etc. appears in the message it will be retried.
 *
 *  When the output isn't JSON, return raw (e.g. user swapped --output-format).
 *
 *  Exported for testing (imported from tests/claudeCli.test.ts). */
export function extractResultText(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";

  let obj: any;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    // not JSON — assume the caller swapped --output-format and pass raw through
    return trimmed;
  }

  if (!obj || typeof obj !== "object") return trimmed;

  // Array (stream-json) case — typeof of an object is also "object", so handle this first
  if (Array.isArray(obj)) {
    const texts = obj
      .filter((e: any) => e?.type === "assistant" || e?.type === "result")
      .map((e: any) => e.result ?? e.text ?? "")
      .filter(Boolean);
    if (texts.length) return texts.join("");
    return trimmed;
  }

  if (obj.is_error) {
    // Note: this throw is not wrapped in try/catch, so it propagates correctly to the caller
    const detail = obj.result ?? obj.subtype ?? "unknown";
    throw new Error(`claude CLI reported error: ${detail}`);
  }

  if (typeof obj.result === "string") return obj.result;

  return trimmed;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}... (truncated)` : s;
}
