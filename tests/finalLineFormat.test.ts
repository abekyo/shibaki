// Regex contract test for the stable final-line output.
// Locks the format that automation users (CI / scripts) parse.
//
// If you change anything that breaks these regexes, you are breaking the
// public CLI contract — bump the major version and document the migration.
import { expect, test, describe } from "bun:test";
import { formatSuccessLine, formatFailureLine } from "../src/loop/orchestrator.ts";

// Single regex that captures both success and failure shapes:
//   group 1: "✓ done" | "✗ failed"
//   group 2: time string ("Ns" or "MmNs")
//   group 3: tries (integer)
//   group 4: extra ($cost for success / reason for failure)
const FINAL_LINE = /^(✓ done|✗ failed) \(([^/]+) \/ (\d+) tries \/ (.+)\)$/;

describe("formatSuccessLine — locked contract", () => {
  test("typical: 2m35s, 2 tries, $0.012", () => {
    const line = formatSuccessLine(2, 155, 0.012);
    expect(line).toBe("✓ done (2m35s / 2 tries / $0.012)");
    const m = FINAL_LINE.exec(line);
    expect(m?.[1]).toBe("✓ done");
    expect(m?.[2]).toBe("2m35s");
    expect(m?.[3]).toBe("2");
    expect(m?.[4]).toBe("$0.012");
  });

  test("under-1-min uses 'Ns' (no leading 0m)", () => {
    expect(formatSuccessLine(1, 47, 0.005)).toBe("✓ done (47s / 1 tries / $0.005)");
  });

  test("plan mode: $0.000 (the canonical zero)", () => {
    expect(formatSuccessLine(1, 60, 0)).toBe("✓ done (1m0s / 1 tries / $0.000)");
  });

  test("cost is always 3-decimal (no scientific notation, no trailing zeros stripped)", () => {
    expect(formatSuccessLine(1, 1, 0.5)).toContain("$0.500");
    expect(formatSuccessLine(1, 1, 12.345)).toContain("$12.345");
  });
});

describe("formatFailureLine — locked contract", () => {
  test("max tries hit", () => {
    const line = formatFailureLine(10, 720, "max tries hit");
    expect(line).toBe("✗ failed (12m0s / 10 tries / max tries hit)");
    const m = FINAL_LINE.exec(line);
    expect(m?.[1]).toBe("✗ failed");
    expect(m?.[2]).toBe("12m0s");
    expect(m?.[3]).toBe("10");
    expect(m?.[4]).toBe("max tries hit");
  });

  test("timeout", () => {
    expect(formatFailureLine(3, 300, "timeout")).toBe("✗ failed (5m0s / 3 tries / timeout)");
  });

  test("cost cap hit", () => {
    expect(formatFailureLine(8, 900, "cost cap hit")).toBe("✗ failed (15m0s / 8 tries / cost cap hit)");
  });
});

describe("FINAL_LINE regex — both shapes match", () => {
  // This is the regex documented for downstream parsers. If new code paths emit
  // a final line that does NOT match, that is a contract violation.
  test("success line matches", () => {
    const line = formatSuccessLine(5, 73, 0.04);
    expect(FINAL_LINE.test(line)).toBe(true);
  });
  test("failure line matches", () => {
    const line = formatFailureLine(10, 1200, "max tries hit");
    expect(FINAL_LINE.test(line)).toBe(true);
  });
  test("non-final lines do NOT match (e.g. 'why:' / 'stuck pattern:' continuation lines)", () => {
    expect(FINAL_LINE.test("  why: agent corrected itself on try 2")).toBe(false);
    expect(FINAL_LINE.test("  stuck pattern: silent_mock_bypass")).toBe(false);
    expect(FINAL_LINE.test("▶ task accepted (verify: bun test)")).toBe(false);
  });
});

describe("symmetry between success and failure", () => {
  // Both lines share field order: (TIME / N tries / EXTRA). A single parser
  // that captures TIME / TRIES from either shape is the user-facing benefit.
  test("success and failure share the same field-order shape", () => {
    const succ = formatSuccessLine(3, 90, 0.1);
    const fail = formatFailureLine(3, 90, "timeout");
    const ms = FINAL_LINE.exec(succ);
    const mf = FINAL_LINE.exec(fail);
    expect(ms?.[2]).toBe(mf?.[2]); // same time
    expect(ms?.[3]).toBe(mf?.[3]); // same tries
    // group 4 differs by design (cost vs reason)
  });
});
