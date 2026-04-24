// parseRebuttal の契約テスト。
// critic プロンプト設計の「辛辣さ + 検証可能性」を担保する 5 修正を固定する。
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

describe("parseRebuttal — 機械的判定ルール (穴 4)", () => {
  test("attack_angles が 1 本以上 + evidence 検証 OK → refuted", () => {
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

  test("attack_angles 有り + evidence 検証 NG + tryIndex>=2 → unable_to_refute (幻覚抑止)", () => {
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

  test("tryIndex=1 なら evidence 無くても refuted (1 試行目は仕切り直し)", () => {
    const r = parseRebuttal(
      { attack_angles: ["浅くても出す"], evidence: "" },
      input({ tryIndex: 1 }),
    );
    expect(r.verdict).toBe("refuted");
  });

  test("attack_angles=0 かつ verify.ok かつ tryIndex>=2 → unable_to_refute", () => {
    const r = parseRebuttal(
      { verdict: "unable_to_refute", attack_angles: [] },
      input({ tryIndex: 2 }),
    );
    expect(r.verdict).toBe("unable_to_refute");
  });

  test("verify.ok=false は verdict 問わず refuted 固定", () => {
    const r = parseRebuttal(
      { verdict: "unable_to_refute", attack_angles: [] },
      input({ verifyOk: false, verifyExitCode: 1, tryIndex: 5 }),
    );
    expect(r.verdict).toBe("refuted");
  });
});

describe("parseRebuttal — 1 試行目 unable_to_refute 禁止 (穴 1, Defect 2 gate と併走)", () => {
  // 穴 1 の原意: tryIndex=1 で opus が早々に unable_to_refute を返すのを塞ぐ。
  // Defect 2 の consistency gate 導入後、「reason に具体的な fault 指摘がある」なら
  // 引き続き refute 強制。逆に「reason が空 / positive」なら gate が
  // unable_to_refute に矯正する (中身の無い refute は出さない)。
  test("tryIndex=1 + attack_angles=0 + reason に fault signal → refuted 強制 (穴 1)", () => {
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

  test("tryIndex=1 + attack_angles=0 + reason 空/positive → Defect 2 gate が unable_to_refute に矯正", () => {
    const r = parseRebuttal(
      { verdict: "unable_to_refute", attack_angles: [] },
      input({ tryIndex: 1 }),
    );
    expect(r.verdict).toBe("unable_to_refute");
  });

  test("tryIndex=2 以降は attack_angles=0 なら unable_to_refute 通す", () => {
    const r = parseRebuttal(
      { verdict: "unable_to_refute", attack_angles: [] },
      input({ tryIndex: 2 }),
    );
    expect(r.verdict).toBe("unable_to_refute");
  });
});

describe("parseRebuttal — kind enum (穴 5)", () => {
  test("code_inspection は削除済、none に落とす", () => {
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

  test("failing_test / input_case / verify_bypass は許可 (refuted かつ evidence 検証 OK)", () => {
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

  test("none は attack_angles 0 本のときのみ (unable_to_refute 時)", () => {
    const r = parseRebuttal(
      { attack_angles: [], counter_example: { kind: "none", content: "" } },
      input({ tryIndex: 3 }),
    );
    expect(r.counter_example.kind).toBe("none");
  });

  test("unable_to_refute のとき kind は none に強制 (矛盾排除)", () => {
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

describe("parseRebuttal — preempt_hint 構造化 (穴 8)", () => {
  // preempt_hint は refuted 時にのみ残る (穴 B: unable_to_refute 時は中立化)
  // なので以下のテストは evidence 検証 OK の状況 (= refuted で定着) を用意する
  const refutedCtx = {
    tryIndex: 2,
    verifyStderr: "FAIL\n  AssertionError at line 99",
  } satisfies Partial<RebuttalInput>;
  const refutedEvidence = { evidence: "AssertionError at line 99" };

  test("object 形式は pattern_name/description をそのまま受ける", () => {
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

  test("snake_case でない pattern_name は強制変換", () => {
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

  test("旧形式 string でも破綻しない (先頭 snake_case 抽出)", () => {
    const r = parseRebuttal(
      { attack_angles: ["x"], ...refutedEvidence, preempt_hint: "ts_ignore_cover: @ts-ignore で隠した" },
      input(refutedCtx),
    );
    expect(r.preempt_hint.pattern_name).toBe("ts_ignore_cover");
    expect(r.preempt_hint.description).toContain("@ts-ignore");
  });

  test("欠落時は pattern_name='unknown' (refuted で preempt_hint が残るとき)", () => {
    const r = parseRebuttal(
      { attack_angles: ["x"], ...refutedEvidence },
      input(refutedCtx),
    );
    expect(r.preempt_hint.pattern_name).toBe("unknown");
  });

  test("unable_to_refute のときは preempt_hint が中立化される (穴 B)", () => {
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

describe("parseRebuttal — attack_angles の上限", () => {
  test("最大 3 本でクランプ (evidence 検証済なら refuted で保持)", () => {
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
  test("verdict=refuted + insight.kind=confirmation は insight を none に demote", () => {
    // dogfood で観測した実例: critic が comment 修正を refute しつつ
    // "agent correctly fixed off-by-one errors" を confirmation として併記した。
    // gate が発火して insight が剥がれる挙動を固定する。
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
        tryIndex: 1, // try 1 で attack_angles 有り → refuted
      }),
    );
    expect(r.verdict).toBe("refuted");
    expect(r.insight.kind).toBe("none");
    expect(r.insight.content).toBe("");
  });

  test("verdict=refuted + insight.kind=root_cause は demote しない (矛盾してないので保持)", () => {
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

  test("verdict=unable_to_refute + insight.kind=confirmation は保持 (健全な組み合わせ)", () => {
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
