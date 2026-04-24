// parseRebuttal の consistency gate (Defect 2) と hasFaultSignal heuristic の
// 契約テスト。
//
// 背景: dogfood run (2026-04-24) で opus が verdict=refuted + attack_angles=[] +
// "The extraction is correct ... verify passes clean" な reason を emit した。
// これを parser 側で矯正する gate を入れた。ここは回帰 fixture。
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

describe("hasFaultSignal — fault phrase 検出", () => {
  test("具体的な fault 指摘を含む reason は true", () => {
    expect(hasFaultSignal("The agent claimed to fix X but actually reverted Y.")).toBe(true);
    expect(hasFaultSignal("Agent failed to handle null input.")).toBe(true);
    expect(hasFaultSignal("Tests hardcoded the expected output — not a real implementation.")).toBe(true);
    expect(hasFaultSignal("Silenced a type error with @ts-ignore.")).toBe(true);
    expect(hasFaultSignal("Used .skip( to bypass the failing test.")).toBe(true);
    expect(hasFaultSignal("scope drift: refactored unrelated files")).toBe(true);
    expect(hasFaultSignal("Over-reach: agent went beyond what was asked.")).toBe(true);
  });

  test("否定形 fault 不在報告は false (dogfood の罠)", () => {
    // critic が「問題なし」を表明している文。単純な keyword match だと false-positive
    // してしまう典型ケース。
    expect(hasFaultSignal("The extraction is correct. No cheats detected.")).toBe(false);
    expect(hasFaultSignal("verify passes clean, no forbidden files touched")).toBe(false);
    expect(hasFaultSignal("Implementation correctly addresses all test cases.")).toBe(false);
    expect(hasFaultSignal("All 194 tests pass, tsc clean.")).toBe(false);
  });

  test("空 reason は false", () => {
    expect(hasFaultSignal("")).toBe(false);
    expect(hasFaultSignal("   ")).toBe(false);
  });

  test("大文字小文字を区別しない", () => {
    expect(hasFaultSignal("AGENT CLAIMED TO FIX IT")).toBe(true);
    expect(hasFaultSignal("HARDCODED test values")).toBe(true);
  });
});

describe("parseRebuttal — consistency gate (dogfood 再発防止)", () => {
  test("dogfood fixture: verdict=refuted + attack_angles=[] + positive reason → unable_to_refute に矯正", () => {
    // 実際の 2026-04-24 dogfood output を縮約した形。opus が try 1 に refute を
    // emit したが reason は完全に positive、attack_angles は空 (または fault なし)。
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
    expect(r.reason).toBe(""); // unable_to_refute なら reason は中立化される
  });

  test("verify 落ちてる場合は gate 発動しない (本物の fail)", () => {
    const r = parseRebuttal(
      { verdict: "refuted", reason: "verify failed — agent's code is correct by review but bun test returned non-zero." },
      input({ verifyOk: false }),
    );
    // verify 落ちてるので最初の分岐で refuted 確定、その後 gate は verifyOk=false なので発火しない
    expect(r.verdict).toBe("refuted");
  });

  test("attack_angles + evidence あり の正当 refute は gate 影響なし", () => {
    // gate は「verify 通過 + attack_angles 空 + reason に fault signal 無し」の 3 条件
    // 全て揃って初めて発動する。attack_angles が入ってる正当 refute は既存の経路を通る。
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

  test("attack_angles が 1 本以上あれば gate は発動しない", () => {
    const r = parseRebuttal(
      {
        verdict: "refuted",
        reason: "extraction looks good", // positive-ish だが attack_angles あり
        attack_angles: ["null input edge case not covered"],
        evidence: "line 42: early return on null",
      },
      input({
        tryIndex: 1,
        verifyOk: true,
        diff: "+ if (x === null) return;\nline 42: early return on null",
      }),
    );
    // attack_angles > 0 で既存の refute 経路を通る
    expect(r.verdict).toBe("refuted");
  });

  test("tryIndex=2 でも同じ gate が効く (verifyOk + 空 attack_angles + positive reason)", () => {
    const r = parseRebuttal(
      {
        verdict: "refuted",
        reason: "Tests pass. No issues.",
        attack_angles: [],
      },
      input({ tryIndex: 2, verifyOk: true }),
    );
    // tryIndex=2 は通常 unable_to_refute 側に落ちるが、ここでは gate が効いても同じ結果になる
    expect(r.verdict).toBe("unable_to_refute");
  });
});
