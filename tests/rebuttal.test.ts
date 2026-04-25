// Contract tests for parseRebuttal.
// Locks in the 5 fixes that ensure the critic prompt design's "sharpness + verifiability".
import { expect, test, describe } from "bun:test";
import { parseRebuttal, type RebuttalInput } from "../src/critic/rebuttal.ts";

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

describe("parseRebuttal — mechanical verdict rules (Gap 4)", () => {
  test("attack_angles >= 1 with verified evidence → refuted", () => {
    const r = parseRebuttal(
      {
        verdict: "unable_to_refute",
        attack_angles: ["null 入力で落ちる"],
        evidence: "AssertionError at line 42",
      },
      input({ verifyStderr: "FAIL\n  AssertionError at line 42 in auth" }),
    );
    expect(r.verdict).toBe("refuted");
  });

  test("attack_angles present + evidence not verified + tryIndex>=2 → unable_to_refute (suppress hallucination)", () => {
    const r = parseRebuttal(
      {
        verdict: "refuted",
        attack_angles: ["何となく怪しい"],
        evidence: "存在しない引用テキスト",
      },
      input({ tryIndex: 3 }),
    );
    expect(r.verdict).toBe("unable_to_refute");
    expect(r.attack_angles).toEqual([]);
  });

  test("tryIndex=1: refuted even without evidence (try 1 is a clean restart)", () => {
    const r = parseRebuttal(
      { attack_angles: ["浅くても出す"], evidence: "" },
      input({ tryIndex: 1 }),
    );
    expect(r.verdict).toBe("refuted");
  });

  test("attack_angles=0 + verify.ok + tryIndex>=2 → unable_to_refute", () => {
    const r = parseRebuttal(
      { verdict: "unable_to_refute", attack_angles: [] },
      input({ tryIndex: 2 }),
    );
    expect(r.verdict).toBe("unable_to_refute");
  });

  test("verify.ok=false forces refuted regardless of verdict", () => {
    const r = parseRebuttal(
      { verdict: "unable_to_refute", attack_angles: [] },
      input({ verifyOk: false, verifyExitCode: 1, tryIndex: 5 }),
    );
    expect(r.verdict).toBe("refuted");
  });
});

describe("parseRebuttal — try 1 unable_to_refute forbidden (Gap 1, runs alongside Defect 2 gate)", () => {
  // Gap 1 intent: prevent opus from returning unable_to_refute too early at tryIndex=1.
  // After Defect 2's consistency gate, "reason contains a concrete fault" still forces
  // refute. Conversely, "reason is empty / positive" triggers the gate to coerce to
  // unable_to_refute (so we don't emit empty-shell refutes).
  test("tryIndex=1 + attack_angles=0 + reason has fault signal → forced refuted (Gap 1)", () => {
    const r = parseRebuttal(
      {
        verdict: "unable_to_refute",
        attack_angles: [],
        reason: "Agent failed to cover the empty-string case.",
      },
      input({ tryIndex: 1 }),
    );
    expect(r.verdict).toBe("refuted");
  });

  test("tryIndex=1 + attack_angles=0 + reason empty/positive → Defect 2 gate coerces to unable_to_refute", () => {
    const r = parseRebuttal(
      { verdict: "unable_to_refute", attack_angles: [] },
      input({ tryIndex: 1 }),
    );
    expect(r.verdict).toBe("unable_to_refute");
  });

  test("tryIndex>=2 with attack_angles=0 passes through as unable_to_refute", () => {
    const r = parseRebuttal(
      { verdict: "unable_to_refute", attack_angles: [] },
      input({ tryIndex: 2 }),
    );
    expect(r.verdict).toBe("unable_to_refute");
  });
});

describe("parseRebuttal — kind enum (Gap 5)", () => {
  test("code_inspection is removed, falls back to none", () => {
    const r = parseRebuttal(
      {
        verdict: "refuted",
        attack_angles: ["x"],
        counter_example: { kind: "code_inspection", content: "怪しい" },
      },
      input(),
    );
    expect(r.counter_example.kind).toBe("none");
  });

  test("failing_test / input_case / verify_bypass are allowed (refuted with verified evidence)", () => {
    for (const k of ["failing_test", "input_case", "verify_bypass"] as const) {
      const r = parseRebuttal(
        {
          verdict: "refuted",
          attack_angles: ["x"],
          counter_example: { kind: k, content: "c" },
          evidence: "evidence match in haystack",
        },
        input({ verifyStderr: "...evidence match in haystack..." }),
      );
      expect(r.verdict).toBe("refuted");
      expect(r.counter_example.kind).toBe(k);
    }
  });

  test("none only when attack_angles is empty (unable_to_refute case)", () => {
    const r = parseRebuttal(
      { attack_angles: [], counter_example: { kind: "none", content: "" } },
      input({ tryIndex: 3 }),
    );
    expect(r.counter_example.kind).toBe("none");
  });

  test("when unable_to_refute, kind is forced to none (contradiction removal)", () => {
    const r = parseRebuttal(
      {
        verdict: "unable_to_refute",
        attack_angles: [],
        counter_example: { kind: "failing_test", content: "残骸" },
      },
      input({ tryIndex: 3 }),
    );
    expect(r.verdict).toBe("unable_to_refute");
    expect(r.counter_example.kind).toBe("none");
  });
});

describe("parseRebuttal — preempt_hint structuring (Gap 8)", () => {
  // preempt_hint is kept only when refuted (Gap B: neutralized when unable_to_refute).
  // So the following tests set up a verified-evidence scenario (= sticks as refuted).
  const refutedCtx = {
    tryIndex: 2,
    verifyStderr: "FAIL\n  AssertionError at line 99",
  } satisfies Partial<RebuttalInput>;
  const refutedEvidence = { evidence: "AssertionError at line 99" };

  test("object form passes through pattern_name/description as-is", () => {
    const r = parseRebuttal(
      {
        attack_angles: ["x"],
        ...refutedEvidence,
        preempt_hint: { pattern_name: "silent_mock_bypass", description: "mock で挙動回避" },
      },
      input(refutedCtx),
    );
    expect(r.verdict).toBe("refuted");
    expect(r.preempt_hint.pattern_name).toBe("silent_mock_bypass");
    expect(r.preempt_hint.description).toBe("mock で挙動回避");
  });

  test("non-snake_case pattern_name is coerced", () => {
    const r = parseRebuttal(
      {
        attack_angles: ["x"],
        ...refutedEvidence,
        preempt_hint: { pattern_name: "Silent Mock Bypass!!", description: "" },
      },
      input(refutedCtx),
    );
    expect(r.preempt_hint.pattern_name).toBe("silent_mock_bypass");
  });

  test("legacy string form does not break (extract leading snake_case)", () => {
    const r = parseRebuttal(
      { attack_angles: ["x"], ...refutedEvidence, preempt_hint: "ts_ignore_cover: @ts-ignore で隠した" },
      input(refutedCtx),
    );
    expect(r.preempt_hint.pattern_name).toBe("ts_ignore_cover");
    expect(r.preempt_hint.description).toContain("@ts-ignore");
  });

  test("missing pattern_name defaults to 'unknown' (when preempt_hint survives via refuted)", () => {
    const r = parseRebuttal(
      { attack_angles: ["x"], ...refutedEvidence },
      input(refutedCtx),
    );
    expect(r.preempt_hint.pattern_name).toBe("unknown");
  });

  test("when unable_to_refute, preempt_hint is neutralized (Gap B)", () => {
    const r = parseRebuttal(
      {
        attack_angles: [],
        preempt_hint: { pattern_name: "speculative_concern", description: "テスト外の懸念" },
      },
      input({ tryIndex: 3 }),
    );
    expect(r.verdict).toBe("unable_to_refute");
    expect(r.preempt_hint.pattern_name).toBe("");
    expect(r.preempt_hint.description).toBe("");
    expect(r.reason).toBe("");
  });
});

describe("parseRebuttal — attack_angles cap", () => {
  test("clamps at max 3 (kept as refuted when evidence is verified)", () => {
    const r = parseRebuttal(
      {
        attack_angles: ["a", "b", "c", "d", "e"],
        evidence: "cited line",
      },
      input({ verifyStderr: "something cited line something" }),
    );
    expect(r.attack_angles.length).toBe(3);
    expect(r.verdict).toBe("refuted");
  });
});

describe("parseRebuttal — Defect 1: verdict/insight self-contradiction gate", () => {
  test("verdict=refuted + insight.kind=confirmation demotes insight to none", () => {
    // Real case observed in dogfood: critic refuted a comment fix yet listed
    // "agent correctly fixed off-by-one errors" as confirmation alongside.
    // Locks in the gate-firing behavior that strips the insight.
    const r = parseRebuttal(
      {
        attack_angles: ["unauthorized_modification"],
        evidence: "dogfood/mathTarget.ts:L1-L2\nsome cited diff",
        insight: {
          kind: "confirmation",
          content: "The agent correctly fixed the off-by-one errors",
        },
      },
      input({
        verifyStderr: "dogfood/mathTarget.ts:L1-L2\nsome cited diff",
        tryIndex: 1, // try 1 with attack_angles → refuted
      }),
    );
    expect(r.verdict).toBe("refuted");
    expect(r.insight.kind).toBe("none");
    expect(r.insight.content).toBe("");
  });

  test("verdict=refuted + insight.kind=root_cause is not demoted (no contradiction → keep)", () => {
    const r = parseRebuttal(
      {
        attack_angles: ["a"],
        evidence: "cited line",
        insight: { kind: "root_cause", content: "agent only fixed the symptom" },
      },
      input({ verifyStderr: "something cited line something", tryIndex: 1 }),
    );
    expect(r.verdict).toBe("refuted");
    expect(r.insight.kind).toBe("root_cause");
    expect(r.insight.content).toBe("agent only fixed the symptom");
  });

  test("verdict=unable_to_refute + insight.kind=confirmation is kept (healthy combo)", () => {
    const r = parseRebuttal(
      {
        attack_angles: [],
        insight: { kind: "confirmation", content: "i<=n is correct" },
      },
      input({ tryIndex: 2 }),
    );
    expect(r.verdict).toBe("unable_to_refute");
    expect(r.insight.kind).toBe("confirmation");
    expect(r.insight.content).toBe("i<=n is correct");
  });
});
