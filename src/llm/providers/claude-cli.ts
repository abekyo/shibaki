// Claude Code CLI 経由の critic provider。
// 前提: ユーザーが `claude login` 済み (Claude Code plan サブスク or API key どちらでも)。
// Shibaki 側では API key を持たない。
//
// 呼び出し形:
//   claude -p --output-format json --model <model> [--system-prompt <sys>] < stdin
//
// 出力 (--output-format json) は以下のような形:
//   {"type":"result","subtype":"success","is_error":false,"result":"...","session_id":"..."}
// "result" フィールドがテキスト本体。is_error なら例外化。
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
    // user prompt は stdin 経由。jsonMode のときは出力形式を追記。
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
      // CLI は usage を安定して返さないので省略。cost 計算は API 版で十分。
      usage: undefined,
    };
  },
  async testApiKey() {
    // CLI provider は API key を持たない。CLI の存在だけ確認する。
    // doctor.ts の which ベースチェックと責務が重複するが、provider 単体で
    // 健全性を判定できるようにするため testApiKey でも見る。
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

/** claude -p --output-format json の stdout から本文テキストを取り出す。
 *  想定形: {"type":"result","result":"...","is_error":false,...}
 *
 *  is_error === true のときは例外を throw。caller (callText / callJson) 側が
 *  withRetry 経由なので、overloaded 等の message が message に入ってれば retry される。
 *
 *  JSON 不成立時は raw を返す (ユーザーが --output-format を差し替えた等)。
 *
 *  試験用に export している (tests/claudeCli.test.ts からの import)。 */
export function extractResultText(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";

  let obj: any;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    // not JSON — caller の --output-format 差し替えと見なして raw をそのまま渡す
    return trimmed;
  }

  if (!obj || typeof obj !== "object") return trimmed;

  // Array (stream-json) ケース — Object.typeof も "object" を返すのでここで先に拾う
  if (Array.isArray(obj)) {
    const texts = obj
      .filter((e: any) => e?.type === "assistant" || e?.type === "result")
      .map((e: any) => e.result ?? e.text ?? "")
      .filter(Boolean);
    if (texts.length) return texts.join("");
    return trimmed;
  }

  if (obj.is_error) {
    // 注意: この throw は try/catch で囲まれていないので caller に正しく伝播する
    const detail = obj.result ?? obj.subtype ?? "unknown";
    throw new Error(`claude CLI reported error: ${detail}`);
  }

  if (typeof obj.result === "string") return obj.result;

  return trimmed;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}... (truncated)` : s;
}
