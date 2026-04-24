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
// CLI mode:
// - critic が anthropic-cli / gemini-cli / codex-cli の場合、critic は API key を持たない
//   ので strip 対象の key も存在しない。ただし LLM_PROVIDER_CRITICAL / LLM_MODEL_CRITICAL 等の
//   config 系 env は従来通り strip する (disclosure 回避)。
//
// 注意: agent CLI が multi-provider (例: aider) で複数 key を必要とする場合、
// この strip が agent を壊す可能性がある。その場合 SHIBAKI_ALLOW_AGENT_SECRETS=1 で opt-out。

import { type ProviderName, type ProviderFamily, providerFamily, isCliProvider } from "../llm/types.ts";

// 後方互換: Provider は旧 API 型 (3 値) と CLI 型 (6 値) のユニオン。
// 新規コードは ProviderName を使う。
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
  // default: main と別 family になるよう自動選択
  //  anthropic 系 → openai, openai 系 → anthropic, gemini 系 → anthropic
  const main = detectMainProvider(env);
  const fam = providerFamily(main);
  if (fam === "anthropic") return "openai";
  if (fam === "openai") return "anthropic";
  return "anthropic"; // main が gemini 系
}

export function detectMainProvider(env: NodeJS.ProcessEnv = process.env): ProviderName {
  return parse(env.LLM_PROVIDER) ?? "anthropic";
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
  const critic = detectCriticProvider(parentEnv);
  const main = detectMainProvider(parentEnv);

  // critic 側 family に紐づく API key を strip。
  // ただし以下のケースでは strip しない:
  //  1) critic が CLI provider: そもそも critic は API key を使わないので leak する key が無い。
  //     この場合 ANTHROPIC_API_KEY 等が env にあっても、それは main 側の資産なので残す。
  //  2) main も critic も API で同 family: 共有 key なので main が必要とする。
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
