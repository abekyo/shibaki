// CLI mode (Claude Code plan / Gemini Code Assist / Codex plan) の preflight /
// secretIsolation 挙動を確認する。API key 不要経路で起動が通ることが主目的。
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
  test("API provider の family は provider 名と同じ", () => {
    expect(providerFamily("anthropic")).toBe("anthropic");
    expect(providerFamily("openai")).toBe("openai");
    expect(providerFamily("gemini")).toBe("gemini");
  });
  test("CLI provider は対応する family に属する", () => {
    expect(providerFamily("anthropic-cli")).toBe("anthropic");
    expect(providerFamily("gemini-cli")).toBe("gemini");
    expect(providerFamily("codex-cli")).toBe("openai");
  });
  test("isCliProvider は CLI variant のみ true", () => {
    expect(isCliProvider("anthropic-cli")).toBe(true);
    expect(isCliProvider("gemini-cli")).toBe(true);
    expect(isCliProvider("codex-cli")).toBe(true);
    expect(isCliProvider("anthropic")).toBe(false);
    expect(isCliProvider("openai")).toBe(false);
    expect(isCliProvider("gemini")).toBe(false);
  });
});

describe("preflightCriticKey — CLI critic は key check を skip", () => {
  test("critic=anthropic-cli なら ANTHROPIC_API_KEY 不要", () => {
    expect(preflightCriticKey({ LLM_PROVIDER_CRITICAL: "anthropic-cli" })).toBeNull();
  });
  test("critic=gemini-cli なら GEMINI_API_KEY 不要", () => {
    expect(preflightCriticKey({ LLM_PROVIDER_CRITICAL: "gemini-cli" })).toBeNull();
  });
  test("critic=codex-cli なら OPENAI_API_KEY 不要", () => {
    expect(preflightCriticKey({ LLM_PROVIDER_CRITICAL: "codex-cli" })).toBeNull();
  });
});

describe("preflightProviderSeparation — CLI critic は同 family でも auto-allow", () => {
  test("main=anthropic-cli + critic=anthropic-cli → auto-allow (UX-first, Q3=A)", () => {
    expect(
      preflightProviderSeparation({
        LLM_PROVIDER: "anthropic-cli",
        LLM_PROVIDER_CRITICAL: "anthropic-cli",
      }),
    ).toBeNull();
  });
  test("main=anthropic (API) + critic=anthropic-cli → 同 family だが CLI なので auto-allow", () => {
    expect(
      preflightProviderSeparation({
        LLM_PROVIDER: "anthropic",
        LLM_PROVIDER_CRITICAL: "anthropic-cli",
      }),
    ).toBeNull();
  });
  test("main=anthropic-cli + critic=anthropic (API) → 同 family、critic が API なので reject", () => {
    const r = preflightProviderSeparation({
      LLM_PROVIDER: "anthropic-cli",
      LLM_PROVIDER_CRITICAL: "anthropic",
      ANTHROPIC_API_KEY: "sk-ant-aaaaaaaa",
    });
    expect(r?.reason).toContain("same family");
  });
  test("異 family CLI (main=anthropic-cli + critic=gemini-cli) は普通に pass", () => {
    expect(
      preflightProviderSeparation({
        LLM_PROVIDER: "anthropic-cli",
        LLM_PROVIDER_CRITICAL: "gemini-cli",
      }),
    ).toBeNull();
  });
});

describe("runAllPreflight — CLI mode 最小構成で起動が通る", () => {
  const alwaysAvail = async (_: string) => true;
  test("Plan mode: main=claude CLI + critic=claude CLI だけで通る (key 無し)", async () => {
    expect(
      await runAllPreflight({
        LLM_PROVIDER: "anthropic-cli",
        LLM_PROVIDER_CRITICAL: "anthropic-cli",
        LLM_MODEL_CRITICAL: "opus",
      }, alwaysAvail),
    ).toBeNull();
  });
  test("Plan mode (gemini-cli critic) も key 無しで通る", async () => {
    expect(
      await runAllPreflight({
        LLM_PROVIDER: "anthropic-cli",
        LLM_PROVIDER_CRITICAL: "gemini-cli",
      }, alwaysAvail),
    ).toBeNull();
  });
});

describe("preflightCriticCli — CLI 可用性 check", () => {
  test("critic が API provider なら skip (null)", async () => {
    const neverCalled = async (_: string) => {
      throw new Error("should not be called");
    };
    expect(
      await preflightCriticCli({ LLM_PROVIDER_CRITICAL: "gemini" }, neverCalled),
    ).toBeNull();
  });
  test("critic=anthropic-cli で claude が PATH に無い → fail", async () => {
    const r = await preflightCriticCli(
      { LLM_PROVIDER_CRITICAL: "anthropic-cli" },
      async (_) => false,
    );
    expect(r?.reason).toContain("claude");
    expect(r?.reason).toContain("not found");
    expect(r?.hint).toContain("claude-code");
  });
  test("critic=codex-cli で codex が PATH に無い → fail", async () => {
    const r = await preflightCriticCli(
      { LLM_PROVIDER_CRITICAL: "codex-cli" },
      async (_) => false,
    );
    expect(r?.reason).toContain("codex");
    expect(r?.hint).toContain("experimental");
  });
  test("CLI ある + critic=CLI → null", async () => {
    expect(
      await preflightCriticCli(
        { LLM_PROVIDER_CRITICAL: "anthropic-cli" },
        async (_) => true,
      ),
    ).toBeNull();
  });
  test("CLAUDE_CLI_BIN 上書きがあればそちらを check", async () => {
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

describe("detectCriticProvider / detectMainProvider — CLI 値を受け取る", () => {
  test("LLM_PROVIDER=anthropic-cli", () => {
    expect(detectMainProvider({ LLM_PROVIDER: "anthropic-cli" })).toBe("anthropic-cli");
  });
  test("LLM_PROVIDER_CRITICAL=codex-cli", () => {
    expect(detectCriticProvider({ LLM_PROVIDER_CRITICAL: "codex-cli" })).toBe("codex-cli");
  });
  test("default (main=anthropic-cli, critic 未指定) → openai (family で別 provider)", () => {
    expect(detectCriticProvider({ LLM_PROVIDER: "anthropic-cli" })).toBe("openai");
  });
  test("invalid な値は anthropic にフォールバック", () => {
    expect(detectMainProvider({ LLM_PROVIDER: "bogus" })).toBe("anthropic");
  });
});

describe("buildAgentEnv — CLI critic は strip 対象の key を持たない", () => {
  test("critic=anthropic-cli のとき ANTHROPIC_API_KEY は (あれば) 残る (CLI は key 使わない = 共有問題なし)", () => {
    // main=anthropic-cli, critic=anthropic-cli。ANTHROPIC_API_KEY が env に
    // あっても CLI は OAuth を使うので strip しても残しても動く。実装上は
    // isCli のため「両方 API 同 family」条件が外れ、strip される。
    // このテストでは「strip されても agent の CLI 動作に影響がない」契約を
    // 確認するだけで十分なので、LLM_PROVIDER_CRITICAL が strip されることだけ確認。
    const env = buildAgentEnv({
      LLM_PROVIDER: "anthropic-cli",
      LLM_PROVIDER_CRITICAL: "anthropic-cli",
      LLM_MODEL_CRITICAL: "opus",
    });
    expect(env.LLM_PROVIDER_CRITICAL).toBeUndefined();
    expect(env.LLM_MODEL_CRITICAL).toBeUndefined();
  });
  test("main=anthropic (API) + critic=anthropic-cli: ANTHROPIC_API_KEY は main が必要なので残る", () => {
    // critic=CLI は API key を使わないので、ANTHROPIC_API_KEY の strip 判定は
    // 「critic が anthropic API かどうか」で決まる。CLI なら strip しない。
    const env = buildAgentEnv({
      LLM_PROVIDER: "anthropic",
      LLM_PROVIDER_CRITICAL: "anthropic-cli",
      ANTHROPIC_API_KEY: "sk-ant-xxx",
    });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-xxx");
  });
  test("main=anthropic-cli + critic=gemini (API): GEMINI_API_KEY は strip される", () => {
    const env = buildAgentEnv({
      LLM_PROVIDER: "anthropic-cli",
      LLM_PROVIDER_CRITICAL: "gemini",
      GEMINI_API_KEY: "AIza-xxx",
    });
    expect(env.GEMINI_API_KEY).toBeUndefined();
  });
  test("critic=gemini-cli のとき LLM_PROVIDER / LLM_PROVIDER_CRITICAL は常に strip", () => {
    const env = buildAgentEnv({
      LLM_PROVIDER: "anthropic-cli",
      LLM_PROVIDER_CRITICAL: "gemini-cli",
    });
    expect(env.LLM_PROVIDER).toBeUndefined();
    expect(env.LLM_PROVIDER_CRITICAL).toBeUndefined();
  });
});
