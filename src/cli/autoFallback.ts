// Zero-setup auto-fallback: ユーザーが `claude login` 済みで API key を一切
// export していないとき、critic を自動で anthropic-cli (opus) に切り替える。
//
// 狙い: 「bunx shibaki demo で何も export せずに動く」体験。
// UX 優先設計。ただし以下 2 点で透明性を担保する:
//   1) fallback が起きた瞬間 stderr に 1 行 print (サイレント default 変更は避ける)
//   2) LLM_PROVIDER_CRITICAL を明示 export してるユーザーには一切触らない
//
// 本モジュールは decideFallback (pure) と autoSelectCritic (async wrapper) に
// 分離する。判断ロジックは env + claudeAvailable: boolean だけで決まるので、
// テストは pure 関数側で完結する。
import { cliAvailable } from "../llm/providers/cliShared.ts";

export interface FallbackDecision {
  apply: boolean;
  provider?: "anthropic-cli";
  reason?: string;
  /** ユーザー向け 1 行説明 (stderr に出す) */
  message?: string;
}

/** 判断ロジック (pure)。env を mutate しない。
 *
 *  fallback を打つ条件:
 *    - LLM_PROVIDER_CRITICAL が未設定 (ユーザーが明示選択してない)
 *    - 既定 critic provider の API key が env に無い (= そのままなら preflight で落ちる)
 *    - claude CLI が PATH 上にある
 *
 *  上記すべてを満たすときだけ apply = true。
 */
export function decideFallback(
  env: NodeJS.ProcessEnv,
  claudeAvailable: boolean,
): FallbackDecision {
  // ユーザーが LLM_PROVIDER_CRITICAL を明示してる場合は何もしない
  if (env.LLM_PROVIDER_CRITICAL && env.LLM_PROVIDER_CRITICAL.trim()) {
    return { apply: false };
  }
  // claude が無いなら fallback 先がない
  if (!claudeAvailable) return { apply: false };

  // 既定 critic の API key が env にあるなら API mode で動けるので触らない。
  // ここは detectCriticProvider と同じ logic: main=anthropic 系なら openai、
  // main=openai 系なら anthropic、main=gemini 系なら anthropic が default critic。
  const main = (env.LLM_PROVIDER ?? "").toLowerCase();
  const defaultCritic =
    main === "anthropic" || main === "anthropic-cli" || main === "" ? "openai"
    : main === "openai" || main === "codex-cli" ? "anthropic"
    : /* gemini 系 */ "anthropic";

  const keyName =
    defaultCritic === "openai" ? "OPENAI_API_KEY"
    : defaultCritic === "anthropic" ? "ANTHROPIC_API_KEY"
    : "GEMINI_API_KEY";

  const keyPresent = (env[keyName] ?? "").trim().length >= 8;
  if (keyPresent) return { apply: false };

  // fallback 発動
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

/** Async wrapper: `which claude` で確認 → apply なら env を mutate。
 *
 *  caller は返値の message を自分で stderr に出してよい (サイレントには print しない)。 */
export async function autoSelectCritic(
  env: NodeJS.ProcessEnv = process.env,
): Promise<FallbackDecision> {
  // 事前早期 return: ユーザー明示指定があれば PATH も見ない
  if (env.LLM_PROVIDER_CRITICAL && env.LLM_PROVIDER_CRITICAL.trim()) {
    return { apply: false };
  }
  const claudeAvailable = await cliAvailable("claude");
  const decision = decideFallback(env, claudeAvailable);
  if (decision.apply && decision.provider) {
    env.LLM_PROVIDER_CRITICAL = decision.provider;
    // LLM_MODEL_CRITICAL は router default (anthropic-cli → opus) に任せる。
    // 既に user 設定があるなら尊重 (いじらない)。
  }
  return decision;
}
