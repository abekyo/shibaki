// Build the frozen-snapshot text injected into the critic system prompt.
// Immutable for the duration of one session (Hermes-style frozen snapshot).
// When there are no patterns, return an empty string and append nothing
// to the prompt (cache integrity).
import type { Pattern } from "./patterns.ts";

export function buildPatternsSnapshot(patterns: Pattern[]): string {
  if (patterns.length === 0) return "";
  const failures = patterns.filter((p) => p.type === "failure");
  const successes = patterns.filter((p) => p.type === "success");
  const lines: string[] = [];
  lines.push("");
  lines.push("## Pattern dictionary accumulated from past sessions (preempt — check whether similar problems are recurring)");
  if (failures.length > 0) {
    lines.push("");
    lines.push("### Past failure modes (refuted patterns)");
    for (const p of failures) {
      lines.push(`- **${p.pattern_name}** (hits=${p.hits}): ${p.description || "(no description)"}`);
    }
  }
  if (successes.length > 0) {
    lines.push("");
    lines.push("### Past success patterns (confirmation patterns — known good approaches)");
    for (const p of successes) {
      lines.push(`- **${p.pattern_name}** (hits=${p.hits}): ${p.description || "(no description)"}`);
    }
  }
  lines.push("");
  lines.push("How to use:");
  lines.push("- Failure dictionary: prioritize checking whether the agent's diff matches a past cheat pattern");
  lines.push("- Success dictionary: if the agent took a similar approach, reuse the same name in the confirmation insight");
  lines.push("- For new patterns, name preempt_hint.pattern_name in snake_case, distinct from existing names");
  return lines.join("\n");
}
