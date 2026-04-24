// LLM プロバイダ抽象化の型
//
// provider 区分:
//  - API 系: "anthropic" | "openai" | "gemini" — HTTP API + API key で呼ぶ
//  - CLI 系: "anthropic-cli" | "gemini-cli" | "codex-cli"
//             — ローカル CLI を subprocess spawn して呼ぶ (API key 不要、ユーザーの CLI 認証に依存)
//
// CLI 系は Claude Code plan / Gemini Code Assist / Codex plan 等、サブスク契約ユーザーが
// API 契約を別途取らずに critic を動かせる経路を提供する。
export type ProviderName =
  | "anthropic"
  | "openai"
  | "gemini"
  | "anthropic-cli"
  | "gemini-cli"
  | "codex-cli";

export type ProviderFamily = "anthropic" | "openai" | "gemini";

export function providerFamily(p: ProviderName): ProviderFamily {
  if (p === "anthropic" || p === "anthropic-cli") return "anthropic";
  if (p === "openai" || p === "codex-cli") return "openai";
  return "gemini"; // "gemini" | "gemini-cli"
}

export function isCliProvider(p: ProviderName): boolean {
  return p === "anthropic-cli" || p === "gemini-cli" || p === "codex-cli";
}

// CRITICAL = critic (反証役) 専用。別プロバイダ強制推奨
// MAIN     = main agent を Shibaki 側から直接叩く場合の tier (Phase 1 では未使用 = 外部 CLI spawn)
// LIGHT    = メタ分析 / ログ分類など補助 (Phase 2+)
export type Tier = "CRITICAL" | "MAIN" | "LIGHT";

export interface CallOptions {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  jsonMode?: boolean;
}

export interface RawResponse {
  text: string;
  model?: string;
  request_id?: string | null;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface CallMeta {
  usage?: { input_tokens: number; output_tokens: number };
  model_name?: string;
  provider?: ProviderName;
}

export interface LLMProvider {
  name: ProviderName;
  call(opts: CallOptions): Promise<RawResponse>;
  testApiKey(): Promise<{ ok: boolean; error?: string }>;
}

export class LLMFriendlyError extends Error {
  constructor(
    message: string,
    public readonly provider: ProviderName | "unknown",
    public readonly status?: number,
    public readonly requestId?: string | null,
    public readonly hint?: string,
    public readonly cause?: any
  ) {
    super(message);
    this.name = "LLMFriendlyError";
  }
}
