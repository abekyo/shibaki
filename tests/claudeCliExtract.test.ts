// claude-cli provider の JSON 出力パーサ (extractResultText) の unit test。
// 一度 is_error throw が内側 try/catch で握りつぶされるバグがあったため、
// そのリグレッションを含めて covers する。
import { expect, test, describe } from "bun:test";
import { extractResultText } from "../src/llm/providers/claude-cli.ts";

describe("extractResultText — happy path", () => {
  test("典型的な {type:'result', result:'<text>'} から本文を取り出す", () => {
    const raw = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Hello, world.",
      session_id: "abc",
    });
    expect(extractResultText(raw)).toBe("Hello, world.");
  });

  test("空入力は空文字", () => {
    expect(extractResultText("")).toBe("");
    expect(extractResultText("   \n  ")).toBe("");
  });

  test("前後の空白は trim される", () => {
    const raw = `  ${JSON.stringify({ result: "trimmed", is_error: false })}  \n`;
    expect(extractResultText(raw)).toBe("trimmed");
  });
});

describe("extractResultText — is_error は throw する (caller が retry 判定可能)", () => {
  test("is_error:true + result に overloaded_error → throw (retry 対象になる)", () => {
    const raw = JSON.stringify({
      type: "result",
      is_error: true,
      result: "overloaded_error",
      subtype: "api_error",
    });
    expect(() => extractResultText(raw)).toThrow(/claude CLI reported error/);
    expect(() => extractResultText(raw)).toThrow(/overloaded/);
  });

  test("is_error:true で result 欠落なら subtype を使う", () => {
    const raw = JSON.stringify({
      type: "result",
      is_error: true,
      subtype: "auth_error",
    });
    expect(() => extractResultText(raw)).toThrow(/auth_error/);
  });

  test("is_error:true で result も subtype も無いなら 'unknown'", () => {
    const raw = JSON.stringify({ is_error: true });
    expect(() => extractResultText(raw)).toThrow(/unknown/);
  });

  test("回帰テスト: is_error throw が内側 try/catch で握りつぶされない", () => {
    // 旧実装では throw が JSON.parse の try/catch に捕まって trimmed JSON が
    // そのまま「model 応答」として返される事象があった。caller はそれを
    // critic 応答として parse → ゴミ verdict を critic loop に注入 → debug 困難。
    // ここは必ず throw する契約。
    const raw = JSON.stringify({ is_error: true, result: "rate_limit_exceeded" });
    let thrown = false;
    try {
      extractResultText(raw);
    } catch (e: any) {
      thrown = true;
      expect(e.message).toContain("rate_limit_exceeded");
    }
    expect(thrown).toBe(true);
  });
});

describe("extractResultText — JSON 不成立 / 形式違い", () => {
  test("非 JSON は raw を返す", () => {
    expect(extractResultText("just plain text from model")).toBe("just plain text from model");
  });

  test("壊れた JSON は raw を返す", () => {
    expect(extractResultText("{broken")).toBe("{broken");
  });

  test("primitive JSON (数値) は raw を返す", () => {
    expect(extractResultText("42")).toBe("42");
  });

  test("object で result 欠落 + is_error も無ければ raw を返す", () => {
    const raw = JSON.stringify({ type: "result", session_id: "abc" });
    expect(extractResultText(raw)).toBe(raw);
  });
});

describe("extractResultText — array (stream-json) フォーマット", () => {
  test("assistant / result 要素のテキストを concat", () => {
    const raw = JSON.stringify([
      { type: "system", payload: "ignored" },
      { type: "assistant", text: "first " },
      { type: "assistant", text: "second" },
      { type: "result", result: " (end)" },
    ]);
    expect(extractResultText(raw)).toBe("first second (end)");
  });

  test("空配列は raw を返す", () => {
    expect(extractResultText("[]")).toBe("[]");
  });

  test("空相当 (text / result が全部空) の配列は raw を返す", () => {
    const raw = JSON.stringify([{ type: "assistant", text: "" }]);
    expect(extractResultText(raw)).toBe(raw);
  });

  test("Array.isArray は Object 分岐より先に判定 (is_error が紛れ込まない)", () => {
    // 配列の要素に is_error:true を含めても、object の is_error 判定には流れないはず
    const raw = JSON.stringify([
      { type: "assistant", text: "hello", is_error: true },
    ]);
    expect(extractResultText(raw)).toBe("hello");
  });
});
