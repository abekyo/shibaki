// Auto-fallback 判断ロジックの unit test (pure 関数のみ)。
// Async wrapper (which claude) は実 PATH 状態に依存するので smoke テストでカバー。
import { expect, test, describe } from "bun:test";
import { decideFallback } from "../src/cli/autoFallback.ts";

describe("decideFallback — fire する条件", () => {
  test("key 無し + claude あり (default main=anthropic): fallback 発動", () => {
    const d = decideFallback({}, true);
    expect(d.apply).toBe(true);
    expect(d.provider).toBe("anthropic-cli");
    expect(d.message).toContain("Plan mode");
    expect(d.reason).toContain("OPENAI_API_KEY"); // default critic=openai
  });

  test("main=openai, OPENAI の key 無し + claude あり: fallback 発動 (default critic=anthropic だが ANTHROPIC key 無し)", () => {
    const d = decideFallback({ LLM_PROVIDER: "openai" }, true);
    expect(d.apply).toBe(true);
    expect(d.reason).toContain("ANTHROPIC_API_KEY");
  });
});

describe("decideFallback — no-op の条件", () => {
  test("LLM_PROVIDER_CRITICAL 明示 (API): fallback 抑止", () => {
    const d = decideFallback({ LLM_PROVIDER_CRITICAL: "gemini" }, true);
    expect(d.apply).toBe(false);
  });
  test("LLM_PROVIDER_CRITICAL 明示 (CLI): fallback 抑止", () => {
    const d = decideFallback({ LLM_PROVIDER_CRITICAL: "codex-cli" }, true);
    expect(d.apply).toBe(false);
  });
  test("claude 無し: fallback 抑止 (fallback 先が無い)", () => {
    const d = decideFallback({}, false);
    expect(d.apply).toBe(false);
  });
  test("default critic の key あり (OPENAI): fallback 抑止", () => {
    const d = decideFallback({ OPENAI_API_KEY: "sk-aaaaaaaa" }, true);
    expect(d.apply).toBe(false);
  });
  test("main=openai + ANTHROPIC key あり: fallback 抑止 (default critic=anthropic で API mode で動ける)", () => {
    const d = decideFallback(
      { LLM_PROVIDER: "openai", ANTHROPIC_API_KEY: "sk-ant-aaaaaaaa" },
      true,
    );
    expect(d.apply).toBe(false);
  });
  test("無関係 key (main=anthropic default, GEMINI key あり) + claude あり: fallback は抑止しない", () => {
    // default critic = openai。OPENAI_API_KEY は無いので Plan mode の方が zero friction。
    // ただし Gemini key もあるので、fallback するか hint を出すかは設計判断。
    // 現仕様: "default critic の key" が無ければ fire するので、ここでは fire する。
    const d = decideFallback({ GEMINI_API_KEY: "AIzaaaaaaaa" }, true);
    expect(d.apply).toBe(true);
  });
  test("key の中身が 7 文字未満なら key 無し扱い: fallback 発動", () => {
    const d = decideFallback({ OPENAI_API_KEY: "sk-aa" }, true);
    expect(d.apply).toBe(true);
  });
  test("LLM_PROVIDER_CRITICAL が空白のみ: 明示扱いしない (fallback 可能)", () => {
    const d = decideFallback({ LLM_PROVIDER_CRITICAL: "   " }, true);
    expect(d.apply).toBe(true);
  });
});

describe("decideFallback — メッセージ整形", () => {
  test("message に override hint を含む", () => {
    const d = decideFallback({}, true);
    expect(d.message).toContain("export LLM_PROVIDER_CRITICAL=");
  });
  test("message に model tier 言及を含む", () => {
    const d = decideFallback({}, true);
    expect(d.message).toContain("sonnet");
    expect(d.message).toContain("opus");
  });
});
