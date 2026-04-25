// Gap 7: tests for evidence quote-match verification
import { expect, test, describe } from "bun:test";
import { verifyEvidence, parseRebuttal, type RebuttalInput } from "../src/critic/rebuttal.ts";

describe("verifyEvidence — Gap 7", () => {
  test("full match in haystack → true", () => {
    expect(verifyEvidence("AssertionError line 42", ["...AssertionError line 42..."])).toBe(true);
  });

  test("matches under whitespace normalization → true", () => {
    expect(verifyEvidence("Error   at  line  42", ["Error at line 42 something"])).toBe(true);
  });

  test("partial match >= 40 chars → true", () => {
    const hay = "long prefix... AssertionError: expected 5 to equal 10 at src/auth.test.ts:42 ...long suffix";
    const ev = "AssertionError: expected 5 to equal 10 at src/auth.test.ts:99 extra garbage";
    expect(verifyEvidence(ev, [hay])).toBe(true);
  });

  test("quote not present anywhere in haystack → false (treat as hallucination)", () => {
    expect(verifyEvidence("this text never appeared in any log output", ["unrelated diff content"])).toBe(false);
  });

  test("empty evidence → false", () => {
    expect(verifyEvidence("", ["anything"])).toBe(false);
    expect(verifyEvidence("   ", ["anything"])).toBe(false);
  });

  test("strings too short skip partial match and use full match only", () => {
    expect(verifyEvidence("xyz", ["abc"])).toBe(false);
    expect(verifyEvidence("xyz", ["xyz content"])).toBe(true);
  });
});

function input(overrides: Partial<RebuttalInput> = {}): RebuttalInput {
  return {
    task: "x",
    verifyCmd: "bun test",
    verifyOk: true,
    verifyExitCode: 0,
    verifyStdout: "",
    verifyStderr: "",
    agentStdout: "",
    diff: "",
    tryIndex: 2,
    maxTries: 10,
    ...overrides,
  };
}

describe("parseRebuttal — evidence_verified flag (Gap 7)", () => {
  test("evidence quote in diff → verified=true", () => {
    const diff = "+ const x = 1;\n+ // @ts-ignore\n+ const y: number = foo();";
    const r = parseRebuttal(
      {
        attack_angles: ["x"],
        counter_example: { kind: "verify_bypass", content: "c" },
        evidence: "// @ts-ignore",
      },
      input({ diff }),
    );
    expect(r.evidence_verified).toBe(true);
  });

  test("evidence absent from haystack → verified=false (hallucination)", () => {
    const r = parseRebuttal(
      {
        attack_angles: ["x"],
        counter_example: { kind: "failing_test", content: "c" },
        evidence: "this phrase definitely does not appear anywhere in any log",
      },
      input({ diff: "+ const x = 1;" }),
    );
    expect(r.evidence_verified).toBe(false);
  });

  test("evidence in verify_stderr also → verified=true", () => {
    const r = parseRebuttal(
      {
        attack_angles: ["x"],
        evidence: "AssertionError: expected 5",
      },
      input({
        verifyStderr: "FAIL auth.test.ts\n  AssertionError: expected 5 to equal 10",
      }),
    );
    expect(r.evidence_verified).toBe(true);
  });

  test("empty evidence → verified=false", () => {
    const r = parseRebuttal({ attack_angles: ["x"] }, input());
    expect(r.evidence_verified).toBe(false);
  });
});

describe("parseRebuttal — scenarios with past_rebuttals (Gap 2)", () => {
  test("pastRebuttals + verified evidence → refuted (accept new angle)", () => {
    const r = parseRebuttal(
      {
        attack_angles: ["新しい角度"],
        counter_example: { kind: "input_case", content: '{"x": null}' },
        evidence: "TypeError: cannot read property",
      },
      input({
        tryIndex: 3,
        verifyStderr: "FAIL\n  TypeError: cannot read property of null",
        pastRebuttals: [
          {
            tryIndex: 1,
            reason: "前回の指摘",
            attack_angles: ["前の角度1"],
            preempt_hint: { pattern_name: "silent_mock_bypass", description: "mock で逃げた" },
          },
        ],
      }),
    );
    expect(r.verdict).toBe("refuted");
    expect(r.attack_angles).toEqual(["新しい角度"]);
  });

  test("pastRebuttals present but evidence not verified → unable_to_refute (block hallucination loop)", () => {
    const r = parseRebuttal(
      {
        attack_angles: ["また新しい捏造"],
        evidence: "haystack に無い想像",
      },
      input({
        tryIndex: 3,
        verifyOk: true,
        pastRebuttals: [
          {
            tryIndex: 1,
            reason: "前の指摘",
            attack_angles: ["前の角度"],
            preempt_hint: { pattern_name: "fabricated_concern", description: "" },
          },
        ],
      }),
    );
    expect(r.verdict).toBe("unable_to_refute");
  });
});
