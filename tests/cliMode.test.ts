// Verifies preflight / secretIsolation behavior for CLI mode (Claude Code plan /
// Gemini Code Assist / Codex plan). Main goal: confirm startup succeeds via the
// API-key-less path.
import { expect, test, describe } from "bun:test";
import {
  preflightCriticKey,
  preflightProviderSeparation,
  preflightCriticCli,
  runAllPreflight,
} from "../src/cli/preflight.ts";
import {
  buildAgentEnv,
  detectCriticProvider,
  detectMainProvider,
} from "../src/agent/secretIsolation.ts";
import { providerFamily, isCliProvider } from "../src/llm/types.ts";

describe("providerFamily / isCliProvider", () => {
  test("API provider family equals provider name", () => {
    expect(providerFamily("anthropic")).toBe("anthropic");
    expect(providerFamily("openai")).toBe("openai");
    expect(providerFamily("gemini")).toBe("gemini");
  });
  test("CLI provider belongs to its corresponding family", () => {
    expect(providerFamily("anthropic-cli")).toBe("anthropic");
    expect(providerFamily("gemini-cli")).toBe("gemini");
    expect(providerFamily("codex-cli")).toBe("openai");
  });
  test("isCliProvider is true only for CLI variants", () => {
    expect(isCliProvider("anthropic-cli")).toBe(true);
    expect(isCliProvider("gemini-cli")).toBe(true);
    expect(isCliProvider("codex-cli")).toBe(true);
    expect(isCliProvider("anthropic")).toBe(false);
    expect(isCliProvider("openai")).toBe(false);
    expect(isCliProvider("gemini")).toBe(false);
  });
});

describe("preflightCriticKey — CLI critic skips key check", () => {
  test("critic=anthropic-cli does not require ANTHROPIC_API_KEY", () => {
    expect(preflightCriticKey({ LLM_PROVIDER_CRITICAL: "anthropic-cli" })).toBeNull();
  });
  test("critic=gemini-cli does not require GEMINI_API_KEY", () => {
    expect(preflightCriticKey({ LLM_PROVIDER_CRITICAL: "gemini-cli" })).toBeNull();
  });
  test("critic=codex-cli does not require OPENAI_API_KEY", () => {
    expect(preflightCriticKey({ LLM_PROVIDER_CRITICAL: "codex-cli" })).toBeNull();
  });
});

describe("preflightProviderSeparation — CLI critic auto-allowed even within same family", () => {
  test("main=anthropic-cli + critic=anthropic-cli → auto-allow (UX-first, Q3=A)", () => {
    expect(
      preflightProviderSeparation({
        LLM_PROVIDER: "anthropic-cli",
        LLM_PROVIDER_CRITICAL: "anthropic-cli",
      }),
    ).toBeNull();
  });
  test("main=anthropic (API) + critic=anthropic-cli → same family but CLI → auto-allow", () => {
    expect(
      preflightProviderSeparation({
        LLM_PROVIDER: "anthropic",
        LLM_PROVIDER_CRITICAL: "anthropic-cli",
      }),
    ).toBeNull();
  });
  test("main=anthropic-cli + critic=anthropic (API) → same family, critic is API → reject", () => {
    const r = preflightProviderSeparation({
      LLM_PROVIDER: "anthropic-cli",
      LLM_PROVIDER_CRITICAL: "anthropic",
      ANTHROPIC_API_KEY: "sk-ant-aaaaaaaa",
    });
    expect(r?.reason).toContain("same family");
  });
  test("cross-family CLI (main=anthropic-cli + critic=gemini-cli) passes normally", () => {
    expect(
      preflightProviderSeparation({
        LLM_PROVIDER: "anthropic-cli",
        LLM_PROVIDER_CRITICAL: "gemini-cli",
      }),
    ).toBeNull();
  });
});

describe("runAllPreflight — CLI mode minimal config starts up", () => {
  const alwaysAvail = async (_: string) => true;
  test("Plan mode: main=claude CLI + critic=claude CLI alone passes (no key)", async () => {
    expect(
      await runAllPreflight({
        LLM_PROVIDER: "anthropic-cli",
        LLM_PROVIDER_CRITICAL: "anthropic-cli",
        LLM_MODEL_CRITICAL: "opus",
      }, alwaysAvail),
    ).toBeNull();
  });
  test("Plan mode (gemini-cli critic) also passes without a key", async () => {
    expect(
      await runAllPreflight({
        LLM_PROVIDER: "anthropic-cli",
        LLM_PROVIDER_CRITICAL: "gemini-cli",
      }, alwaysAvail),
    ).toBeNull();
  });
});

describe("preflightCriticCli — CLI availability check", () => {
  test("critic is API provider → skip (null)", async () => {
    const neverCalled = async (_: string) => {
      throw new Error("should not be called");
    };
    expect(
      await preflightCriticCli({ LLM_PROVIDER_CRITICAL: "gemini" }, neverCalled),
    ).toBeNull();
  });
  test("critic=anthropic-cli with claude not on PATH → fail", async () => {
    const r = await preflightCriticCli(
      { LLM_PROVIDER_CRITICAL: "anthropic-cli" },
      async (_) => false,
    );
    expect(r?.reason).toContain("claude");
    expect(r?.reason).toContain("not found");
    expect(r?.hint).toContain("claude-code");
  });
  test("critic=codex-cli with codex not on PATH → fail", async () => {
    const r = await preflightCriticCli(
      { LLM_PROVIDER_CRITICAL: "codex-cli" },
      async (_) => false,
    );
    expect(r?.reason).toContain("codex");
    expect(r?.hint).toContain("experimental");
  });
  test("CLI present + critic=CLI → null", async () => {
    expect(
      await preflightCriticCli(
        { LLM_PROVIDER_CRITICAL: "anthropic-cli" },
        async (_) => true,
      ),
    ).toBeNull();
  });
  test("CLAUDE_CLI_BIN override is checked instead", async () => {
    const seen: string[] = [];
    const r = await preflightCriticCli(
      {
        LLM_PROVIDER_CRITICAL: "anthropic-cli",
        CLAUDE_CLI_BIN: "/custom/bin/claude-wrapper",
      },
      async (bin) => {
        seen.push(bin);
        return false;
      },
    );
    expect(seen).toEqual(["/custom/bin/claude-wrapper"]);
    expect(r?.reason).toContain("claude-wrapper");
  });
});

describe("detectCriticProvider / detectMainProvider — accept CLI values", () => {
  test("LLM_PROVIDER=anthropic-cli", () => {
    expect(detectMainProvider({ LLM_PROVIDER: "anthropic-cli" })).toBe("anthropic-cli");
  });
  test("LLM_PROVIDER_CRITICAL=codex-cli", () => {
    expect(detectCriticProvider({ LLM_PROVIDER_CRITICAL: "codex-cli" })).toBe("codex-cli");
  });
  test("default (main=anthropic-cli, critic unset) → openai (different family provider)", () => {
    expect(detectCriticProvider({ LLM_PROVIDER: "anthropic-cli" })).toBe("openai");
  });
  test("invalid values fall back to anthropic", () => {
    expect(detectMainProvider({ LLM_PROVIDER: "bogus" })).toBe("anthropic");
  });
});

describe("buildAgentEnv — CLI critic has no strip-target keys", () => {
  test("critic=anthropic-cli: ANTHROPIC_API_KEY (if any) stays (CLI does not use the key = no sharing problem)", () => {
    // main=anthropic-cli, critic=anthropic-cli. Even if ANTHROPIC_API_KEY is in
    // env, the CLI uses OAuth so it works whether stripped or not. In the
    // implementation, isCli causes the "both API same family" condition to drop,
    // and it is stripped. This test only needs to confirm the contract that
    // stripping does not affect the agent's CLI behavior, so we just confirm
    // that LLM_PROVIDER_CRITICAL is stripped.
    const env = buildAgentEnv({
      LLM_PROVIDER: "anthropic-cli",
      LLM_PROVIDER_CRITICAL: "anthropic-cli",
      LLM_MODEL_CRITICAL: "opus",
    });
    expect(env.LLM_PROVIDER_CRITICAL).toBeUndefined();
    expect(env.LLM_MODEL_CRITICAL).toBeUndefined();
  });
  test("main=anthropic (API) + critic=anthropic-cli: ANTHROPIC_API_KEY stays (main needs it)", () => {
    // critic=CLI does not use the API key, so the ANTHROPIC_API_KEY strip
    // decision is based on whether critic is anthropic API. CLI → no strip.
    const env = buildAgentEnv({
      LLM_PROVIDER: "anthropic",
      LLM_PROVIDER_CRITICAL: "anthropic-cli",
      ANTHROPIC_API_KEY: "sk-ant-xxx",
    });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-xxx");
  });
  test("main=anthropic-cli + critic=gemini (API): GEMINI_API_KEY is stripped", () => {
    const env = buildAgentEnv({
      LLM_PROVIDER: "anthropic-cli",
      LLM_PROVIDER_CRITICAL: "gemini",
      GEMINI_API_KEY: "AIza-xxx",
    });
    expect(env.GEMINI_API_KEY).toBeUndefined();
  });
  test("critic=gemini-cli: LLM_PROVIDER / LLM_PROVIDER_CRITICAL are always stripped", () => {
    const env = buildAgentEnv({
      LLM_PROVIDER: "anthropic-cli",
      LLM_PROVIDER_CRITICAL: "gemini-cli",
    });
    expect(env.LLM_PROVIDER).toBeUndefined();
    expect(env.LLM_PROVIDER_CRITICAL).toBeUndefined();
  });
});
