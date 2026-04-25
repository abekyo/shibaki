// Zero-setup auto-fallback: when the user has run `claude login` and has not
// exported any API key, automatically switch the critic to anthropic-cli (opus).
//
// Aim: the "bunx shibaki demo works without exporting anything" experience.
// UX-first design, but transparency is preserved by two rules:
//   1) Print one line to stderr the moment fallback fires (avoid silent default changes)
//   2) Don't touch users who have explicitly exported LLM_PROVIDER_CRITICAL
//
// This module is split into decideFallback (pure) and autoSelectCritic (async wrapper).
// The decision logic depends only on env + claudeAvailable: boolean, so tests
// can be self-contained on the pure-function side.
import { cliAvailable } from "../llm/providers/cliShared.ts";

export interface FallbackDecision {
  apply: boolean;
  provider?: "anthropic-cli";
  reason?: string;
  /** One-line user-facing explanation (printed to stderr) */
  message?: string;
}

/** Decision logic (pure). Does not mutate env.
 *
 *  Conditions to fire fallback:
 *    - LLM_PROVIDER_CRITICAL is unset (user didn't explicitly choose)
 *    - Default critic provider's API key is not in env (= preflight would otherwise fail)
 *    - claude CLI is on PATH
 *
 *  Only when all of the above hold is apply = true.
 */
export function decideFallback(
  env: NodeJS.ProcessEnv,
  claudeAvailable: boolean,
): FallbackDecision {
  // Do nothing if the user has explicitly set LLM_PROVIDER_CRITICAL
  if (env.LLM_PROVIDER_CRITICAL && env.LLM_PROVIDER_CRITICAL.trim()) {
    return { apply: false };
  }
  // No fallback target if claude is missing
  if (!claudeAvailable) return { apply: false };

  // If the default critic's API key is in env, it can run in API mode — don't touch it.
  // Same logic as detectCriticProvider: main=anthropic family → openai,
  // main=openai family → anthropic, main=gemini family → anthropic as default critic.
  const main = (env.LLM_PROVIDER ?? "").toLowerCase();
  const defaultCritic =
    main === "anthropic" || main === "anthropic-cli" || main === "" ? "openai"
    : main === "openai" || main === "codex-cli" ? "anthropic"
    : /* gemini family */ "anthropic";

  const keyName =
    defaultCritic === "openai" ? "OPENAI_API_KEY"
    : defaultCritic === "anthropic" ? "ANTHROPIC_API_KEY"
    : "GEMINI_API_KEY";

  const keyPresent = (env[keyName] ?? "").trim().length >= 8;
  if (keyPresent) return { apply: false };

  // Fire fallback
  return {
    apply: true,
    provider: "anthropic-cli",
    reason: `no ${keyName} in env, claude CLI available`,
    message:
      `⚠ auto-selected Plan mode: critic=anthropic-cli (opus)\n` +
      `  reason: no ${keyName} set, 'claude' is on PATH\n` +
      `  blind-spot mitigation: main/critic model tier (sonnet → opus)\n` +
      `  to override: export LLM_PROVIDER_CRITICAL=gemini  (or openai / anthropic)`,
  };
}

/** Async wrapper: confirm via `which claude` → mutate env if apply.
 *
 *  The caller may print the returned message to stderr themselves (don't print silently). */
export async function autoSelectCritic(
  env: NodeJS.ProcessEnv = process.env,
): Promise<FallbackDecision> {
  // Early return: if the user has explicitly set it, don't even check PATH
  if (env.LLM_PROVIDER_CRITICAL && env.LLM_PROVIDER_CRITICAL.trim()) {
    return { apply: false };
  }
  const claudeAvailable = await cliAvailable("claude");
  const decision = decideFallback(env, claudeAvailable);
  if (decision.apply && decision.provider) {
    env.LLM_PROVIDER_CRITICAL = decision.provider;
    // Leave LLM_MODEL_CRITICAL to the router default (anthropic-cli → opus).
    // Respect any existing user setting (don't touch it).
  }
  return decision;
}
