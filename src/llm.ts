// Shibaki LLM router
// critic は main agent と別プロバイダを強制するのが北極星 (原則2)。
//
// env:
//   LLM_PROVIDER                = main agent の宣言 (family 判定用)
//                                 anthropic | openai | gemini | anthropic-cli | gemini-cli | codex-cli
//                                 (default: anthropic)
//   LLM_PROVIDER_CRITICAL       = critic 専用 provider override
//   LLM_MODEL_CRITICAL          = 明示モデル名
//   LLM_PROVIDER_LIGHT / LLM_MODEL_LIGHT = 補助用
//
// 設計方針: main agent は外部 CLI (claude -p 等) を spawn するため、
// この router が担当するのは critic + 補助 LLM のみ。
//
// CLI provider (anthropic-cli / gemini-cli / codex-cli) は API key 不要で
// ローカルの `claude` / `gemini` / `codex` を呼ぶ経路。Claude Code plan 等の
// サブスク契約ユーザーが追加 API 契約なしで critic を動かせる。
import { anthropicProvider } from "./llm/providers/anthropic.ts";
import { openaiProvider } from "./llm/providers/openai.ts";
import { geminiProvider } from "./llm/providers/gemini.ts";
import { claudeCliProvider } from "./llm/providers/claude-cli.ts";
import { geminiCliProvider } from "./llm/providers/gemini-cli.ts";
import { codexCliProvider } from "./llm/providers/codex-cli.ts";
import {
  LLMFriendlyError,
  type LLMProvider,
  type ProviderName,
  type Tier,
  type CallMeta,
  isCliProvider,
} from "./llm/types.ts";
import { estimateCostUsd } from "./llm/cost.ts";
import { withRetry } from "./llm/retry.ts";

export { LLMFriendlyError };
export type { ProviderName, Tier };

export const CRITICAL = "CRITICAL" as const;
export const MAIN = "MAIN" as const;
export const LIGHT = "LIGHT" as const;

// CLI 系は model 指定が API 系と違う (alias "sonnet"/"opus" や gemini-cli 独自 model 名)。
// default は "critic は main より強い model を使う" 方針。
const DEFAULT_MODELS: Record<ProviderName, Record<Tier, string>> = {
  anthropic: {
    CRITICAL: "claude-opus-4-7",
    MAIN: "claude-sonnet-4-6",
    LIGHT: "claude-haiku-4-5",
  },
  openai: { CRITICAL: "gpt-4o", MAIN: "gpt-4o", LIGHT: "gpt-4o-mini" },
  gemini: { CRITICAL: "gemini-2.5-pro", MAIN: "gemini-1.5-pro", LIGHT: "gemini-2.0-flash" },
  "anthropic-cli": { CRITICAL: "opus", MAIN: "sonnet", LIGHT: "haiku" },
  "gemini-cli": { CRITICAL: "gemini-2.5-pro", MAIN: "gemini-2.5-flash", LIGHT: "gemini-2.5-flash" },
  "codex-cli": { CRITICAL: "gpt-5", MAIN: "gpt-5", LIGHT: "gpt-5-mini" },
};

const PROVIDERS: Record<ProviderName, LLMProvider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  gemini: geminiProvider,
  "anthropic-cli": claudeCliProvider,
  "gemini-cli": geminiCliProvider,
  "codex-cli": codexCliProvider,
};

const VALID_PROVIDERS: ProviderName[] = [
  "anthropic", "openai", "gemini",
  "anthropic-cli", "gemini-cli", "codex-cli",
];

function activeProviderForTier(tier: Tier): { provider: LLMProvider; model: string } {
  const def = (process.env.LLM_PROVIDER as ProviderName) || "anthropic";

  // CRITICAL tier の default を「main と別 family」に寄せる。
  //  - main=anthropic 系なら critic=openai
  //  - main=openai 系なら critic=anthropic
  //  - main=gemini 系なら critic=anthropic
  // 明示 override があればそちらを優先。
  const criticalDefault: ProviderName =
    def === "anthropic" || def === "anthropic-cli" ? "openai"
    : def === "openai" || def === "codex-cli" ? "anthropic"
    : /* gemini 系 */ "anthropic";

  const tierEnv =
    tier === "CRITICAL" ? process.env.LLM_PROVIDER_CRITICAL ?? criticalDefault
    : tier === "LIGHT" ? process.env.LLM_PROVIDER_LIGHT
    : undefined;
  const name = (tierEnv as ProviderName) || def;
  const safe = VALID_PROVIDERS.includes(name) ? name : "anthropic";
  const modelOverride =
    tier === "CRITICAL" ? process.env.LLM_MODEL_CRITICAL
    : tier === "LIGHT" ? process.env.LLM_MODEL_LIGHT
    : undefined;
  return {
    provider: PROVIDERS[safe],
    model: modelOverride || DEFAULT_MODELS[safe][tier],
  };
}

function resolveCall(modelOrTier: string): { provider: LLMProvider; model: string } {
  if (modelOrTier === CRITICAL || modelOrTier === MAIN || modelOrTier === LIGHT) {
    return activeProviderForTier(modelOrTier as Tier);
  }
  // 明示的モデル名指定の場合、anthropic にルーティング (後方互換用)
  return { provider: anthropicProvider, model: modelOrTier };
}

/** provider.call を withRetry でラップする共通ヘルパ。
 *  overloaded / 5xx / ECONNRESET 系は自動 retry (3 回、~29s backoff)。
 *  retry 発火時は stderr に 1 行出して透明性を担保する。 */
function callWithRetry(
  provider: LLMProvider,
  params: { model: string; system: string; user: string; maxTokens: number; jsonMode: boolean },
  label?: string,
): Promise<import("./llm/types.ts").RawResponse> {
  return withRetry(() => provider.call(params), {
    onRetry: ({ attempt, error, delayMs }) => {
      const tag = label ? ` [${label}]` : "";
      const msg = (error as any)?.message ?? String(error);
      const short = msg.length > 120 ? msg.slice(0, 120) + "..." : msg;
      process.stderr.write(
        `  ⚠ transient error${tag} (${provider.name}), retrying in ${Math.round(delayMs / 1000)}s ` +
        `(attempt ${attempt + 1}): ${short}\n`,
      );
    },
  });
}

export async function callText(
  modelOrTier: string,
  system: string,
  user: string,
  maxTokens = 4096,
  label?: string,
  meta?: CallMeta,
): Promise<string> {
  const { provider, model } = resolveCall(modelOrTier);
  const res = await callWithRetry(
    provider,
    { model, system, user, maxTokens, jsonMode: false },
    label,
  );
  if (meta) {
    meta.usage = res.usage;
    meta.model_name = res.model;
    meta.provider = provider.name;
  }
  return res.text;
}

export async function callJson<T = any>(
  modelOrTier: string,
  system: string,
  user: string,
  maxTokens = 4096,
  label?: string,
  meta?: CallMeta,
): Promise<T> {
  const { provider, model } = resolveCall(modelOrTier);
  const res = await callWithRetry(
    provider,
    { model, system, user, maxTokens, jsonMode: true },
    label,
  );
  if (meta) {
    meta.usage = res.usage;
    meta.model_name = res.model;
    meta.provider = provider.name;
  }
  return extractJson<T>(res.text);
}

function extractJson<T>(raw: string): T {
  const trimmed = raw.trim();
  // コードフェンス剥がし
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(trimmed);
  const body = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(body);
  } catch {
    // 最初の { から最後の } までを強引に抜く
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(body.slice(start, end + 1));
    }
    throw new Error(`Failed to parse JSON from LLM: ${raw.slice(0, 200)}`);
  }
}

// parse_output で使う防御的ヘルパ
export function asString(v: any): string {
  return typeof v === "string" ? v : "";
}

export function asArray<T = any>(v: any): T[] {
  return Array.isArray(v) ? v : [];
}

export { estimateCostUsd, isCliProvider };
