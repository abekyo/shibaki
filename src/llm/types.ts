// LLM プロバイダ抽象化の型
export type ProviderName = "anthropic" | "openai" | "gemini";

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
