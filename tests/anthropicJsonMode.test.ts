// The Anthropic provider does not support response_format, so when jsonMode=true
// we substitute by appending a JSON-forcing instruction to the end of the system
// prompt (Gap 6). This locks in the contract.
import { expect, test, describe } from "bun:test";
import type { CallOptions } from "../src/llm/types.ts";

// Mock the Anthropic SDK to peek at the system prompt
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

describe("anthropic provider — jsonMode (Gap 6)", () => {
  test("jsonMode=false passes system through unchanged", async () => {
    const opts: CallOptions = {
      model: "claude-sonnet-4-6",
      system: "You are helpful.",
      user: "hi",
      jsonMode: false,
    };
    await anthropicProvider.call(opts);
    expect(captured.system).toBe("You are helpful.");
  });

  test("jsonMode=true appends a JSON-forcing instruction to system", async () => {
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
