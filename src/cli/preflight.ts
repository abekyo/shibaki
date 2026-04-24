// Pre-flight check: validate required env / dependencies at startup, fail-closed.
// Implementation of "fail-closed: silent / unknown is rejected".
import { detectCriticProvider, detectMainProvider, type Provider } from "../agent/secretIsolation.ts";

export interface PreflightFailure {
  reason: string;
  hint: string;
}

const REQUIRED_KEY: Record<Provider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
};

const KEY_SOURCE_HINT: Record<Provider, string> = {
  anthropic: "https://console.anthropic.com (separate API contract from Claude Code plan)",
  openai: "https://platform.openai.com/api-keys",
  gemini: "https://aistudio.google.com/apikey (free tier available)",
};

/** Verify the critic provider's API key is set.
 *  Does not check the agent provider (the agent CLI itself is responsible for that).
 */
export function preflightCriticKey(env: NodeJS.ProcessEnv = process.env): PreflightFailure | null {
  const criticProvider = detectCriticProvider(env);
  const requiredKey = REQUIRED_KEY[criticProvider];
  const value = env[requiredKey];
  if (!value || value.trim().length < 8) {
    return {
      reason: `${requiredKey} for critic is not set (provider: ${criticProvider})`,
      hint: `export ${requiredKey}=...   get one at: ${KEY_SOURCE_HINT[criticProvider]}`,
    };
  }
  // minimal format check
  if (criticProvider === "openai" && !value.startsWith("sk-")) {
    return {
      reason: `${requiredKey} has an invalid format (expected to start with "sk-")`,
      hint: "Get a valid key at https://platform.openai.com/api-keys",
    };
  }
  if (criticProvider === "anthropic" && !value.startsWith("sk-ant-")) {
    return {
      reason: `${requiredKey} has an invalid format (expected to start with "sk-ant-")`,
      hint: "Get a valid key at https://console.anthropic.com",
    };
  }
  if (criticProvider === "gemini" && !value.startsWith("AIza")) {
    return {
      reason: `${requiredKey} has an invalid format (expected to start with "AIza")`,
      hint: "Get a valid key at https://aistudio.google.com/apikey",
    };
  }
  return null;
}

/** If main and critic providers are the same, there's a self-critique blind-spot risk.
 *  Different providers are enforced by default (North Star principle 2).
 *  Set SHIBAKI_ALLOW_SAME_PROVIDER=1 to opt out.
 */
export function preflightProviderSeparation(
  env: NodeJS.ProcessEnv = process.env,
): PreflightFailure | null {
  if (env.SHIBAKI_ALLOW_SAME_PROVIDER === "1") return null;
  const main = detectMainProvider(env);
  const critic = detectCriticProvider(env);
  if (main === critic) {
    return {
      reason: `main provider and critic provider are the same (${main}) — self-critique blind spot risk`,
      hint:
        `Set LLM_PROVIDER_CRITICAL to a different provider, ` +
        `or export SHIBAKI_ALLOW_SAME_PROVIDER=1 if you accept the risk.`,
    };
  }
  return null;
}

/** Run all pre-flight checks. Return the first failure (fail-closed). */
export function runAllPreflight(env: NodeJS.ProcessEnv = process.env): PreflightFailure | null {
  return preflightCriticKey(env) ?? preflightProviderSeparation(env);
}
