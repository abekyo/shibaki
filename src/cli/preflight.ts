// Pre-flight check: validate required env / dependencies at startup, fail-closed.
// Implementation of "fail-closed: silent / unknown is rejected".
import {
  detectCriticProvider,
  detectMainProvider,
  type Provider,
} from "../agent/secretIsolation.ts";
import { providerFamily, isCliProvider, type ProviderName } from "../llm/types.ts";
import { cliAvailable, CLI_INFO } from "../llm/providers/cliShared.ts";

export interface PreflightFailure {
  reason: string;
  hint: string;
}

// Only API providers require a key. CLI providers have no key (rely on the user's CLI auth).
const REQUIRED_KEY: Record<"anthropic" | "openai" | "gemini", string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
};

const KEY_SOURCE_HINT: Record<"anthropic" | "openai" | "gemini", string> = {
  anthropic: "https://console.anthropic.com (separate API contract from Claude Code plan)",
  openai: "https://platform.openai.com/api-keys",
  gemini: "https://aistudio.google.com/apikey (free tier available)",
};


/** Verify the critic provider's API key is set.
 *  Does not check the agent provider (the agent CLI itself is responsible for that).
 *  CLI-backed critic providers (anthropic-cli / gemini-cli / codex-cli) have no API key —
 *  skip the check entirely; CLI availability is verified by preflightCriticCli. */
export function preflightCriticKey(env: NodeJS.ProcessEnv = process.env): PreflightFailure | null {
  const criticProvider = detectCriticProvider(env);
  if (isCliProvider(criticProvider)) {
    // CLI mode: no API key needed. Caller (user) is responsible for CLI auth.
    return null;
  }
  const apiProvider = criticProvider as "anthropic" | "openai" | "gemini";
  const requiredKey = REQUIRED_KEY[apiProvider];
  const value = env[requiredKey];
  if (!value || value.trim().length < 8) {
    return {
      reason: `${requiredKey} for critic is not set (provider: ${criticProvider})`,
      hint: `export ${requiredKey}=...   get one at: ${KEY_SOURCE_HINT[apiProvider]}`,
    };
  }
  // minimal format check
  if (apiProvider === "openai" && !value.startsWith("sk-")) {
    return {
      reason: `${requiredKey} has an invalid format (expected to start with "sk-")`,
      hint: "Get a valid key at https://platform.openai.com/api-keys",
    };
  }
  if (apiProvider === "anthropic" && !value.startsWith("sk-ant-")) {
    return {
      reason: `${requiredKey} has an invalid format (expected to start with "sk-ant-")`,
      hint: "Get a valid key at https://console.anthropic.com",
    };
  }
  if (apiProvider === "gemini" && !value.startsWith("AIza")) {
    return {
      reason: `${requiredKey} has an invalid format (expected to start with "AIza")`,
      hint: "Get a valid key at https://aistudio.google.com/apikey",
    };
  }
  return null;
}

/** If main and critic providers are the same family, there's a self-critique blind-spot risk.
 *  Different providers are enforced by default (North Star principle 2).
 *
 *  Relaxations:
 *    - SHIBAKI_ALLOW_SAME_PROVIDER=1 → opt-out entirely.
 *    - CLI critic (anthropic-cli / gemini-cli / codex-cli) auto-allowed:
 *      in CLI mode the user routinely uses different models for main vs critic
 *      (e.g. main=sonnet, critic=opus) which already mitigates the blind spot.
 *      UX-first path per project decision.
 */
export function preflightProviderSeparation(
  env: NodeJS.ProcessEnv = process.env,
): PreflightFailure | null {
  if (env.SHIBAKI_ALLOW_SAME_PROVIDER === "1") return null;
  const main = detectMainProvider(env);
  const critic = detectCriticProvider(env);
  if (providerFamily(main) !== providerFamily(critic)) return null;

  // Same family. Auto-allow if critic is CLI (UX-first per Q3=A).
  if (isCliProvider(critic)) return null;

  return {
    reason:
      `main provider and critic provider are in the same family ` +
      `(main=${main}, critic=${critic}) — self-critique blind spot risk`,
    hint:
      `Set LLM_PROVIDER_CRITICAL to a different-family provider, ` +
      `or export SHIBAKI_ALLOW_SAME_PROVIDER=1 if you accept the risk.`,
  };
}

/** If the critic is a CLI-backed provider, verify the bin is actually on PATH.
 *  Without this, a typo or missing install surfaces as an mid-run ENOENT
 *  instead of a clear startup error.
 *
 *  `check` is injectable for testing — defaults to real `which` via cliShared.
 */
export async function preflightCriticCli(
  env: NodeJS.ProcessEnv = process.env,
  check: (bin: string) => Promise<boolean> = cliAvailable,
): Promise<PreflightFailure | null> {
  const critic = detectCriticProvider(env);
  if (!isCliProvider(critic)) return null;

  const info = CLI_INFO[critic as keyof typeof CLI_INFO];
  const bin = (env[info.envVar] ?? "").trim() || info.defaultBin;
  const ok = await check(bin);
  if (ok) return null;
  return {
    reason: `critic CLI "${bin}" (for provider ${critic}) not found in PATH`,
    hint: info.install,
  };
}

/** Run all pre-flight checks. Return the first failure (fail-closed). */
export async function runAllPreflight(
  env: NodeJS.ProcessEnv = process.env,
  check: (bin: string) => Promise<boolean> = cliAvailable,
): Promise<PreflightFailure | null> {
  return (
    preflightCriticKey(env) ??
    preflightProviderSeparation(env) ??
    (await preflightCriticCli(env, check))
  );
}
