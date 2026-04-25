import type { LLMProvider, CallOptions, RawResponse } from "../types.ts";

let _client: any | null = null;
async function client(): Promise<any> {
  if (!_client) {
    const OpenAI = (await import("openai")).default;
    _client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: 60_000,
      maxRetries: 0,
    });
  }
  return _client;
}

// New-generation models (o1 / o3 / gpt-5 family) reject max_tokens and require max_completion_tokens
function isNewGenModel(model: string): boolean {
  return /^o1(-|$)/.test(model) || /^o3(-|$)/.test(model) || /^gpt-5/.test(model);
}

export const openaiProvider: LLMProvider = {
  name: "openai",
  async call(opts: CallOptions): Promise<RawResponse> {
    const c = await client();
    const o1 = isNewGenModel(opts.model);
    const messages = o1
      ? [{ role: "user" as const, content: `${opts.system}\n\n---\n\n${opts.user}` }]
      : [
          { role: "system" as const, content: opts.system },
          { role: "user" as const, content: opts.user },
        ];

    const params: any = { model: opts.model, messages };
    if (o1) {
      params.max_completion_tokens = opts.maxTokens ?? 4096;
    } else {
      params.max_tokens = opts.maxTokens ?? 4096;
      if (opts.jsonMode) params.response_format = { type: "json_object" as const };
    }

    const res = await c.chat.completions.create(params);
    const text = res.choices?.[0]?.message?.content ?? "";
    const u = (res as any).usage;
    const usage = u
      ? { input_tokens: u.prompt_tokens ?? 0, output_tokens: u.completion_tokens ?? 0 }
      : undefined;
    return { text, model: opts.model, request_id: (res as any).id ?? null, usage };
  },
  async testApiKey() {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return { ok: false, error: "OPENAI_API_KEY not set" };
    if (!/^sk-/.test(key)) return { ok: false, error: "invalid format (must start with sk-)" };
    try {
      const res = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (res.ok) return { ok: true };
      return { ok: false, error: `HTTP ${res.status}` };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  },
};
