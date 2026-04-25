// Unit tests for the retry wrapper.
// Substitutes sleepFn with a no-op so backoff does not consume real time.
import { expect, test, describe } from "bun:test";
import { withRetry, isTransientError } from "../src/llm/retry.ts";

const noSleep = async (_ms: number) => {};

describe("isTransientError — transient error detection", () => {
  test("HTTP 429 rate limit is transient", () => {
    expect(isTransientError({ status: 429, message: "rate limited" })).toBe(true);
  });
  test("HTTP 529 overloaded is transient", () => {
    expect(isTransientError({ status: 529, message: "overloaded" })).toBe(true);
  });
  test("HTTP 500 / 502 / 503 / 504 are transient", () => {
    for (const s of [500, 502, 503, 504]) {
      expect(isTransientError({ status: s, message: "server error" })).toBe(true);
    }
  });
  test("HTTP 400 / 401 / 403 / 404 / 422 are permanent", () => {
    for (const s of [400, 401, 403, 404, 422]) {
      expect(isTransientError({ status: s, message: "bad request" })).toBe(false);
    }
  });
  test("errno ECONNRESET / ETIMEDOUT / ECONNREFUSED are transient", () => {
    expect(isTransientError({ code: "ECONNRESET" })).toBe(true);
    expect(isTransientError({ code: "ETIMEDOUT" })).toBe(true);
    expect(isTransientError({ code: "ECONNREFUSED" })).toBe(true);
    expect(isTransientError({ code: "EAI_AGAIN" })).toBe(true);
  });
  test("Errors with overloaded / rate_limit in message are transient (for CLI providers)", () => {
    expect(isTransientError(new Error("claude CLI exited with code 1: overloaded_error"))).toBe(true);
    expect(isTransientError(new Error("openai: rate_limit_exceeded"))).toBe(true);
    expect(isTransientError(new Error("service unavailable"))).toBe(true);
    expect(isTransientError(new Error("Bad gateway"))).toBe(true);
  });
  test("timeout-class errors treated as permanent (retrying after a long wait is bad UX)", () => {
    expect(isTransientError(new Error("request timed out"))).toBe(false);
    expect(isTransientError(new Error("timeout after 60s"))).toBe(false);
  });
  test("exception: gateway timeout maps to 504, so retry", () => {
    expect(isTransientError(new Error("Gateway Timeout"))).toBe(true);
  });
  test("null / primitive / empty object are non-transient", () => {
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
    expect(isTransientError("string error")).toBe(false);
    expect(isTransientError({})).toBe(false);
  });
});

describe("withRetry — retry logic", () => {
  test("returns after one call on success", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      return "ok";
    }, { sleepFn: noSleep });
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  test("retries up to maxAttempts on transient error", async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls++;
      throw Object.assign(new Error("overloaded"), { status: 529 });
    }, { sleepFn: noSleep })).rejects.toThrow("overloaded");
    expect(calls).toBe(3); // default maxAttempts=3
  });

  test("returns when success follows a transient error", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error("overloaded"), { status: 529 });
      return "ok";
    }, { sleepFn: noSleep });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  test("permanent error throws immediately (no retry)", async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls++;
      throw Object.assign(new Error("bad request"), { status: 400 });
    }, { sleepFn: noSleep })).rejects.toThrow("bad request");
    expect(calls).toBe(1);
  });

  test("onRetry callback fires on each retry (not on final failure)", async () => {
    const events: number[] = [];
    await expect(withRetry(async () => {
      throw Object.assign(new Error("overloaded"), { status: 529 });
    }, {
      sleepFn: noSleep,
      onRetry: ({ attempt }) => { events.push(attempt); },
    })).rejects.toThrow();
    // 3 attempts = 2 retries = 2 onRetry events (after attempt 1 fails, after attempt 2 fails)
    expect(events).toEqual([1, 2]);
  });

  test("maxAttempts=1 does not retry", async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls++;
      throw Object.assign(new Error("overloaded"), { status: 529 });
    }, { sleepFn: noSleep, maxAttempts: 1 })).rejects.toThrow();
    expect(calls).toBe(1);
  });

  test("backoff is exponential (3s, 7.5s, 18.75s with factor 2.5)", async () => {
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
