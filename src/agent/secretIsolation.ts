// Secret isolation: agent subprocess は critic 専用の API key / 設定を見えないようにする。
//
// 原則: 「秘密情報の構造的隔離 — LLM 生成コードから不可視」
// - Shibaki 親プロセスは critic 用 API key を持つ
// - そこから spawn される agent (claude -p / aider 等) はこれを inherit しない
// - 悪意ある agent が critic key を exfiltration するのを構造的に防ぐ
//
// strip 対象:
// - critic 側 provider の API key (OPENAI / GEMINI / ANTHROPIC のうち critic に該当するもの)
// - critic 専用設定 (LLM_PROVIDER_CRITICAL / LLM_MODEL_CRITICAL)
//
// strip しない:
// - agent 側 provider の API key (例: agent が claude -p なら ANTHROPIC_API_KEY は維持)
// - HOME / PATH / SHELL 等の基本 env
//
// 注意: agent CLI が multi-provider (例: aider) で複数 key を必要とする場合、
// この strip が agent を壊す可能性がある。その場合 SHIBAKI_ALLOW_AGENT_SECRETS=1 で opt-out。

export type Provider = "anthropic" | "openai" | "gemini";

export function detectCriticProvider(env: NodeJS.ProcessEnv = process.env): Provider {
  const explicit = env.LLM_PROVIDER_CRITICAL?.toLowerCase();
  if (explicit === "anthropic" || explicit === "openai" || explicit === "gemini") {
    return explicit;
  }
  // default: main の逆 provider (anthropic main → openai critic)
  const mainProvider = env.LLM_PROVIDER?.toLowerCase() || "anthropic";
  return mainProvider === "anthropic" ? "openai" : "anthropic";
}

export function detectMainProvider(env: NodeJS.ProcessEnv = process.env): Provider {
  const v = env.LLM_PROVIDER?.toLowerCase();
  if (v === "anthropic" || v === "openai" || v === "gemini") return v;
  return "anthropic";
}

/**
 * agent subprocess に渡す env を作る。critic 用 secret を strip。
 * SHIBAKI_ALLOW_AGENT_SECRETS=1 が設定されてたら strip しない (opt-out)。
 */
export function buildAgentEnv(parentEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (parentEnv.SHIBAKI_ALLOW_AGENT_SECRETS === "1") {
    return { ...parentEnv };
  }
  const env = { ...parentEnv };
  const criticProvider = detectCriticProvider(parentEnv);
  const mainProvider = detectMainProvider(parentEnv);

  // critic 側 provider の key を strip (ただし main 側で必要なら残す)
  const keysByProvider: Record<Provider, string[]> = {
    openai: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID"],
    anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"],
    gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  };
  if (criticProvider !== mainProvider) {
    for (const k of keysByProvider[criticProvider]) {
      delete env[k];
    }
  }

  // critic 専用設定 (key じゃないが disclosure を避ける)
  delete env.LLM_PROVIDER_CRITICAL;
  delete env.LLM_MODEL_CRITICAL;
  delete env.LLM_PROVIDER_LIGHT;
  delete env.LLM_MODEL_LIGHT;

  // Shibaki 内部設定も agent から見えなくする
  delete env.LLM_PROVIDER; // 親 router の挙動を agent に晒さない
  delete env.SHIBAKI_ALLOW_AGENT_SECRETS;

  return env;
}
