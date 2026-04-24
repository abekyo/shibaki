// 穴 7: evidence 引用一致検証のテスト
import { expect, test, describe } from "bun:test";
import { verifyEvidence, parseRebuttal, type RebuttalInput } from "../src/critic/rebuttal.ts";

describe("verifyEvidence — 穴 7", () => {
  test("haystack に丸ごと一致すれば true", () => {
    expect(verifyEvidence("AssertionError line 42", ["...AssertionError line 42..."])).toBe(true);
  });

  test("空白正規化で一致すれば true", () => {
    expect(verifyEvidence("Error   at  line  42", ["Error at line 42 something"])).toBe(true);
  });

  test("40 字以上の部分一致で true", () => {
    const hay = "long prefix... AssertionError: expected 5 to equal 10 at src/auth.test.ts:42 ...long suffix";
    const ev = "AssertionError: expected 5 to equal 10 at src/auth.test.ts:99 extra garbage";
    expect(verifyEvidence(ev, [hay])).toBe(true);
  });

  test("haystack に全く無い引用は false (幻覚扱い)", () => {
    expect(verifyEvidence("this text never appeared in any log output", ["unrelated diff content"])).toBe(false);
  });

  test("空 evidence は false", () => {
    expect(verifyEvidence("", ["anything"])).toBe(false);
    expect(verifyEvidence("   ", ["anything"])).toBe(false);
  });

  test("短すぎる文字列は部分一致にかからず、丸ごと一致のみで判定", () => {
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

describe("parseRebuttal — evidence_verified フラグ (穴 7)", () => {
  test("diff に evidence 引用があれば verified=true", () => {
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

  test("haystack に無い evidence は verified=false (幻覚)", () => {
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

  test("verify_stderr に evidence があっても verified=true", () => {
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

  test("evidence 空は verified=false", () => {
    const r = parseRebuttal({ attack_angles: ["x"] }, input());
    expect(r.evidence_verified).toBe(false);
  });
});

describe("parseRebuttal — past_rebuttals を含むシナリオ (穴 2)", () => {
  test("pastRebuttals + evidence 検証 OK → refuted (新規角度を受理)", () => {
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

  test("pastRebuttals 有りだが evidence 検証 NG → unable_to_refute (幻覚ループ阻止)", () => {
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
