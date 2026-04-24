import { expect, test, describe } from "bun:test";
import {
  preflightCriticKey,
  preflightProviderSeparation,
  runAllPreflight,
} from "../src/cli/preflight.ts";

describe("preflightCriticKey", () => {
  test("default (main=anthropic, critic=openai): OPENAI_API_KEY 必須", () => {
    expect(preflightCriticKey({})?.reason).toContain("OPENAI_API_KEY");
  });

  test("OPENAI_API_KEY ありで pass", () => {
    expect(preflightCriticKey({
      OPENAI_API_KEY: "sk-aaaaaaaaaa",
    })).toBeNull();
  });

  test("LLM_PROVIDER_CRITICAL=gemini なら GEMINI_API_KEY 必須", () => {
    expect(preflightCriticKey({
      LLM_PROVIDER_CRITICAL: "gemini",
    })?.reason).toContain("GEMINI_API_KEY");
  });

  test("OPENAI_API_KEY が sk- で始まらないと拒否", () => {
    expect(preflightCriticKey({
      OPENAI_API_KEY: "wrong-prefix-key",
    })?.reason).toContain("invalid format");
  });

  test("ANTHROPIC critic で sk-ant- prefix チェック", () => {
    expect(preflightCriticKey({
      LLM_PROVIDER_CRITICAL: "anthropic",
      ANTHROPIC_API_KEY: "sk-wrong",
    })?.reason).toContain("invalid format");
  });
});

describe("preflightProviderSeparation", () => {
  test("default で main=critic 同 provider 不可 (anthropic)", () => {
    expect(preflightProviderSeparation({
      LLM_PROVIDER: "anthropic",
      LLM_PROVIDER_CRITICAL: "anthropic",
    })?.reason).toContain("self-critique");
  });

  test("別 provider なら pass", () => {
    expect(preflightProviderSeparation({
      LLM_PROVIDER: "anthropic",
      LLM_PROVIDER_CRITICAL: "openai",
    })).toBeNull();
  });

  test("SHIBAKI_ALLOW_SAME_PROVIDER=1 で opt-out", () => {
    expect(preflightProviderSeparation({
      LLM_PROVIDER: "anthropic",
      LLM_PROVIDER_CRITICAL: "anthropic",
      SHIBAKI_ALLOW_SAME_PROVIDER: "1",
    })).toBeNull();
  });
});

describe("runAllPreflight — fail-closed 順序", () => {
  // CLI 可用性 check は偽装 (true 固定) し、key / 分離ロジックのみ検証。
  const alwaysAvail = async (_: string) => true;

  test("key 不在を最初に拒否", async () => {
    const r = await runAllPreflight({}, alwaysAvail);
    expect(r?.reason).toContain("OPENAI_API_KEY");
  });

  test("key 通過後に provider 分離 chk", async () => {
    const r = await runAllPreflight({
      LLM_PROVIDER: "openai",
      LLM_PROVIDER_CRITICAL: "openai",
      OPENAI_API_KEY: "sk-aaaaaaaa",
    }, alwaysAvail);
    expect(r?.reason).toContain("self-critique");
  });

  test("両方 pass で null", async () => {
    expect(await runAllPreflight({
      OPENAI_API_KEY: "sk-aaaaaaaa",
    }, alwaysAvail)).toBeNull();
  });
});
