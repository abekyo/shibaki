// retry ラッパの unit test。
// sleepFn を no-op に差し替えて backoff で実時間を消費しないようにする。
import { expect, test, describe } from "bun:test";
import { withRetry, isTransientError } from "../src/llm/retry.ts";

const noSleep = async (_ms: number) => {};

describe("isTransientError — 一時的エラー判定", () => {
  test("HTTP 429 rate limit は transient", () => {
    expect(isTransientError({ status: 429, message: "rate limited" })).toBe(true);
  });
  test("HTTP 529 overloaded は transient", () => {
    expect(isTransientError({ status: 529, message: "overloaded" })).toBe(true);
  });
  test("HTTP 500 / 502 / 503 / 504 は transient", () => {
    for (const s of [500, 502, 503, 504]) {
      expect(isTransientError({ status: s, message: "server error" })).toBe(true);
    }
  });
  test("HTTP 400 / 401 / 403 / 404 / 422 は permanent", () => {
    for (const s of [400, 401, 403, 404, 422]) {
      expect(isTransientError({ status: s, message: "bad request" })).toBe(false);
    }
  });
  test("errno ECONNRESET / ETIMEDOUT / ECONNREFUSED は transient", () => {
    expect(isTransientError({ code: "ECONNRESET" })).toBe(true);
    expect(isTransientError({ code: "ETIMEDOUT" })).toBe(true);
    expect(isTransientError({ code: "ECONNREFUSED" })).toBe(true);
    expect(isTransientError({ code: "EAI_AGAIN" })).toBe(true);
  });
  test("message に overloaded / rate_limit を含む Error は transient (CLI provider 用)", () => {
    expect(isTransientError(new Error("claude CLI exited with code 1: overloaded_error"))).toBe(true);
    expect(isTransientError(new Error("openai: rate_limit_exceeded"))).toBe(true);
    expect(isTransientError(new Error("service unavailable"))).toBe(true);
    expect(isTransientError(new Error("Bad gateway"))).toBe(true);
  });
  test("timeout 系は permanent 扱い (既に長時間待った後の retry は UX 悪)", () => {
    expect(isTransientError(new Error("request timed out"))).toBe(false);
    expect(isTransientError(new Error("timeout after 60s"))).toBe(false);
  });
  test("例外: gateway timeout は 504 相当なので retry", () => {
    expect(isTransientError(new Error("Gateway Timeout"))).toBe(true);
  });
  test("null / primitive / 空 object は non-transient", () => {
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
    expect(isTransientError("string error")).toBe(false);
    expect(isTransientError({})).toBe(false);
  });
});

describe("withRetry — 再試行ロジック", () => {
  test("成功なら 1 回で返す", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      return "ok";
    }, { sleepFn: noSleep });
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  test("transient エラーなら maxAttempts まで retry", async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls++;
      throw Object.assign(new Error("overloaded"), { status: 529 });
    }, { sleepFn: noSleep })).rejects.toThrow("overloaded");
    expect(calls).toBe(3); // default maxAttempts=3
  });

  test("transient 後に成功したら返す", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error("overloaded"), { status: 529 });
      return "ok";
    }, { sleepFn: noSleep });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  test("permanent エラーは即座に throw (retry しない)", async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls++;
      throw Object.assign(new Error("bad request"), { status: 400 });
    }, { sleepFn: noSleep })).rejects.toThrow("bad request");
    expect(calls).toBe(1);
  });

  test("onRetry callback は retry のたびに呼ばれる (最終失敗では呼ばれない)", async () => {
    const events: number[] = [];
    await expect(withRetry(async () => {
      throw Object.assign(new Error("overloaded"), { status: 529 });
    }, {
      sleepFn: noSleep,
      onRetry: ({ attempt }) => { events.push(attempt); },
    })).rejects.toThrow();
    // 3 attempts = 2 retries = 2 onRetry events (attempt 1 失敗後, attempt 2 失敗後)
    expect(events).toEqual([1, 2]);
  });

  test("maxAttempts=1 なら retry しない", async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls++;
      throw Object.assign(new Error("overloaded"), { status: 529 });
    }, { sleepFn: noSleep, maxAttempts: 1 })).rejects.toThrow();
    expect(calls).toBe(1);
  });

  test("backoff は exponential (3s, 7.5s, 18.75s で factor 2.5)", async () => {
    const delays: number[] = [];
    await expect(withRetry(async () => {
      throw Object.assign(new Error("overloaded"), { status: 529 });
    }, {
      sleepFn: async (ms) => { delays.push(ms); },
      maxAttempts: 4,
    })).rejects.toThrow();
    // base=3000, factor=2.5: [3000, 7500, 18750]
    expect(delays).toEqual([3000, 7500, 18750]);
  });
});
