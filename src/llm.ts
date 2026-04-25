// Shibaki LLM router
// North-star: force the critic to use a different provider from the main agent (principle 2).
//
// env:
//   LLM_PROVIDER                = declares the main agent (used for family detection)
//                                 anthropic | openai | gemini | anthropic-cli | gemini-cli | codex-cli
//                                 (default: anthropic)
//   LLM_PROVIDER_CRITICAL       = critic-only provider override
//   LLM_MODEL_CRITICAL          = explicit model name
//   LLM_PROVIDER_LIGHT / LLM_MODEL_LIGHT = auxiliary
//
// Design: the main agent is spawned as an external CLI (claude -p etc.), so this
// router only handles the critic + auxiliary LLMs.
//
// The CLI providers (anthropic-cli / gemini-cli / codex-cli) call local `claude` / `gemini` /
// `codex` without an API key. Subscription users (Claude Code plan etc.) can run the critic
// without taking out an additional API contract.
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

// CLI providers take different model names than API providers (aliases like "sonnet"/"opus"
// or gemini-cli's own model names). The default policy is "critic uses a stronger model than main".
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

  // Default the CRITICAL tier to "different family than main":
  //  - main=anthropic family → critic=openai
  //  - main=openai family    → critic=anthropic
  //  - main=gemini family    → critic=anthropic
  // Explicit override wins if set.
  const criticalDefault: ProviderName =
    def === "anthropic" || def === "anthropic-cli" ? "openai"
    : def === "openai" || def === "codex-cli" ? "anthropic"
    : /* gemini family */ "anthropic";

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
  // When an explicit model name is given, route to anthropic (for backward compatibility)
  return { provider: anthropicProvider, model: modelOrTier };
}

/** Shared helper that wraps provider.call with withRetry.
 *  overloaded / 5xx / ECONNRESET-class errors auto-retry (3 attempts, ~29s backoff).
 *  On retry firing, emit a single stderr line for transparency. */
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
  // strip code fences
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(trimmed);
  const body = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(body);
  } catch {
    // forcibly extract from the first { to the last }
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(body.slice(start, end + 1));
    }
    throw new Error(`Failed to parse JSON from LLM: ${raw.slice(0, 200)}`);
  }
}

// Defensive helpers used by parse_output
export function asString(v: any): string {
  return typeof v === "string" ? v : "";
}

export function asArray<T = any>(v: any): T[] {
  return Array.isArray(v) ? v : [];
}

export { estimateCostUsd, isCliProvider };
