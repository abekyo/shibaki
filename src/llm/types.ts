// LLM provider abstraction types.
//
// Provider categories:
//  - API providers: "anthropic" | "openai" | "gemini" — called via HTTP API + API key
//  - CLI providers: "anthropic-cli" | "gemini-cli" | "codex-cli"
//                  — call a local CLI via subprocess spawn (no API key; relies on the user's CLI auth)
//
// The CLI providers offer a path for subscription users (Claude Code plan / Gemini Code Assist /
// Codex plan etc.) to run the critic without taking out a separate API contract.
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

// CRITICAL = critic (rebuttal role) only. Recommended to force a different provider
// MAIN     = tier for when Shibaki calls the main agent directly (unused in Phase 1 = external CLI spawn)
// LIGHT    = auxiliary tasks like meta analysis / log classification (Phase 2+)
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
