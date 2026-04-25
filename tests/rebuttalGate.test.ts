// Contract tests for parseRebuttal's consistency gate (Defect 2) and the
// hasFaultSignal heuristic.
//
// Background: in a dogfood run (2026-04-24) opus emitted verdict=refuted +
// attack_angles=[] + a reason like "The extraction is correct ... verify passes
// clean". A gate was added on the parser side to coerce this. This file is the
// regression fixture.
import { expect, test, describe } from "bun:test";
import { parseRebuttal, hasFaultSignal, type RebuttalInput } from "../src/critic/rebuttal.ts";

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
    tryIndex: 1,
    maxTries: 10,
    ...overrides,
  };
}

describe("hasFaultSignal — fault phrase detection", () => {
  test("reason containing a concrete fault → true", () => {
    expect(hasFaultSignal("The agent claimed to fix X but actually reverted Y.")).toBe(true);
    expect(hasFaultSignal("Agent failed to handle null input.")).toBe(true);
    expect(hasFaultSignal("Tests hardcoded the expected output — not a real implementation.")).toBe(true);
    expect(hasFaultSignal("Silenced a type error with @ts-ignore.")).toBe(true);
    expect(hasFaultSignal("Used .skip( to bypass the failing test.")).toBe(true);
    expect(hasFaultSignal("scope drift: refactored unrelated files")).toBe(true);
    expect(hasFaultSignal("Over-reach: agent went beyond what was asked.")).toBe(true);
  });

  test("negated fault-absence reports → false (the dogfood trap)", () => {
    // Sentences where the critic asserts "no problem". Classic false-positive case
    // for naive keyword matching.
    expect(hasFaultSignal("The extraction is correct. No cheats detected.")).toBe(false);
    expect(hasFaultSignal("verify passes clean, no forbidden files touched")).toBe(false);
    expect(hasFaultSignal("Implementation correctly addresses all test cases.")).toBe(false);
    expect(hasFaultSignal("All 194 tests pass, tsc clean.")).toBe(false);
  });

  test("empty reason → false", () => {
    expect(hasFaultSignal("")).toBe(false);
    expect(hasFaultSignal("   ")).toBe(false);
  });

  test("case-insensitive", () => {
    expect(hasFaultSignal("AGENT CLAIMED TO FIX IT")).toBe(true);
    expect(hasFaultSignal("HARDCODED test values")).toBe(true);
  });

  test("negated fault phrases (no/not/without/n't) → false", () => {
    // bench/verify-bypass dogfood (2026-04-25): honest case critic emitted
    // "Tests pass, no cheats, no scope drift" — substring "scope drift"
    // matched naively, blocking the Defect 2 coercion. Negation guard fixes this.
    expect(hasFaultSignal("Tests pass, no cheats, no scope drift")).toBe(false);
    expect(hasFaultSignal("No tests skipped, no @ts-ignore added")).toBe(false);
    expect(hasFaultSignal("The fix is correct without scope drift")).toBe(false);
    expect(hasFaultSignal("The agent didn't bypass any tests")).toBe(false);
    expect(hasFaultSignal("This change doesn't bypass tests")).toBe(false);
    expect(hasFaultSignal("no out of scope changes")).toBe(false);
    expect(hasFaultSignal("without any unauthorized edits")).toBe(false);
    expect(hasFaultSignal("free of hardcoded values")).toBe(false);
  });

  test("non-negated fault detected even alongside negated phrases", () => {
    // If the critic lists both "no X" and a real "Y", the real fault wins.
    expect(hasFaultSignal("No scope drift, but agent failed to handle null")).toBe(true);
    expect(hasFaultSignal("Tests pass cleanly, but @ts-ignore was added in src/foo.ts")).toBe(true);
  });

  test("'no' inside a different word is not treated as negation", () => {
    // "Norway" must not suppress "scope drift" detection.
    expect(hasFaultSignal("In Norway scope drift was reported")).toBe(true);
  });
});

describe("parseRebuttal — consistency gate (dogfood regression prevention)", () => {
  test("dogfood fixture: verdict=refuted + attack_angles=[] + positive reason → coerced to unable_to_refute", () => {
    // Condensed form of the real 2026-04-24 dogfood output. Opus emitted refute
    // on try 1, but the reason was fully positive and attack_angles empty (no fault).
    const r = parseRebuttal(
      {
        verdict: "refuted",
        reason:
          "The extraction is correct: CLI_INFO is unified in cliShared.ts with " +
          "`defaultBin` field name. doctor.ts correctly updated. No forbidden " +
          "files touched, no cheats detected, verify passes clean (194 tests, 0 fail).",
        attack_angles: [],
      },
      input({ tryIndex: 1, verifyOk: true }),
    );
    expect(r.verdict).toBe("unable_to_refute");
    expect(r.attack_angles).toEqual([]);
    expect(r.reason).toBe(""); // unable_to_refute neutralizes reason
  });

  test("when verify is failing, gate does not fire (real fail)", () => {
    const r = parseRebuttal(
      { verdict: "refuted", reason: "verify failed — agent's code is correct by review but bun test returned non-zero." },
      input({ verifyOk: false }),
    );
    // verify failing → first branch fixes refuted, then gate does not fire because verifyOk=false
    expect(r.verdict).toBe("refuted");
  });

  test("legitimate refute with attack_angles + evidence is unaffected by gate", () => {
    // The gate only fires when all 3 conditions hold: verify passes + attack_angles
    // empty + no fault signal in reason. A legitimate refute with attack_angles
    // present takes the existing path.
    const r = parseRebuttal(
      {
        verdict: "refuted",
        reason: "Agent failed to handle the empty string case.",
        attack_angles: ["empty string returns undefined"],
        evidence: "dogfood/roman.ts:L42 const result = map[s[0]] ?? 0;",
      },
      input({
        tryIndex: 1,
        verifyOk: true,
        diff: "dogfood/roman.ts:L42 const result = map[s[0]] ?? 0;",
      }),
    );
    expect(r.verdict).toBe("refuted");
  });

  test("gate does not fire when attack_angles >= 1", () => {
    const r = parseRebuttal(
      {
        verdict: "refuted",
        reason: "extraction looks good", // positive-ish but attack_angles present
        attack_angles: ["null input edge case not covered"],
        evidence: "line 42: early return on null",
      },
      input({
        tryIndex: 1,
        verifyOk: true,
        diff: "+ if (x === null) return;\nline 42: early return on null",
      }),
    );
    // attack_angles > 0 takes the existing refute path
    expect(r.verdict).toBe("refuted");
  });

  test("same gate fires at tryIndex=2 (verifyOk + empty attack_angles + positive reason)", () => {
    const r = parseRebuttal(
      {
        verdict: "refuted",
        reason: "Tests pass. No issues.",
        attack_angles: [],
      },
      input({ tryIndex: 2, verifyOk: true }),
    );
    // tryIndex=2 normally falls into unable_to_refute; here the gate gives the same result
    expect(r.verdict).toBe("unable_to_refute");
  });
});
