import { expect, test, describe } from "bun:test";
import {
  preflightCriticKey,
  preflightProviderSeparation,
  runAllPreflight,
} from "../src/cli/preflight.ts";

describe("preflightCriticKey", () => {
  test("default (main=anthropic, critic=openai): OPENAI_API_KEY required", () => {
    expect(preflightCriticKey({})?.reason).toContain("OPENAI_API_KEY");
  });

  test("passes with OPENAI_API_KEY present", () => {
    expect(preflightCriticKey({
      OPENAI_API_KEY: "sk-aaaaaaaaaa",
    })).toBeNull();
  });

  test("LLM_PROVIDER_CRITICAL=gemini requires GEMINI_API_KEY", () => {
    expect(preflightCriticKey({
      LLM_PROVIDER_CRITICAL: "gemini",
    })?.reason).toContain("GEMINI_API_KEY");
  });

  test("rejects OPENAI_API_KEY that does not start with sk-", () => {
    expect(preflightCriticKey({
      OPENAI_API_KEY: "wrong-prefix-key",
    })?.reason).toContain("invalid format");
  });

  test("ANTHROPIC critic checks sk-ant- prefix", () => {
    expect(preflightCriticKey({
      LLM_PROVIDER_CRITICAL: "anthropic",
      ANTHROPIC_API_KEY: "sk-wrong",
    })?.reason).toContain("invalid format");
  });
});

describe("preflightProviderSeparation", () => {
  test("by default main=critic same provider is forbidden (anthropic)", () => {
    expect(preflightProviderSeparation({
      LLM_PROVIDER: "anthropic",
      LLM_PROVIDER_CRITICAL: "anthropic",
    })?.reason).toContain("self-critique");
  });

  test("different providers → pass", () => {
    expect(preflightProviderSeparation({
      LLM_PROVIDER: "anthropic",
      LLM_PROVIDER_CRITICAL: "openai",
    })).toBeNull();
  });

  test("SHIBAKI_ALLOW_SAME_PROVIDER=1 opts out", () => {
    expect(preflightProviderSeparation({
      LLM_PROVIDER: "anthropic",
      LLM_PROVIDER_CRITICAL: "anthropic",
      SHIBAKI_ALLOW_SAME_PROVIDER: "1",
    })).toBeNull();
  });
});

describe("runAllPreflight — fail-closed ordering", () => {
  // CLI availability check is faked (always true); only key / separation logic is tested.
  const alwaysAvail = async (_: string) => true;

  test("rejects missing key first", async () => {
    const r = await runAllPreflight({}, alwaysAvail);
    expect(r?.reason).toContain("OPENAI_API_KEY");
  });

  test("checks provider separation after key passes", async () => {
    const r = await runAllPreflight({
      LLM_PROVIDER: "openai",
      LLM_PROVIDER_CRITICAL: "openai",
      OPENAI_API_KEY: "sk-aaaaaaaa",
    }, alwaysAvail);
    expect(r?.reason).toContain("self-critique");
  });

  test("both pass → null", async () => {
    expect(await runAllPreflight({
      OPENAI_API_KEY: "sk-aaaaaaaa",
    }, alwaysAvail)).toBeNull();
  });
});
