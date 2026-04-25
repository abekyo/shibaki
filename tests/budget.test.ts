import { expect, test, describe } from "bun:test";
import { newBudget, checkBudget, budgetSummary } from "../src/loop/budget.ts";

describe("budget", () => {
  test("a fresh budget has no breach", () => {
    const cfg = { maxTries: 10, timeoutMs: 10_000 };
    const b = newBudget(cfg);
    expect(checkBudget(b, cfg)).toBeNull();
  });

  test("breach on try-limit", () => {
    const cfg = { maxTries: 3, timeoutMs: 10_000 };
    const b = newBudget(cfg);
    b.tries = 3;
    expect(checkBudget(b, cfg)).toBe("tries");
  });

  test("breach on timeout", () => {
    const cfg = { maxTries: 10, timeoutMs: 10 };
    const b = newBudget(cfg);
    b.startedAt = Date.now() - 1000;
    expect(checkBudget(b, cfg)).toBe("timeout");
  });

  test("breach on cost limit (only when maxCostUsd is set)", () => {
    const cfg = { maxTries: 10, timeoutMs: 10_000, maxCostUsd: 1 };
    const b = newBudget(cfg);
    b.costUsd = 2;
    expect(checkBudget(b, cfg)).toBe("cost");
  });

  test("summary returns elapsedSec / tries / costUsd", () => {
    const b = newBudget({ maxTries: 10, timeoutMs: 10_000 });
    b.tries = 2;
    b.costUsd = 0.1234;
    const s = budgetSummary(b);
    expect(s.tries).toBe(2);
    expect(s.costUsd).toBe(0.1234);
    expect(typeof s.elapsedSec).toBe("number");
  });
});
