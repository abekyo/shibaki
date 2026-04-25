// Auto-retry wrapper for transient errors.
//
// Purpose: prevent the loop from breaking on Anthropic 529 overloaded / OpenAI 429 rate_limit /
// Gemini 503 / brief network drops during demo or production runs. Stops first-time users from
// concluding "it's broken" when really "the AI was just busy" and bouncing.
//
// Design decisions:
//  - Don't retry timeouts (waiting even longer after already waiting a long time is the worst UX)
//  - Don't retry auth / format errors (4xx) — same input gives same result
//  - Only retry overloaded / 5xx / ECONNRESET / rate_limit
//  - Backoff: 3s → 7.5s → 18.75s (factor 2.5, base 3s). ~29s total added delay
//  - Print one stderr line on retry (silent retry becomes a black box — avoid that)

export interface RetryOptions {
  /** Total attempts (including the first). default 3 = initial + 2 retries */
  maxAttempts?: number;
  /** Initial backoff (ms). default 3000 */
  baseDelayMs?: number;
  /** Backoff multiplier. default 2.5 */
  factor?: number;
  /** Callback invoked once per retry to emit a notification line */
  onRetry?: (info: { attempt: number; error: unknown; delayMs: number }) => void;
  /** Tests only: replace sleep so backoff doesn't consume real time */
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

/** Decides whether an error looks like "just transiently busy, try again".
 *  Returns true for:
 *    - HTTP 429 / 529 / 5xx
 *    - Node errno: ECONNRESET / ETIMEDOUT / EAI_AGAIN / ENETUNREACH / ECONNREFUSED
 *    - message contains "overloaded" / "rate limit" / "rate_limit" / "temporarily unavailable" /
 *      "service unavailable" / "bad gateway" / "gateway timeout"
 *  Returns false (treat as permanent, fail-fast) for:
 *    - HTTP 4xx (excluding 429) — auth / format errors
 *    - timeouts — UX-bad to wait even longer after already waiting a long time
 */
export function isTransientError(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;

  // Explicitly exclude timeouts (some SDKs surface them via Error.message, so check first)
  const msg = typeof e.message === "string" ? e.message.toLowerCase() : "";
  if (msg.includes("timeout") || msg.includes("timed out")) {
    // Exception: gateway timeout is 504, a server-side problem, so retrying is fine
    if (msg.includes("gateway timeout") || msg.includes("504")) {
      // fallthrough to generic retry
    } else {
      return false;
    }
  }

  // HTTP status (Anthropic / OpenAI SDKs attach err.status)
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

  // message heuristics (CLI providers / generic)
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
