// 一時的エラーの自動 retry ラッパ。
//
// 目的: demo / 本番 run で Anthropic 529 overloaded / OpenAI 429 rate_limit /
// Gemini 503 / ネット瞬断 などで loop が壊れるのを防ぐ。初回ユーザーが
// 「AI 混雑してただけ」で「壊れてる」と判断して離脱するのを抑える。
//
// 設計判断:
//  - タイムアウト系は retry しない (既に長時間待った後のさらなる長時間待ちは UX 最悪)
//  - 認証 / 形式エラー (4xx) は retry しない (何度叩いても結果不変)
//  - overloaded / 5xx / ECONNRESET / rate_limit のみ retry
//  - backoff は 3s → 7.5s → 18.75s (factor 2.5, base 3s)。総追加遅延 ~29s
//  - retry 通知は stderr に 1 行 print (サイレント retry はブラックボックス化するので避ける)

export interface RetryOptions {
  /** 総試行回数 (1 回目含む)。default 3 = 最初 + retry 2 回 */
  maxAttempts?: number;
  /** 初回 backoff (ms)。default 3000 */
  baseDelayMs?: number;
  /** backoff 倍率。default 2.5 */
  factor?: number;
  /** retry 時に 1 行 notify するためのコールバック */
  onRetry?: (info: { attempt: number; error: unknown; delayMs: number }) => void;
  /** テスト時のみ: sleep を差し替えて backoff を実時間消費しない */
  sleepFn?: (ms: number) => Promise<void>;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const baseDelayMs = opts.baseDelayMs ?? 3000;
  const factor = opts.factor ?? 2.5;
  const sleep = opts.sleepFn ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (attempt >= maxAttempts) break;
      if (!isTransientError(e)) break;
      const delayMs = Math.round(baseDelayMs * Math.pow(factor, attempt - 1));
      opts.onRetry?.({ attempt, error: e, delayMs });
      await sleep(delayMs);
    }
  }
  throw lastError;
}

/** 「一時的に混んでるだけ、もう一回叩けば通るかも」系のエラーを判定。
 *  以下に true を返す:
 *    - HTTP 429 / 529 / 5xx
 *    - Node errno: ECONNRESET / ETIMEDOUT / EAI_AGAIN / ENETUNREACH / ECONNREFUSED
 *    - message に "overloaded" / "rate limit" / "rate_limit" / "temporarily unavailable" /
 *      "service unavailable" / "bad gateway" / "gateway timeout" を含む
 *  false を返す (permanent として fail-fast):
 *    - HTTP 4xx (429 除く) — 認証 / 形式エラー
 *    - timeout 系 — 既に長時間待った後のさらなる待ちは UX 上 NG
 */
export function isTransientError(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;

  // タイムアウトは明示的に除外 (SDK によっては Error.message 経由で来るので先に判定)
  const msg = typeof e.message === "string" ? e.message.toLowerCase() : "";
  if (msg.includes("timeout") || msg.includes("timed out")) {
    // 例外: gateway timeout は 504 で server 側問題なので retry してよい
    if (msg.includes("gateway timeout") || msg.includes("504")) {
      // fallthrough to generic retry
    } else {
      return false;
    }
  }

  // HTTP status (Anthropic / OpenAI SDK は err.status を付ける)
  const status = typeof e.status === "number" ? e.status
    : typeof e.statusCode === "number" ? e.statusCode
    : undefined;
  if (status !== undefined) {
    if (status === 429 || status === 529) return true;
    if (status >= 500 && status < 600) return true;
    if (status >= 400 && status < 500) return false;
  }

  // Node errno
  const code = typeof e.code === "string" ? e.code : "";
  if (
    code === "ECONNRESET" || code === "ETIMEDOUT" || code === "EAI_AGAIN" ||
    code === "ENETUNREACH" || code === "ECONNREFUSED" || code === "EPIPE"
  ) {
    return true;
  }

  // message heuristics (CLI provider / 汎用)
  if (msg.includes("overloaded")) return true;
  if (msg.includes("rate limit") || msg.includes("rate_limit")) return true;
  if (msg.includes("temporarily unavailable")) return true;
  if (msg.includes("service unavailable")) return true;
  if (msg.includes("bad gateway")) return true;
  if (msg.includes("gateway timeout")) return true;
  if (msg.includes("econnreset")) return true;
  if (msg.includes("overloaded_error")) return true;

  return false;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
