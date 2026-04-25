// Unit tests for the auto-fallback decision logic (pure function only).
// The async wrapper (which claude) depends on real PATH state so it is covered by smoke tests.
import { expect, test, describe } from "bun:test";
import { decideFallback } from "../src/cli/autoFallback.ts";

describe("decideFallback — conditions that fire", () => {
  test("no key + claude present (default main=anthropic): fallback fires", () => {
    const d = decideFallback({}, true);
    expect(d.apply).toBe(true);
    expect(d.provider).toBe("anthropic-cli");
    expect(d.message).toContain("Plan mode");
    expect(d.reason).toContain("OPENAI_API_KEY"); // default critic=openai
  });

  test("main=openai, no OPENAI key + claude present: fallback fires (default critic=anthropic but no ANTHROPIC key)", () => {
    const d = decideFallback({ LLM_PROVIDER: "openai" }, true);
    expect(d.apply).toBe(true);
    expect(d.reason).toContain("ANTHROPIC_API_KEY");
  });
});

describe("decideFallback — no-op conditions", () => {
  test("LLM_PROVIDER_CRITICAL explicit (API): fallback suppressed", () => {
    const d = decideFallback({ LLM_PROVIDER_CRITICAL: "gemini" }, true);
    expect(d.apply).toBe(false);
  });
  test("LLM_PROVIDER_CRITICAL explicit (CLI): fallback suppressed", () => {
    const d = decideFallback({ LLM_PROVIDER_CRITICAL: "codex-cli" }, true);
    expect(d.apply).toBe(false);
  });
  test("no claude: fallback suppressed (no fallback target)", () => {
    const d = decideFallback({}, false);
    expect(d.apply).toBe(false);
  });
  test("default critic key present (OPENAI): fallback suppressed", () => {
    const d = decideFallback({ OPENAI_API_KEY: "sk-aaaaaaaa" }, true);
    expect(d.apply).toBe(false);
  });
  test("main=openai + ANTHROPIC key present: fallback suppressed (default critic=anthropic can run in API mode)", () => {
    const d = decideFallback(
      { LLM_PROVIDER: "openai", ANTHROPIC_API_KEY: "sk-ant-aaaaaaaa" },
      true,
    );
    expect(d.apply).toBe(false);
  });
  test("unrelated key (main=anthropic default, GEMINI key present) + claude present: fallback not suppressed", () => {
    // default critic = openai. OPENAI_API_KEY is absent so Plan mode is zero friction.
    // But there's also a Gemini key, so it's a design call whether to fall back or
    // emit a hint. Current spec: fires unless the "default critic key" is present,
    // so it fires here.
    const d = decideFallback({ GEMINI_API_KEY: "AIzaaaaaaaa" }, true);
    expect(d.apply).toBe(true);
  });
  test("key shorter than 7 chars treated as absent: fallback fires", () => {
    const d = decideFallback({ OPENAI_API_KEY: "sk-aa" }, true);
    expect(d.apply).toBe(true);
  });
  test("LLM_PROVIDER_CRITICAL whitespace-only: not treated as explicit (fallback possible)", () => {
    const d = decideFallback({ LLM_PROVIDER_CRITICAL: "   " }, true);
    expect(d.apply).toBe(true);
  });
});

describe("decideFallback — message formatting", () => {
  test("message contains override hint", () => {
    const d = decideFallback({}, true);
    expect(d.message).toContain("export LLM_PROVIDER_CRITICAL=");
  });
  test("message mentions model tier", () => {
    const d = decideFallback({}, true);
    expect(d.message).toContain("sonnet");
    expect(d.message).toContain("opus");
  });
});
