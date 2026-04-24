// Test: buildMissingKeyHint pivots based on what env actually has.
// Before this fix, doctor said "get OPENAI_API_KEY" even when GEMINI_API_KEY
// was already exported — misleading hint that pointed away from the user's
// existing setup. Each case below covers one path in the new logic.
import { expect, test, describe } from "bun:test";
import { buildMissingKeyHint } from "../src/cli/doctor.ts";

// Default-detected critic provider in Shibaki is "openai" (different from
// the default main "anthropic"). Most of these scenarios assume the missing
// key check fired for openai (the most common production miss).

describe("buildMissingKeyHint", () => {
  test("Gemini key set, critic detected = openai → suggest LLM_PROVIDER_CRITICAL=gemini", () => {
    const env = {
      GEMINI_API_KEY: "AIzaSyA-fake-but-long-enough-12345",
    } as NodeJS.ProcessEnv;
    const hint = buildMissingKeyHint("openai", env);
    expect(hint).toContain("GEMINI_API_KEY");
    expect(hint).toContain("LLM_PROVIDER_CRITICAL=gemini");
    // Must NOT tell the user to go fetch an OpenAI key — that was the bug
    expect(hint).not.toContain("https://platform.openai.com");
  });

  test("Anthropic key only (matches default main) → recommend Gemini, not anthropic-as-critic", () => {
    // User has only ANTHROPIC_API_KEY. Default main = anthropic, default
    // critic = openai. Suggesting LLM_PROVIDER_CRITICAL=anthropic would
    // create a self-critique blind spot, so we should NOT recommend it.
    const env = {
      ANTHROPIC_API_KEY: "sk-ant-fake-but-long-enough-12345",
    } as NodeJS.ProcessEnv;
    const hint = buildMissingKeyHint("openai", env);
    expect(hint).toContain("self-critique");
    expect(hint).toContain("Gemini");
    expect(hint).toContain("LLM_PROVIDER_CRITICAL=gemini");
    // Must NOT suggest LLM_PROVIDER_CRITICAL=anthropic (would collide w/ main)
    expect(hint).not.toContain("LLM_PROVIDER_CRITICAL=anthropic");
  });

  test("no keys at all → Gemini-first hint with detected provider as fallback", () => {
    const env = {} as NodeJS.ProcessEnv;
    const hint = buildMissingKeyHint("openai", env);
    expect(hint).toContain("GEMINI_API_KEY");
    expect(hint).toContain("aistudio.google.com");
    // Fallback should still mention the detected provider
    expect(hint).toContain("OPENAI_API_KEY");
  });

  test("multiple non-main keys → suggest first + list alternatives", () => {
    // Two keys available, neither matches main (anthropic). Pick first,
    // list the rest as alternatives.
    const env = {
      OPENAI_API_KEY: "sk-fake-but-long-enough-12345",
      GEMINI_API_KEY: "AIzaSyA-fake-but-long-enough-12345",
    } as NodeJS.ProcessEnv;
    const hint = buildMissingKeyHint("anthropic", env);
    // Some pivot suggestion appears
    expect(hint).toMatch(/LLM_PROVIDER_CRITICAL=(openai|gemini)/);
    // Both alternatives mentioned
    expect(hint).toContain("openai");
    expect(hint).toContain("gemini");
  });
});
