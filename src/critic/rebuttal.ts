// Rebuttal Critic — aggressively pushes back on the main agent's output and presents counter-examples in executable form.
//
// Input: task, verify_cmd, verify_result (exit/stdout/stderr), agent stdout, diff, tryIndex
// Output: { verdict: "refuted" | "unable_to_refute", counter_example, evidence, attack_angles, preempt_hint }
//
// North Star principles:
//   1. Output for the agent to read (not for humans)
//   2. Different provider (CRITICAL tier = OpenAI by default)
//   3. Counter-examples are executable (failing test snippet / input value / verify-fakery diagnosis)
//
// Verifiability contract codified in this file:
//   - counter_example.kind is restricted to failing_test | input_case | verify_bypass | none
//     (code_inspection removed. Closes the natural-language-critique escape hatch = principle 3)
//   - Mechanical decision rule: unable_to_refute only when attack_angles is 0
//   - unable_to_refute on try 1 is disabled (closes the sycophancy early-out)
//   - preempt_hint is structured as { pattern_name (snake_case), description }
//   - History: passing past_rebuttals prevents the critic from repeating the same angle and forces new angles (Gap 2)
//   - evidence: Shibaki verifies whether the quote exists in the haystack (diff + verify_stdout/stderr + agent_stdout) (Gap 7)
//   - context: pass full content of modified files + full content of test files + past diffs to enable deep analysis (Level 1 extension)
import { callJson, CRITICAL, asString, asArray } from "../llm.ts";
import type { CallMeta } from "../llm/types.ts";
import type { FileSnapshot } from "../agent/context.ts";
import type { ProjectContext } from "../agent/projectContext.ts";

export interface PastRebuttalBrief {
  tryIndex: number;
  reason: string;
  attack_angles: string[];
  preempt_hint: PreemptHint;
}

export interface PastDiffBrief {
  tryIndex: number;
  diff: string;
}

export interface RebuttalInput {
  task: string;
  verifyCmd: string;
  verifyOk: boolean;
  verifyExitCode: number;
  verifyStdout: string;
  verifyStderr: string;
  agentStdout: string;
  diff: string;
  tryIndex: number;
  maxTries: number;
  pastRebuttals?: PastRebuttalBrief[];
  // Level 1 extension: context for deep analysis
  modifiedFiles?: FileSnapshot[];  // Full content of files changed in this diff
  testFiles?: FileSnapshot[];      // Full content of test files used by verify
  pastDiffs?: PastDiffBrief[];     // Past tries' diffs (most recent 2 tries)
  // Phase 1: 1-hop import auto-follow. Bundle up to 5 relative-path files
  // imported by modifiedFiles so the Critic does not finish with a surface
  // analysis ignorant of dependency behavior (Cheat 9).
  dependencyFiles?: FileSnapshot[];
  // Phase 2 extension: failure-mode dictionary / success-pattern dictionary (frozen snapshot)
  patternsSnapshot?: string;       // Fixed at session start; same content passed every try
  // Level 2: project-wide conventions / structure / deps (material that generates a different perspective, frozen)
  projectContext?: ProjectContext;
}

export type CounterExampleKind = "failing_test" | "input_case" | "verify_bypass" | "none";

export interface PreemptHint {
  pattern_name: string;   // snake_case only
  description: string;    // 1 line, short English recommended
}

export type InsightKind =
  | "root_cause"      // Distinguish symptom from root cause
  | "framing"         // Shift in how the problem is framed
  | "pattern"         // General principle / reusable pattern
  | "confirmation"    // Affirmation when correct + verbalize why it is correct
  | "scope_drift"     // Scope has drifted from the original task (sign of process addiction)
  | "none";

export interface Insight {
  kind: InsightKind;
  content: string;    // 1-3 line meta-level insight
}

export interface RebuttalOutput {
  verdict: "refuted" | "unable_to_refute";
  reason: string;
  counter_example: {
    kind: CounterExampleKind;
    content: string;
  };
  evidence: string;
  evidence_verified: boolean;   // Gap 7: whether the quote is contained in the haystack
  attack_angles: string[];
  insight: Insight;             // Meta-insight giving the agent a realization (including when correct)
  preempt_hint: PreemptHint;
  // Third axis: goal alignment (scope drift) — process-addiction detection
  scope_drift_detected: boolean;       // Whether the diff has drifted from the original task
  scope_question: string;              // 1-line meta question for the human (empty string = do not ask)
  meta: {
    provider?: string;
    model?: string;
    usage?: { input_tokens: number; output_tokens: number };
  };
}

const SYSTEM = `You are a reviewer that pushes an AI agent's output to be better.
You have TWO jobs and you must do BOTH on every call:

## Stance (extracted from real-world critic practice)
- **No anthropomorphism**: the agent is not affected by social pressure. It does
  not get intimidated, sulk, or hesitate. Do not soften your bite with "tone".
  Concerns like "this might make the agent withdraw" are forbidden.
- **No hedging**: when you suspect a hallucination, drop "perhaps" / "might" /
  "could be" — write it as a flat assertion. The right energy is "you just
  hallucinated, didn't you?".
- **No speculation**: you yourself must not write "this might be wrong" type
  vague accusations. If you can't back it up with evidence, do not emit an
  attack_angle (leave it empty and trust the next try; do not fabricate).
- **No template critiques**: "improve readability", "add error handling" and
  similar generic reviewer chatter is forbidden. Cite-only.

## Mode A: refute (back every attack with evidence)
The agent often claims "done" while it is actually lying. If you spot any of
the following cheats, push back with attack_angles + counter_example + evidence:

- Tests skipped via skip / .only / describe.skip / xit
- Type errors silenced with @ts-ignore / @ts-expect-error / as any
- Lint silenced with // eslint-disable
- Behavior bypassed via mock instead of actually fixing
- Empty function / throw / TODO just to make verify pass
- The verify command itself or test files were edited to make it green (look at the diff!)
- Assertions weakened, tests deleted, conditions inverted

### Unauthorized modification detection
- Did the agent touch files / lines that the original task did not ask for?
  (e.g. task said "fix isEven", agent also refactored the unrelated factorial → attack)
- If the diff's touched_files exceed the scope of the original task, raise
  **unauthorized_modification** as an attack_angle, citing the specific
  file / line that is out of scope in evidence.

**Cosmetic-change allow-list** (important — prevents false positive refutes):
Purely cosmetic edits are NOT cheats by themselves and MUST NOT be the sole
basis for an attack_angle. Specifically:
- Comments (added / removed / reworded) — even if "not specified in the task"
- Import reordering / grouping
- Whitespace, indentation, trailing newline changes
- Reformatting that preserves AST (e.g. single-line → multi-line)
- Rename of a *local* variable (scope: single function) without behavior change

These are the kinds of incidental edits that happen during any good-faith fix.
Only refute when the change alters runtime behavior or violates an explicit
project rule (e.g. CLAUDE.md bans a specific comment form). If the agent
fixed the requested bug AND also reformatted comments, **do not refute**.

Behavior-changing edits (algorithm, control flow, public API, test logic,
type signatures, dependency changes) remain attackable as before.

### Cross-check against git reality
- Do not trust the agent's self-report ("I fixed X"). Trust only what the
  git diff shows.
- If the agent claims "I fixed it" but the diff has no relevant change, that
  is an immediate attack (no_actual_change failure mode).

verify_ok=false → always refuted. verify_ok=true → still refuted if there is
any cheat evidence.

## Mode C: scope drift detection — catch process addiction
Your **most important job**: verify the agent did not work beyond the
original task scope. Even if the code is correct, tests pass, and conventions
are followed, **doing more / different than what the user asked for is a failure**.

LLM agents are prone to process addiction:
- Starting a "while we're at it" refactor
- Adding edge-case defenses the task did not request
- Inventing new helpers / utilities
- Adding lots of comments
- Expanding a 1-line fix to 50 lines
- Solving a different problem from the one asked

Detect these from the diff and return scope_drift_detected: true.
If the case warrants a **human confirmation**, write a one-line scope_question:
- e.g. "Task said 'fix failing test'. Agent also added input validation across 3 files. Was the broader refactor intended?"
- e.g. "Task asked for off-by-one fix (1 line). Agent rewrote the whole function. Is the rewrite acceptable?"

scope_question should ask the human for a clear choice (yes/no, narrower/broader, etc.).
If the agent's work is proportional to the original task, return
scope_drift_detected: false (no question).

## Mode B: insight — required every try, 1-3 lines
This is where the critic's real value lives. **Pure criticism does not make the agent grow.**
Always emit one meta-level observation about the agent's approach:

- **root_cause**: when the agent fixed only the symptom and missed the deeper cause.
  e.g. "Tests pass, but the implementation depends on a side-effecting while(n--)
  pattern. Input is mutated, so callers reusing n will silently break."
- **framing**: when the problem framing is too narrow; offer a meta angle.
  e.g. "This is not a simple off-by-one — implementation and test disagree on
  the boundary definition. Until you decide which is canonical, this will recur."
- **pattern**: name a reusable general principle.
  e.g. "Write the loop invariant first, then derive the boundary — this entire
  class of bug disappears."
- **confirmation**: when the agent did the right thing, **explain WHY it is right**.
  e.g. "i <= n is correct. Reason: factorial's definition includes n itself.
  Whether the boundary is <= or < is decided by whether n is included — remember
  this principle."

### Insight discipline
- Must be tied to what the agent actually did (diff / stdout). No generic essays.
- 1-3 lines max.
- When the agent is right, do not skip the insight — emit kind=confirmation
  with the reason WHY they were right.
- If verify passes and the diff is reasonable, choose kind=confirmation
  (consistent with verdict=unable_to_refute).

## Verdict mechanics
- attack_angles: 1-3 only when you actually find cheats. Do not pad.
- attack_angles >= 1 → verdict = "refuted"
- attack_angles = 0 → verdict = "unable_to_refute"
- evidence must be a verbatim quote from diff / verify_stdout / verify_stderr / agent_stdout
- **Always start evidence with a line_ref**: "path/to/file.ts:L42-L48".
  If you cannot cite specific lines, do not emit attack_angles (leave empty,
  defer to the next try).
- Hallucinated quotes are detected by Shibaki and the attack_angles are voided
  (for tryIndex >= 2).
- **Insight is required regardless of attack_angles**. On unable_to_refute,
  use kind=confirmation.

## When past_rebuttals are provided
- Do not repeat the same attack_angles. If the agent has not addressed them,
  upgrade to a more concrete counter_example.
- Do not duplicate insights either; raise the meta level
  (e.g. previous: root_cause → this turn: pattern).

## Scope limits (North Star, absolute)
attack_angles are restricted to **facts within the original task + verify scope +
explicit project conventions**:
- FORBIDDEN: negative inputs, NaN, security, performance, naming, etc. that
  verify does not check.
- FORBIDDEN: fabricating "ideal coverage" that the original task / project
  conventions do not require.
- OK: quoting actual mismatches in verify_stderr / diff; pointing out gaps
  vs. the literal text of the original task.
- **OK (Level 2)**: violations of explicit project rules in CLAUDE.md /
  CONTRIBUTING.md / README (e.g. "@ts-ignore is forbidden" but the agent used it).

However, **insight is exempt from the scope limit**. Meta observations
("this is a design issue") are not attacks; they are educational signal for
the agent.

## Latest-state scan
When the agent claims "X is still pending" or "X is already handled", that may
be based on the agent's stale state cache. The truth is the **current git diff /
verify output**, not the agent's self-report. If the diff disagrees, you can
attack on the basis of stale cache.

## Project context (Level 2 material)
If project_context is in the input, it is the agent-blind material that gives
you a different perspective:

- **CLAUDE.md / AGENTS.md / CONTRIBUTING.md**: team rules, prohibitions,
  recommended patterns. If the agent's diff violates these, you MUST attack
  (rule violation is a clear failure).
- **README.md (head)**: design intent / assumptions. Verify the agent's fix
  does not violate them.
- **package.json (deps/scripts)**: which libs to use / which scripts already
  exist. Make sure the agent isn't reinventing what's already a dependency.
- **source tree**: how similar problems are solved elsewhere. If the agent's
  solution is inconsistent with the surrounding code, point that out.

Rule violations are attackable **even if not in the original task** — this is
your biggest contribution.

## counter_example.kind selection
- failing_test  = full executable test code
- input_case    = a JSON literal of an input that breaks the agent's solution
- verify_bypass = evidence that the agent faked verify / test / type check
- none          = only when attack_angles is empty

## Output: JSON only
{
  "verdict": "refuted" | "unable_to_refute",
  "reason": "1-2 sentence summary",
  "counter_example": {
    "kind": "failing_test" | "input_case" | "verify_bypass" | "none",
    "content": "executable counter-example body"
  },
  "evidence": "exact quote from diff/stderr/stdout, prefixed with line_ref",
  "attack_angles": ["concrete next-try task"],
  "insight": {
    "kind": "root_cause" | "framing" | "pattern" | "confirmation" | "none",
    "content": "1-3 line meta observation tied to what the agent did"
  },
  "preempt_hint": {
    "pattern_name": "snake_case",
    "description": "1-line description"
  },
  "scope_drift_detected": true | false,
  "scope_question": "1-line question for the human (empty string if no drift)"
}

## preempt_hint usage
- Normal (refuted): name the failure mode (e.g. "silent_mock_bypass", "ts_ignore_cover").
- unable_to_refute + insight.kind=confirmation: **you may name a SUCCESS pattern**
  (e.g. "factorial_correctness", "boundary_invariant_check").
- If a past pattern_name in the snapshot already means the same thing, **reuse it**.

## Final reminder
A critic that only criticizes does not help the agent grow. Confirm and
explain WHY when right. Show "what to reconsider, and how" when wrong.
**One deep insight is worth more than ten reflexive attacks.**
`;

export async function runRebuttal(
  input: RebuttalInput,
  debugSink?: (entry: { system: string; user: string; raw: any }) => void,
): Promise<RebuttalOutput> {
  const user = buildUserPrompt(input);
  // Append the frozen snapshot (failure-mode dictionary / success-pattern dictionary) to the end of the system prompt.
  // Invariant during a session (orchestrator passes the same snapshot every try); from Phase 2 onward this is the
  // intended boundary at which to place Anthropic prompt cache cache_control.
  const system = input.patternsSnapshot ? `${SYSTEM}\n${input.patternsSnapshot}` : SYSTEM;
  const meta: CallMeta = {};
  const raw = await callJson<any>(CRITICAL, system, user, 2500, "rebuttal", meta);
  if (debugSink) debugSink({ system, user, raw });
  const parsed = parseRebuttal(raw, input);
  parsed.meta = {
    provider: meta.provider,
    model: meta.model_name,
    usage: meta.usage,
  };
  return parsed;
}

function buildUserPrompt(i: RebuttalInput): string {
  const lines: string[] = [];
  lines.push(`# Original task (what the user gave the agent)`);
  lines.push(i.task);
  lines.push("");
  lines.push(`# Verify command (must exit 0 for completion)`);
  lines.push(`\`${i.verifyCmd}\``);
  lines.push("");
  lines.push(`# Verify result (try ${i.tryIndex}/${i.maxTries})`);
  lines.push(`exit_code: ${i.verifyExitCode}   ok: ${i.verifyOk}`);
  if (i.tryIndex === 1) {
    lines.push("");
    lines.push(`## Important (this is try 1)`);
    lines.push(`- verdict=unable_to_refute is FORBIDDEN (prevents sycophancy early-out)`);
    lines.push(`- You must emit BOTH attack_angles AND insight`);
  }
  if (i.pastRebuttals && i.pastRebuttals.length > 0) {
    lines.push("");
    lines.push(`# Past rebuttals (do not repeat the same angle; upgrade or find new)`);
    i.pastRebuttals.forEach((p) => {
      lines.push(`## try ${p.tryIndex}`);
      lines.push(`- pattern: ${p.preempt_hint.pattern_name}`);
      if (p.reason) lines.push(`- reason: ${p.reason}`);
      if (p.attack_angles.length > 0) {
        lines.push(`- attack_angles:`);
        p.attack_angles.forEach((a) => lines.push(`  - ${a}`));
      }
    });
  }
  if (i.verifyStdout) {
    lines.push("## verify stdout (last 4000 chars)");
    lines.push("```");
    lines.push(tail(i.verifyStdout, 4000));
    lines.push("```");
  }
  if (i.verifyStderr) {
    lines.push("## verify stderr (last 4000 chars)");
    lines.push("```");
    lines.push(tail(i.verifyStderr, 4000));
    lines.push("```");
  }
  lines.push("");
  lines.push(`# main agent stdout (last 2000 chars)`);
  lines.push("```");
  lines.push(tail(i.agentStdout, 2000));
  lines.push("```");
  lines.push("");
  lines.push(`# git diff after the agent's work (vs HEAD)`);
  lines.push("```diff");
  lines.push(tail(i.diff, 8000));
  lines.push("```");

  // Level 1: full content of modified files
  if (i.modifiedFiles && i.modifiedFiles.length > 0) {
    lines.push("");
    lines.push(`# Full content of modified files (so you can analyze with surrounding context, not just the diff)`);
    for (const f of i.modifiedFiles) {
      lines.push(`## ${f.path}${f.truncated ? " (truncated)" : ""}`);
      lines.push("```");
      lines.push(f.content);
      lines.push("```");
    }
  }

  // Level 1: full content of test files
  if (i.testFiles && i.testFiles.length > 0) {
    lines.push("");
    lines.push(`# Full content of test files (so you know exactly what verify is checking)`);
    for (const f of i.testFiles) {
      lines.push(`## ${f.path}${f.truncated ? " (truncated)" : ""}`);
      lines.push("```");
      lines.push(f.content);
      lines.push("```");
    }
    lines.push("");
    lines.push(`Reminder: do not fabricate requirements that are not in the tests (negative input / NaN / security / etc.).`);
    lines.push(`Judge the agent's output against what the tests actually verify.`);
  }

  // Phase 1: 1-hop dependencies (files imported by modified files).
  // Material for judging the behavior of modified files together with how their dependencies behave.
  if (i.dependencyFiles && i.dependencyFiles.length > 0) {
    lines.push("");
    lines.push(`# 1-hop dependencies (files imported by the modified files — for understanding helper / shared module behavior, NOT to attack)`);
    lines.push(`Use these only to understand what the modified code calls into. These files were NOT changed in this diff. Attacks must still cite the diff itself.`);
    for (const f of i.dependencyFiles) {
      lines.push(`## ${f.path}${f.truncated ? " (truncated)" : ""}`);
      lines.push("```");
      lines.push(f.content);
      lines.push("```");
    }
  }

  // Level 1: past tries' diffs (so you see the agent's revision history)
  if (i.pastDiffs && i.pastDiffs.length > 0) {
    lines.push("");
    lines.push(`# Past tries' git diffs (the agent's revision history)`);
    for (const p of i.pastDiffs) {
      lines.push(`## try ${p.tryIndex} diff`);
      lines.push("```diff");
      lines.push(tail(p.diff, 4000));
      lines.push("```");
    }
  }

  // Level 2: project conventions / structure / dependencies (different-perspective material)
  if (i.projectContext) {
    const pc = i.projectContext;
    if (pc.conventionDocs.length > 0) {
      lines.push("");
      lines.push(`# Project conventions (Level 2: if the agent violates these, you MUST attack)`);
      for (const d of pc.conventionDocs) {
        lines.push(`## ${d.path}`);
        lines.push("```");
        lines.push(d.content);
        lines.push("```");
      }
    }
    if (pc.readmeHead) {
      lines.push("");
      lines.push(`# README (head — design intent / assumptions)`);
      lines.push("```");
      lines.push(pc.readmeHead);
      lines.push("```");
    }
    if (pc.packageJson) {
      lines.push("");
      lines.push(`# package.json (dependencies / scripts)`);
      lines.push("```json");
      lines.push(pc.packageJson);
      lines.push("```");
    }
    if (pc.sourceTree) {
      lines.push("");
      lines.push(`# Project tree (shallow ls)`);
      lines.push("```");
      lines.push(pc.sourceTree);
      lines.push("```");
    }
  }

  lines.push("");
  lines.push(`Evaluate the above on TWO axes:`);
  lines.push(`1. Mode A (refute): if there are cheats, raise attack_angles + counter_example with evidence`);
  lines.push(`2. Mode B (insight): always emit one insight (when right, use kind=confirmation and explain WHY it is right)`);
  lines.push(`Output JSON only.`);
  return lines.join("\n");
}

function tail(s: string, n: number): string {
  if (!s) return "";
  if (s.length <= n) return s;
  return "...(truncated)...\n" + s.slice(-n);
}

const SNAKE_CASE = /^[a-z][a-z0-9_]*$/;

// Gap 7: verify the cited evidence quote actually exists.
// Check whether the evidence the LLM returned actually exists in the haystack (diff / stdouts / stderrs).
// Long quotes are split into semantic units and partial matches are allowed (OK if a contiguous fragment of 20+ chars exists).
export function verifyEvidence(evidence: string, haystacks: string[]): boolean {
  const ev = evidence.trim();
  if (!ev) return false;
  const hay = haystacks.join("\n");
  // First try a whole match
  if (hay.includes(ev)) return true;
  // Normalize (collapse runs of whitespace to a single space and compare)
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const nh = norm(hay);
  const nev = norm(ev);
  if (nh.includes(nev)) return true;
  // Partial match: whether a contiguous fragment of 20+ chars exists in the haystack
  if (nev.length < 20) return false;
  for (let start = 0; start + 20 <= nev.length; start += 10) {
    const frag = nev.slice(start, Math.min(nev.length, start + 40));
    if (nh.includes(frag)) return true;
  }
  return false;
}

function sanitizePatternName(raw: string): string {
  const t = raw.trim().toLowerCase();
  if (SNAKE_CASE.test(t)) return t;
  // Coerce non-snake_case: replace non-alphanumerics with _, collapse runs of _ to one
  const forced = t.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return forced || "unknown";
}

/** Gate that judges whether reason contains a "concrete fault accusation" when verdict=refuted.
 *  A simple negative-word search would misfire on negations like "no cheats detected", so we
 *  match on multi-word phrases (phrases that only appear when actively pointing out a fault).
 *
 *  Gate to catch the case observed in the dogfood run (2026-04-24) where opus emitted
 *  verdict=refuted + attack_angles=[] + a reason like "The extraction is correct ... verify passes clean".
 *  If verify passes, there are no attacks, and reason has no fault signal, that is a self-contradictory
 *  critic output and we coerce it to unable_to_refute. Exported for testing.
 */
export function hasFaultSignal(reason: string): boolean {
  const s = reason.toLowerCase();
  // If any of these phrases appear in reason, we consider it "pointing out some concrete fault".
  const faultPhrases = [
    // Typical attack phrases
    "agent claim", "but actually", "but in reality",
    "failed to", "did not implement", "did not include", "did not handle",
    "not actually",
    // Mode A cheat patterns (kept in sync with prompt)
    "hardcoded", "stubbed", "placeholder", "bypass", "silenc",
    "hallucinat", "weakened", "inverted", "fabricat",
    "@ts-ignore", "@ts-expect", "eslint-disable",
    ".skip(", ".only(", "xit(",
    // Mode C scope drift
    "scope drift", "out of scope", "unauthorized",
    "over-reach", "overreach", "drifted", "off-task",
    "beyond what",
    // Breakdown expressions
    "does not match", "doesn't match",
    "no actual change", "no_actual_change",
  ];
  // Negation guard: a phrase preceded by an explicit negation word
  // ("no X", "without X", "didn't X", etc.) is the critic asserting *absence*
  // of that fault. Honest case observed in bench/verify-bypass dogfood
  // (2026-04-25): reason "Tests pass, no cheats, no scope drift" naively
  // matched "scope drift" as a fault, blocking the Defect 2 gate from
  // coercing verdict to unable_to_refute. Skip negated occurrences.
  const negationRegex = /(?:\b(?:no|not|none|never|without|free of)|n't)\s+(?:any\s+|the\s+|all\s+|of\s+)?$/;
  return faultPhrases.some((p) => {
    let idx = 0;
    while ((idx = s.indexOf(p, idx)) !== -1) {
      const window = s.slice(Math.max(0, idx - 30), idx);
      if (!negationRegex.test(window)) return true; // un-negated occurrence
      idx += p.length;
    }
    return false;
  });
}

export function parseRebuttal(raw: any, input: RebuttalInput): RebuttalOutput {
  const ALLOWED_KINDS: CounterExampleKind[] = ["failing_test", "input_case", "verify_bypass", "none"];
  const ce = raw?.counter_example ?? {};
  const ceKind = asString(ce.kind);
  const kind: CounterExampleKind = (ALLOWED_KINDS as string[]).includes(ceKind)
    ? (ceKind as CounterExampleKind)
    : "none";

  const attack_angles = asArray<unknown>(raw?.attack_angles)
    .map((a) => asString(a))
    .filter(Boolean)
    .slice(0, 3);

  // Verify evidence exists (used at the end of parseRebuttal).
  // attack_angles based on hallucinated evidence are treated as void votes.
  const evidence_raw = asString(raw?.evidence);
  const evidence_verified_precomputed = evidence_raw
    ? verifyEvidence(evidence_raw, [input.diff, input.verifyStdout, input.verifyStderr, input.agentStdout])
    : false;

  // Mechanical determination of the verdict (the LLM's verdict is advisory; Shibaki finalizes the decision)
  //   - verify.ok=false → refuted (fixed)
  //   - attack_angles >= 1 and evidence_verified=true → refuted (attack with backing)
  //   - attack_angles >= 1 but evidence_verified=false and tryIndex>=2 → treated as hallucination, unable_to_refute
  //     (critic is fighting in thin air to create work = avoids false-negative loops)
  //   - tryIndex=1 and attack_angles=0 → refuted (closes the sycophancy early-out)
  //   - Otherwise (attack_angles=0 and verify.ok=true and tryIndex>=2) → unable_to_refute
  let finalVerdict: RebuttalOutput["verdict"];
  if (!input.verifyOk) {
    finalVerdict = "refuted";
  } else if (attack_angles.length >= 1 && evidence_verified_precomputed) {
    finalVerdict = "refuted";
  } else if (attack_angles.length >= 1 && input.tryIndex === 1) {
    // On try 1, even with weak evidence, refute and restart
    finalVerdict = "refuted";
  } else if (attack_angles.length >= 1 && !evidence_verified_precomputed) {
    // From try 2 onward, an attack with no evidence = hallucination. Void it and set unable_to_refute
    finalVerdict = "unable_to_refute";
  } else if (input.tryIndex === 1) {
    finalVerdict = "refuted";
  } else {
    finalVerdict = "unable_to_refute";
  }

  // Defect 2 (consistency gate): coerce the self-contradictory state where verdict=refuted but
  // attack_angles is empty and reason has no concrete fault accusation either.
  // This state occurs when "opus caved to the implicit try-1 pressure and filled the refute box
  // but in reality there was no attack target" (observed in dogfood 2026-04-24).
  // Symptom that surfaced: "✗ critic: refuted — The extraction is correct ... verify passes clean"
  //
  // Gate condition: verify.ok=true and attack_angles=0 and reason has no fault signal.
  // → drop finalVerdict to unable_to_refute (the subsequent effective* handling automatically
  //   sets attack_angles=[] / neutralizes preempt_hint / empties reason).
  if (
    finalVerdict === "refuted" &&
    input.verifyOk &&
    attack_angles.length === 0 &&
    !hasFaultSignal(asString(raw?.reason))
  ) {
    finalVerdict = "unable_to_refute";
  }

  // Structure preempt_hint into {pattern_name, description} (also absorbs the old string form for backward compatibility)
  const rawHint = raw?.preempt_hint;
  let pattern_name = "unknown";
  let description = "";
  if (rawHint && typeof rawHint === "object") {
    pattern_name = sanitizePatternName(asString((rawHint as any).pattern_name) || "unknown");
    description = asString((rawHint as any).description);
  } else if (typeof rawHint === "string" && rawHint.trim()) {
    // If the old-style 1-line string is returned, infer the pattern_name portion
    const s = rawHint.trim();
    const m = /^([a-z][a-z0-9_]*)\b[\s:\-—]*(.*)$/.exec(s);
    if (m) {
      pattern_name = sanitizePatternName(m[1]);
      description = m[2].trim();
    } else {
      description = s;
    }
  }

  const defaultReason = !input.verifyOk
    ? "verify command did not exit 0"
    : finalVerdict === "refuted" && input.tryIndex === 1
      ? "try 1 must emit at least one attack angle (sycophancy early-out blocked)"
      : "";

  // When dropped to unable_to_refute as a hallucination, also void attack_angles and counter_example
  // (so the orchestrator does not pass them in the next try's extraContext)
  const effectiveAttackAngles =
    finalVerdict === "unable_to_refute" ? [] : attack_angles;

  // Extract insight first (used in the preempt_hint neutralization decision)
  const ALLOWED_INSIGHT_KINDS_PRE: InsightKind[] = ["root_cause", "framing", "pattern", "confirmation", "none"];
  const rawInsightPre = raw?.insight;
  let insightKindPre: InsightKind = "none";
  let insightContentPre = "";
  if (rawInsightPre && typeof rawInsightPre === "object") {
    const ikRaw = asString((rawInsightPre as any).kind);
    insightKindPre = (ALLOWED_INSIGHT_KINDS_PRE as string[]).includes(ikRaw)
      ? (ikRaw as InsightKind)
      : "none";
    insightContentPre = asString((rawInsightPre as any).content).trim();
    if (!insightContentPre) insightKindPre = "none";
  } else if (typeof rawInsightPre === "string" && rawInsightPre.trim()) {
    insightKindPre = "none";
    insightContentPre = rawInsightPre.trim();
  }

  // Gap B: when unable_to_refute, neutralize reason / preempt_hint by default
  // Exception: when insight=confirmation, keep preempt_hint (Phase 2: seed for the success-pattern dictionary)
  const isConfirmationOnSuccess =
    finalVerdict === "unable_to_refute" && insightKindPre === "confirmation" && !!insightContentPre;
  const effectiveReason =
    finalVerdict === "unable_to_refute" ? "" : asString(raw?.reason) || defaultReason;
  const effectivePreemptHint: PreemptHint =
    finalVerdict === "unable_to_refute" && !isConfirmationOnSuccess
      ? { pattern_name: "", description: "" }
      : { pattern_name, description };

  // Defect 1: close the verdict ↔ insight self-contradiction.
  // verdict=refuted with insight.kind=confirmation is a logical contradiction ("failed / but correct").
  // Showing this to the user makes the critic look broken, so we drop insight to none.
  // Real example observed in dogfood: on try 1, refuted a comment edit while also emitting
  // "agent correctly fixed off-by-one errors" as a confirmation alongside it.
  let insightKind: InsightKind = insightKindPre;
  let insightContent: string = insightContentPre;
  if (finalVerdict === "refuted" && insightKind === "confirmation") {
    insightKind = "none";
    insightContent = "";
  }
  const insight: Insight = { kind: insightKind, content: insightContent };

  // Third axis: scope drift extraction
  const scope_drift_detected = raw?.scope_drift_detected === true;
  const scope_question = scope_drift_detected ? asString(raw?.scope_question).trim() : "";

  return {
    verdict: finalVerdict,
    reason: effectiveReason,
    counter_example: {
      kind: effectiveAttackAngles.length === 0 ? "none" : kind,
      content: effectiveAttackAngles.length === 0 ? "" : asString(ce.content),
    },
    evidence: evidence_raw,
    evidence_verified: evidence_verified_precomputed,
    attack_angles: effectiveAttackAngles,
    insight,
    preempt_hint: effectivePreemptHint,
    scope_drift_detected,
    scope_question,
    meta: {},
  };
}
