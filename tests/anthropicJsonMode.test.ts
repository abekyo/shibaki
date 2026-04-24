// Anthropic provider は response_format 非対応のため、jsonMode=true のときは
// system prompt 末尾に JSON 強制指示を append することで代替する (穴 6)。
// この契約が壊れないことを lock する。
import { expect, test, describe } from "bun:test";
import type { CallOptions } from "../src/llm/types.ts";

// Anthropic SDK を mock して system prompt を覗く
const captured: { system?: string } = {};

import { mock } from "bun:test";

mock.module("@anthropic-ai/sdk", () => {
  class Anthropic {
    messages = {
      create: async (params: any) => {
        captured.system = params.system;
        return {
          content: [{ type: "text", text: '{"ok":true}' }],
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      },
    };
  }
  return { default: Anthropic };
});

const { anthropicProvider } = await import("../src/llm/providers/anthropic.ts");

describe("anthropic provider — jsonMode (穴 6)", () => {
  test("jsonMode=false は system をそのまま渡す", async () => {
    const opts: CallOptions = {
      model: "claude-sonnet-4-6",
      system: "You are helpful.",
      user: "hi",
      jsonMode: false,
    };
    await anthropicProvider.call(opts);
    expect(captured.system).toBe("You are helpful.");
  });

  test("jsonMode=true は system 末尾に JSON 強制指示が append される", async () => {
    const opts: CallOptions = {
      model: "claude-sonnet-4-6",
      system: "You are helpful.",
      user: "hi",
      jsonMode: true,
    };
    await anthropicProvider.call(opts);
    expect(captured.system).toContain("You are helpful.");
    expect(captured.system).toContain("EXACTLY ONE valid JSON object");
    expect(captured.system).toContain("code fences");
    // ordering: original system first, JSON instruction appended after
    const idxOrig = captured.system!.indexOf("You are helpful.");
    const idxJson = captured.system!.indexOf("EXACTLY ONE valid JSON object");
    expect(idxOrig).toBeLessThan(idxJson);
  });
});
