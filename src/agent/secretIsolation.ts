// Secret isolation: hide critic-only API keys / config from agent subprocesses.
//
// Principle: "structural isolation of secrets — invisible to LLM-generated code"
// - The Shibaki parent process holds the critic's API key
// - Agents spawned from it (claude -p / aider, etc.) do not inherit it
// - Structurally prevents a malicious agent from exfiltrating the critic key
//
// Stripped:
// - API key of the critic-side provider (OPENAI / GEMINI / ANTHROPIC, whichever applies to the critic)
// - Critic-only config (LLM_PROVIDER_CRITICAL / LLM_MODEL_CRITICAL)
//
// Not stripped:
// - API key of the agent-side provider (e.g., if agent is claude -p, ANTHROPIC_API_KEY is kept)
// - Basic env like HOME / PATH / SHELL
//
// CLI mode:
// - When the critic is anthropic-cli / gemini-cli / codex-cli, the critic has no API key,
//   so there's no key to strip. However, config env like LLM_PROVIDER_CRITICAL / LLM_MODEL_CRITICAL
//   are stripped as before (avoid disclosure).
//
// Note: if the agent CLI is multi-provider (e.g., aider) and needs multiple keys,
// this strip may break the agent. In that case opt-out via SHIBAKI_ALLOW_AGENT_SECRETS=1.

import { type ProviderName, type ProviderFamily, providerFamily, isCliProvider } from "../llm/types.ts";

// Backward compatibility: Provider is a union of the old API type (3 values) and the CLI type (6 values).
// New code uses ProviderName.
export type Provider = ProviderName;

const VALID: ProviderName[] = [
  "anthropic", "openai", "gemini",
  "anthropic-cli", "gemini-cli", "codex-cli",
];

function parse(v: string | undefined): ProviderName | null {
  const s = v?.toLowerCase() ?? "";
  return (VALID as string[]).includes(s) ? (s as ProviderName) : null;
}

export function detectCriticProvider(env: NodeJS.ProcessEnv = process.env): ProviderName {
  const explicit = parse(env.LLM_PROVIDER_CRITICAL);
  if (explicit) return explicit;
  // default: auto-select to be a different family from main
  //  anthropic family → openai, openai family → anthropic, gemini family → anthropic
  const main = detectMainProvider(env);
  const fam = providerFamily(main);
  if (fam === "anthropic") return "openai";
  if (fam === "openai") return "anthropic";
  return "anthropic"; // main is gemini family
}

export function detectMainProvider(env: NodeJS.ProcessEnv = process.env): ProviderName {
  return parse(env.LLM_PROVIDER) ?? "anthropic";
}

/**
 * Build the env to pass to the agent subprocess. Strips critic-only secrets.
 * Does not strip if SHIBAKI_ALLOW_AGENT_SECRETS=1 is set (opt-out).
 */
export function buildAgentEnv(parentEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (parentEnv.SHIBAKI_ALLOW_AGENT_SECRETS === "1") {
    return { ...parentEnv };
  }
  const env = { ...parentEnv };
  const critic = detectCriticProvider(parentEnv);
  const main = detectMainProvider(parentEnv);

  // Strip API keys tied to the critic-side family.
  // Don't strip in the following cases:
  //  1) Critic is a CLI provider: the critic doesn't use an API key, so there's no key to leak.
  //     In this case, even if ANTHROPIC_API_KEY etc. is in env, it's a main-side asset and is kept.
  //  2) Main and critic are both API in the same family: it's a shared key needed by main.
  const keysByFamily: Record<ProviderFamily, string[]> = {
    openai: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID"],
    anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"],
    gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  };

  const criticIsApi = !isCliProvider(critic);
  const bothApiSameFamily =
    criticIsApi && !isCliProvider(main) && providerFamily(main) === providerFamily(critic);

  if (criticIsApi && !bothApiSameFamily) {
    for (const k of keysByFamily[providerFamily(critic)]) {
      delete env[k];
    }
  }

  // Critic-only config (not a key, but avoid disclosure)
  delete env.LLM_PROVIDER_CRITICAL;
  delete env.LLM_MODEL_CRITICAL;
  delete env.LLM_PROVIDER_LIGHT;
  delete env.LLM_MODEL_LIGHT;

  // Hide Shibaki internal config from the agent as well
  delete env.LLM_PROVIDER; // Don't expose the parent router's behavior to the agent
  delete env.SHIBAKI_ALLOW_AGENT_SECRETS;

  return env;
}
