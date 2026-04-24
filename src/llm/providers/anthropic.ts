import Anthropic from "@anthropic-ai/sdk";
import type { LLMProvider, CallOptions, RawResponse } from "../types.ts";

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) {
    _client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      timeout: 60_000,
      maxRetries: 0,
    });
  }
  return _client;
}

// Anthropic SDK は response_format 非対応のため、jsonMode=true のときは system prompt に
// JSON 強制指示を append して対応する (perfect ではないが callJson 側の defensive parser と
// 併用すれば安定する)。
const JSON_MODE_SUFFIX =
  "\n\n## Output format (strict)\n" +
  "- Reply with EXACTLY ONE valid JSON object\n" +
  "- Start with `{`, end with `}`\n" +
  "- Do NOT wrap in code fences (```)\n" +
  "- Do NOT include any text before or after the JSON (no explanation, greeting, summary)\n" +
  "- Escape control characters properly";

export const anthropicProvider: LLMProvider = {
  name: "anthropic",
  async call(opts: CallOptions): Promise<RawResponse> {
    const system = opts.jsonMode ? `${opts.system}${JSON_MODE_SUFFIX}` : opts.system;
    const res = await client().messages.create({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 4096,
      system,
      messages: [{ role: "user", content: opts.user }],
    });
    const text = res.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");
    const usage = res.usage
      ? { input_tokens: res.usage.input_tokens ?? 0, output_tokens: res.usage.output_tokens ?? 0 }
      : undefined;
    return { text, model: opts.model, request_id: (res as any)._request_id ?? null, usage };
  },
  async testApiKey() {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return { ok: false, error: "ANTHROPIC_API_KEY not set" };
    if (!/^sk-ant-/.test(key)) return { ok: false, error: "invalid format (must start with sk-ant-)" };
    try {
      const res = await fetch("https://api.anthropic.com/v1/models?limit=1", {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      });
      if (res.ok) return { ok: true };
      return { ok: false, error: `HTTP ${res.status}` };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  },
};
