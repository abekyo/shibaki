// insight フィールド (モード B: 気づき) のテスト
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

describe("insight (モード B: 気づき)", () => {
  test("refuted 時の root_cause insight は保持", () => {
    const r = parseRebuttal(
      {
        attack_angles: ["x"],
        evidence: "cited",
        insight: {
          kind: "root_cause",
          content: "症状は off-by-one だが根本は境界値定義の矛盾",
        },
      },
      input({ verifyStderr: "... cited ..." }),
    );
    expect(r.insight.kind).toBe("root_cause");
    expect(r.insight.content).toContain("境界値定義");
  });

  test("unable_to_refute 時の confirmation insight も保持される (正しい時の肯定)", () => {
    const r = parseRebuttal(
      {
        attack_angles: [],
        insight: {
          kind: "confirmation",
          content: "i<=n への修正は正しい。factorial の定義から n を含める",
        },
      },
      input({ tryIndex: 3 }),
    );
    expect(r.verdict).toBe("unable_to_refute");
    expect(r.insight.kind).toBe("confirmation");
    expect(r.insight.content).toContain("正しい");
  });

  test("insight.kind が不正値なら none に落とす", () => {
    const r = parseRebuttal(
      {
        attack_angles: [],
        insight: { kind: "random_nonsense", content: "何か" },
      },
      input({ tryIndex: 3 }),
    );
    expect(r.insight.kind).toBe("none");
    expect(r.insight.content).toBe("何か");
  });

  test("insight が欠落なら kind=none, content=''", () => {
    const r = parseRebuttal({ attack_angles: [] }, input({ tryIndex: 3 }));
    expect(r.insight.kind).toBe("none");
    expect(r.insight.content).toBe("");
  });

  test("旧形式 string は content として吸収 (kind=none)", () => {
    const r = parseRebuttal(
      { attack_angles: [], insight: "ループ不変条件を先に書けばこのバグは消える" },
      input({ tryIndex: 3 }),
    );
    expect(r.insight.kind).toBe("none");
    expect(r.insight.content).toContain("ループ不変条件");
  });

  test("content が空のときは kind も none に強制", () => {
    const r = parseRebuttal(
      { attack_angles: [], insight: { kind: "pattern", content: "" } },
      input({ tryIndex: 3 }),
    );
    expect(r.insight.kind).toBe("none");
    expect(r.insight.content).toBe("");
  });
});
