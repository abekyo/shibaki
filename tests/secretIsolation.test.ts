import { expect, test, describe } from "bun:test";
import {
  buildAgentEnv,
  detectCriticProvider,
  detectMainProvider,
} from "../src/agent/secretIsolation.ts";

describe("detectCriticProvider", () => {
  test("LLM_PROVIDER_CRITICAL が明示されてればそれを返す", () => {
    expect(detectCriticProvider({ LLM_PROVIDER_CRITICAL: "openai" })).toBe("openai");
    expect(detectCriticProvider({ LLM_PROVIDER_CRITICAL: "gemini" })).toBe("gemini");
  });

  test("default: main=anthropic なら critic=openai", () => {
    expect(detectCriticProvider({ LLM_PROVIDER: "anthropic" })).toBe("openai");
    expect(detectCriticProvider({})).toBe("openai");
  });

  test("default: main=openai なら critic=anthropic", () => {
    expect(detectCriticProvider({ LLM_PROVIDER: "openai" })).toBe("anthropic");
  });
});

describe("detectMainProvider", () => {
  test("LLM_PROVIDER 値を尊重", () => {
    expect(detectMainProvider({ LLM_PROVIDER: "openai" })).toBe("openai");
    expect(detectMainProvider({ LLM_PROVIDER: "gemini" })).toBe("gemini");
  });
  test("未設定なら anthropic", () => {
    expect(detectMainProvider({})).toBe("anthropic");
  });
});

describe("buildAgentEnv — critic key isolation", () => {
  test("default: main=anthropic + critic=openai → OPENAI_API_KEY を strip、ANTHROPIC は残す", () => {
    const env = buildAgentEnv({
      ANTHROPIC_API_KEY: "sk-ant-xxx",
      OPENAI_API_KEY: "sk-yyy",
      PATH: "/usr/bin",
    });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-xxx");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  test("LLM_PROVIDER_CRITICAL=gemini → GEMINI_API_KEY を strip", () => {
    const env = buildAgentEnv({
      ANTHROPIC_API_KEY: "sk-ant-xxx",
      GEMINI_API_KEY: "AIza-yyy",
      LLM_PROVIDER_CRITICAL: "gemini",
    });
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-xxx");
    expect(env.LLM_PROVIDER_CRITICAL).toBeUndefined(); // config disclosure 防止
  });

  test("main=critic 同 provider なら strip しない (両方必要)", () => {
    const env = buildAgentEnv({
      ANTHROPIC_API_KEY: "sk-ant-xxx",
      LLM_PROVIDER: "anthropic",
      LLM_PROVIDER_CRITICAL: "anthropic",
    });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-xxx");
  });

  test("SHIBAKI_ALLOW_AGENT_SECRETS=1 で strip 無効化 (opt-out)", () => {
    const env = buildAgentEnv({
      OPENAI_API_KEY: "sk-yyy",
      SHIBAKI_ALLOW_AGENT_SECRETS: "1",
    });
    expect(env.OPENAI_API_KEY).toBe("sk-yyy");
  });

  test("config 系 env (LLM_PROVIDER / LLM_MODEL_*) は always strip", () => {
    const env = buildAgentEnv({
      ANTHROPIC_API_KEY: "sk-ant",
      LLM_PROVIDER: "anthropic",
      LLM_PROVIDER_CRITICAL: "openai",
      LLM_MODEL_CRITICAL: "gpt-5",
      LLM_MODEL_LIGHT: "haiku",
    });
    expect(env.LLM_PROVIDER).toBeUndefined();
    expect(env.LLM_PROVIDER_CRITICAL).toBeUndefined();
    expect(env.LLM_MODEL_CRITICAL).toBeUndefined();
    expect(env.LLM_MODEL_LIGHT).toBeUndefined();
  });

  test("OPENAI_BASE_URL / OPENAI_ORG_ID も openai critic なら strip", () => {
    const env = buildAgentEnv({
      ANTHROPIC_API_KEY: "sk-ant",
      OPENAI_API_KEY: "sk-yyy",
      OPENAI_BASE_URL: "https://api.openai.com",
      OPENAI_ORG_ID: "org-yyy",
    });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(env.OPENAI_ORG_ID).toBeUndefined();
  });
});
