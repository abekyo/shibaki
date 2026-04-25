import { expect, test, describe } from "bun:test";
import {
  buildAgentEnv,
  detectCriticProvider,
  detectMainProvider,
} from "../src/agent/secretIsolation.ts";

describe("detectCriticProvider", () => {
  test("returns LLM_PROVIDER_CRITICAL if explicitly set", () => {
    expect(detectCriticProvider({ LLM_PROVIDER_CRITICAL: "openai" })).toBe("openai");
    expect(detectCriticProvider({ LLM_PROVIDER_CRITICAL: "gemini" })).toBe("gemini");
  });

  test("default: main=anthropic → critic=openai", () => {
    expect(detectCriticProvider({ LLM_PROVIDER: "anthropic" })).toBe("openai");
    expect(detectCriticProvider({})).toBe("openai");
  });

  test("default: main=openai → critic=anthropic", () => {
    expect(detectCriticProvider({ LLM_PROVIDER: "openai" })).toBe("anthropic");
  });
});

describe("detectMainProvider", () => {
  test("respects LLM_PROVIDER value", () => {
    expect(detectMainProvider({ LLM_PROVIDER: "openai" })).toBe("openai");
    expect(detectMainProvider({ LLM_PROVIDER: "gemini" })).toBe("gemini");
  });
  test("unset → anthropic", () => {
    expect(detectMainProvider({})).toBe("anthropic");
  });
});

describe("buildAgentEnv — critic key isolation", () => {
  test("default: main=anthropic + critic=openai → strips OPENAI_API_KEY, keeps ANTHROPIC", () => {
    const env = buildAgentEnv({
      ANTHROPIC_API_KEY: "sk-ant-xxx",
      OPENAI_API_KEY: "sk-yyy",
      PATH: "/usr/bin",
    });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-xxx");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  test("LLM_PROVIDER_CRITICAL=gemini → strips GEMINI_API_KEY", () => {
    const env = buildAgentEnv({
      ANTHROPIC_API_KEY: "sk-ant-xxx",
      GEMINI_API_KEY: "AIza-yyy",
      LLM_PROVIDER_CRITICAL: "gemini",
    });
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-xxx");
    expect(env.LLM_PROVIDER_CRITICAL).toBeUndefined(); // prevent config disclosure
  });

  test("main=critic same provider → no strip (both needed)", () => {
    const env = buildAgentEnv({
      ANTHROPIC_API_KEY: "sk-ant-xxx",
      LLM_PROVIDER: "anthropic",
      LLM_PROVIDER_CRITICAL: "anthropic",
    });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-xxx");
  });

  test("SHIBAKI_ALLOW_AGENT_SECRETS=1 disables strip (opt-out)", () => {
    const env = buildAgentEnv({
      OPENAI_API_KEY: "sk-yyy",
      SHIBAKI_ALLOW_AGENT_SECRETS: "1",
    });
    expect(env.OPENAI_API_KEY).toBe("sk-yyy");
  });

  test("config envs (LLM_PROVIDER / LLM_MODEL_*) are always stripped", () => {
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

  test("OPENAI_BASE_URL / OPENAI_ORG_ID are also stripped under openai critic", () => {
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
