// Unit tests for the claude-cli provider's JSON output parser (extractResultText).
// Previously there was a bug where the is_error throw was swallowed by the inner
// try/catch, so this also covers the regression case.
import { expect, test, describe } from "bun:test";
import { extractResultText } from "../src/llm/providers/claude-cli.ts";

describe("extractResultText — happy path", () => {
  test("extracts body from typical {type:'result', result:'<text>'}", () => {
    const raw = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Hello, world.",
      session_id: "abc",
    });
    expect(extractResultText(raw)).toBe("Hello, world.");
  });

  test("empty input → empty string", () => {
    expect(extractResultText("")).toBe("");
    expect(extractResultText("   \n  ")).toBe("");
  });

  test("leading/trailing whitespace is trimmed", () => {
    const raw = `  ${JSON.stringify({ result: "trimmed", is_error: false })}  \n`;
    expect(extractResultText(raw)).toBe("trimmed");
  });
});

describe("extractResultText — is_error throws (caller can decide retry)", () => {
  test("is_error:true + result=overloaded_error → throw (becomes retry candidate)", () => {
    const raw = JSON.stringify({
      type: "result",
      is_error: true,
      result: "overloaded_error",
      subtype: "api_error",
    });
    expect(() => extractResultText(raw)).toThrow(/claude CLI reported error/);
    expect(() => extractResultText(raw)).toThrow(/overloaded/);
  });

  test("is_error:true with missing result uses subtype", () => {
    const raw = JSON.stringify({
      type: "result",
      is_error: true,
      subtype: "auth_error",
    });
    expect(() => extractResultText(raw)).toThrow(/auth_error/);
  });

  test("is_error:true with neither result nor subtype → 'unknown'", () => {
    const raw = JSON.stringify({ is_error: true });
    expect(() => extractResultText(raw)).toThrow(/unknown/);
  });

  test("regression: is_error throw is not swallowed by inner try/catch", () => {
    // In the old implementation the throw was caught by the JSON.parse try/catch
    // and the trimmed JSON was returned as the "model response". The caller then
    // parsed it as a critic response → injected garbage verdicts into the critic
    // loop → hard to debug. This contract must always throw.
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

describe("extractResultText — non-JSON / wrong shape", () => {
  test("non-JSON returns raw", () => {
    expect(extractResultText("just plain text from model")).toBe("just plain text from model");
  });

  test("broken JSON returns raw", () => {
    expect(extractResultText("{broken")).toBe("{broken");
  });

  test("primitive JSON (number) returns raw", () => {
    expect(extractResultText("42")).toBe("42");
  });

  test("object missing result + no is_error returns raw", () => {
    const raw = JSON.stringify({ type: "result", session_id: "abc" });
    expect(extractResultText(raw)).toBe(raw);
  });
});

describe("extractResultText — array (stream-json) format", () => {
  test("concatenates text from assistant / result elements", () => {
    const raw = JSON.stringify([
      { type: "system", payload: "ignored" },
      { type: "assistant", text: "first " },
      { type: "assistant", text: "second" },
      { type: "result", result: " (end)" },
    ]);
    expect(extractResultText(raw)).toBe("first second (end)");
  });

  test("empty array returns raw", () => {
    expect(extractResultText("[]")).toBe("[]");
  });

  test("effectively-empty array (all text/result empty) returns raw", () => {
    const raw = JSON.stringify([{ type: "assistant", text: "" }]);
    expect(extractResultText(raw)).toBe(raw);
  });

  test("Array.isArray check runs before object branch (is_error does not leak)", () => {
    // Even if an array element contains is_error:true, it must not flow into the object is_error branch
    const raw = JSON.stringify([
      { type: "assistant", text: "hello", is_error: true },
    ]);
    expect(extractResultText(raw)).toBe("hello");
  });
});
