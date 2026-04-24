import type { LLMProvider, CallOptions, RawResponse } from "../types.ts";

let _client: any | null = null;
async function client(): Promise<any> {
  if (!_client) {
    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    _client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? "");
  }
  return _client;
}

export const geminiProvider: LLMProvider = {
  name: "gemini",
  async call(opts: CallOptions): Promise<RawResponse> {
    const genAI = await client();
    const model = genAI.getGenerativeModel({
      model: opts.model,
      systemInstruction: opts.system,
      generationConfig: {
        maxOutputTokens: opts.maxTokens ?? 4096,
        ...(opts.jsonMode ? { responseMimeType: "application/json" } : {}),
      },
    });
    const result = await Promise.race([
      model.generateContent(opts.user),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("gemini request timeout (60s)")), 60_000)
      ),
    ]) as any;
    const text = result.response.text();
    const um = result.response?.usageMetadata;
    const usage = um
      ? { input_tokens: um.promptTokenCount ?? 0, output_tokens: um.candidatesTokenCount ?? 0 }
      : undefined;
    return { text, model: opts.model, request_id: null, usage };
  },
  async testApiKey() {
    const key = process.env.GEMINI_API_KEY;
    if (!key) return { ok: false, error: "GEMINI_API_KEY not set" };
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`
      );
      if (res.ok) return { ok: true };
      return { ok: false, error: `HTTP ${res.status}` };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  },
};
