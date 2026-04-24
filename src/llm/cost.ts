// コスト見積もりのみ (Phase 1 は DB 永続化しない、ループ中の累計だけメモリで)
// 価格は 2026-01 時点の概算、正確な billing は provider dashboard 参照

const PRICING: Record<string, { input: number; output: number }> = {
  // Anthropic
  "claude-opus-4-7":      { input: 15.0, output: 75.0 },
  "claude-sonnet-4-6":    { input: 3.0,  output: 15.0 },
  "claude-haiku-4-5":     { input: 1.0,  output: 5.0 },

  // OpenAI
  "gpt-5":                { input: 10.0, output: 30.0 },
  "gpt-4o":               { input: 2.5,  output: 10.0 },
  "gpt-4o-mini":          { input: 0.15, output: 0.6 },
  "o1":                   { input: 15.0, output: 60.0 },

  // Gemini
  "gemini-2.5-pro":       { input: 1.25, output: 5.0 },
  "gemini-1.5-pro":       { input: 1.25, output: 5.0 },
  "gemini-2.0-flash":     { input: 0.075, output: 0.3 },
};

const FALLBACK_PRICING = { input: 3.0, output: 15.0 };

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model] ?? FALLBACK_PRICING;
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}
