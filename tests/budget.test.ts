import { expect, test, describe } from "bun:test";
import { newBudget, checkBudget, budgetSummary } from "../src/loop/budget.ts";

describe("budget", () => {
  test("新規予算は breach なし", () => {
    const cfg = { maxTries: 10, timeoutMs: 10_000 };
    const b = newBudget(cfg);
    expect(checkBudget(b, cfg)).toBeNull();
  });

  test("試行上限で breach", () => {
    const cfg = { maxTries: 3, timeoutMs: 10_000 };
    const b = newBudget(cfg);
    b.tries = 3;
    expect(checkBudget(b, cfg)).toBe("tries");
  });

  test("時間切れで breach", () => {
    const cfg = { maxTries: 10, timeoutMs: 10 };
    const b = newBudget(cfg);
    b.startedAt = Date.now() - 1000;
    expect(checkBudget(b, cfg)).toBe("timeout");
  });

  test("cost 上限で breach (maxCostUsd 指定時のみ)", () => {
    const cfg = { maxTries: 10, timeoutMs: 10_000, maxCostUsd: 1 };
    const b = newBudget(cfg);
    b.costUsd = 2;
    expect(checkBudget(b, cfg)).toBe("cost");
  });

  test("summary は elapsedSec / tries / costUsd を返す", () => {
    const b = newBudget({ maxTries: 10, timeoutMs: 10_000 });
    b.tries = 2;
    b.costUsd = 0.1234;
    const s = budgetSummary(b);
    expect(s.tries).toBe(2);
    expect(s.costUsd).toBe(0.1234);
    expect(typeof s.elapsedSec).toBe("number");
  });
});
