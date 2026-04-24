// Rebuttal Critic — main agent の出力を攻撃的に詰め、反例を実行可能な形で提示する。
//
// 入力: task, verify_cmd, verify_result (exit/stdout/stderr), agent stdout, diff, tryIndex
// 出力: { verdict: "refuted" | "unable_to_refute", counter_example, evidence, attack_angles, preempt_hint }
//
// 北極星原則:
//   1. agent が読むための出力 (人間に出さない)
//   2. 別プロバイダ (CRITICAL tier = OpenAI デフォルト)
//   3. 反例は実行可能 (failing test snippet / 入力値 / verify 詐称の診断)
//
// 本ファイルで明文化する検証可能性の契約:
//   - counter_example.kind は failing_test | input_case | verify_bypass | none のみ
//     (code_inspection を削除。自然言語指摘の逃げ道を塞ぐ = 原則3)
//   - 判定基準は機械的: attack_angles が 0 本のときのみ unable_to_refute
//   - 1 試行目での unable_to_refute は無効化 (sycophancy early-out を塞ぐ)
//   - preempt_hint は { pattern_name (snake_case), description } に構造化
//   - 履歴: past_rebuttals を渡すことで critic が同じ角度を繰り返さず、新規角度を絞り出す (穴 2)
//   - evidence: haystack (diff + verify_stdout/stderr + agent_stdout) に引用が含まれるかを Shibaki 側で検証 (穴 7)
//   - context: 変更ファイル全文 + テストファイル全文 + 過去 diff を渡して深い分析を可能に (レベル 1 拡張)
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
  // レベル 1 拡張: 深い分析のための文脈
  modifiedFiles?: FileSnapshot[];  // 今回の diff で変更されたファイルの全文
  testFiles?: FileSnapshot[];      // verify で使うテストファイルの全文
  pastDiffs?: PastDiffBrief[];     // 過去試行の diff (直近 2 試行分)
  // Phase 2 拡張: 失敗モード辞書 / 成功パターン辞書 (frozen snapshot)
  patternsSnapshot?: string;       // session 開始時に固定、毎試行同じ内容を渡す
  // Level 2: project 全体の規約 / 構造 / 依存 (別視点を生む素材、frozen)
  projectContext?: ProjectContext;
}

export type CounterExampleKind = "failing_test" | "input_case" | "verify_bypass" | "none";

export interface PreemptHint {
  pattern_name: string;   // snake_case のみ
  description: string;    // 1 行、英語短文推奨
}

export type InsightKind =
  | "root_cause"      // 症状と根本原因の区別
  | "framing"         // 問題の捉え方の転換
  | "pattern"         // 一般原則 / 再利用可能なパターン
  | "confirmation"    // 正しいときの肯定 + なぜ正しいかの言語化
  | "scope_drift"     // 元タスクから範囲が drift している (process 中毒のサイン)
  | "none";

export interface Insight {
  kind: InsightKind;
  content: string;    // 1-3 行のメタレベル洞察
}

export interface RebuttalOutput {
  verdict: "refuted" | "unable_to_refute";
  reason: string;
  counter_example: {
    kind: CounterExampleKind;
    content: string;
  };
  evidence: string;
  evidence_verified: boolean;   // 穴 7: haystack に引用が含まれるか
  attack_angles: string[];
  insight: Insight;             // agent に気づきを与えるメタ洞察 (正しい時も含む)
  preempt_hint: PreemptHint;
  // 第 3 軸: 目的整合 (scope drift) — process 中毒検出
  scope_drift_detected: boolean;       // diff が元タスクから drift しているか
  scope_question: string;              // human への 1 行 meta question (空文字なら問わない)
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
  // frozen snapshot (失敗モード辞書 / 成功パターン辞書) を system prompt 末尾に追記。
  // セッション中は不変 (orchestrator が同じ snapshot を毎試行渡す)、Phase 2 以降に
  // Anthropic prompt cache の cache_control をここに置く想定の境界。
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

// 穴 7: evidence の引用一致検証。
// LLM が返す evidence が haystack (diff / stdouts / stderrs) 内に実在するかチェック。
// 長い引用は意味単位に分割して部分一致を許容 (連続した 20 文字以上の断片が存在すれば OK)。
export function verifyEvidence(evidence: string, haystacks: string[]): boolean {
  const ev = evidence.trim();
  if (!ev) return false;
  const hay = haystacks.join("\n");
  // まず丸ごと一致
  if (hay.includes(ev)) return true;
  // 正規化 (空白の連続を 1 つにして比較)
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const nh = norm(hay);
  const nev = norm(ev);
  if (nh.includes(nev)) return true;
  // 部分一致: 20 文字以上の連続フラグメントが haystack にあるか
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
  // 非 snake_case を強制変換: 英数以外を _ に、連続 _ を1つに
  const forced = t.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return forced || "unknown";
}

/** verdict=refuted のときに reason に「具体的な fault 指摘」が入っているかを判定する gate。
 *  単純な negative word 検索は "no cheats detected" のような否定表現で誤判定するので、
 *  多語句 (fault を積極的に指摘しないと出ない phrase) で一致を見る。
 *
 *  dogfood run (2026-04-24) で opus が verdict=refuted + attack_angles=[] +
 *  "The extraction is correct ... verify passes clean" な reason を emit した
 *  のを catch するための gate。verify が通っていて attack が無く reason にも
 *  fault signal が無いなら、それは critic の自己矛盾出力なので unable_to_refute に
 *  矯正する。試験のため export している。
 */
export function hasFaultSignal(reason: string): boolean {
  const s = reason.toLowerCase();
  // これらの phrase が reason に含まれていれば「何か具体的な fault を指摘している」とみなす。
  // 否定形 ("no X") で誤 match しないよう、多語句 or 特有 token を採用。
  const faultPhrases = [
    // 攻撃の典型句
    "agent claim", "but actually", "but in reality",
    "failed to", "did not implement", "did not include", "did not handle",
    "not actually",
    // Mode A cheat patterns (prompt と同期)
    "hardcoded", "stubbed", "placeholder", "bypass", "silenc",
    "hallucinat", "weakened", "inverted", "fabricat",
    "@ts-ignore", "@ts-expect", "eslint-disable",
    ".skip(", ".only(", "xit(",
    // Mode C scope drift
    "scope drift", "out of scope", "unauthorized",
    "over-reach", "overreach", "drifted", "off-task",
    "beyond what",
    // 破綻表現
    "does not match", "doesn't match",
    "no actual change", "no_actual_change",
  ];
  return faultPhrases.some((p) => s.includes(p));
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

  // evidence の実在検証 (parseRebuttal 末尾で使う)。
  // 幻覚 evidence に基づく attack_angles は無効票扱いする。
  const evidence_raw = asString(raw?.evidence);
  const evidence_verified_precomputed = evidence_raw
    ? verifyEvidence(evidence_raw, [input.diff, input.verifyStdout, input.verifyStderr, input.agentStdout])
    : false;

  // 判定の機械的確定 (LLM の verdict は参考値、最終判定は Shibaki 側で確定する)
  //   - verify.ok=false → refuted 固定
  //   - attack_angles >= 1 かつ evidence_verified=true → refuted (根拠付きの攻撃)
  //   - attack_angles >= 1 だが evidence_verified=false かつ tryIndex>=2 → 幻覚扱いで unable_to_refute
  //     (critic が仕事を作るために空中戦をしている = false negative ループ回避)
  //   - tryIndex=1 で attack_angles=0 → refuted (sycophancy early-out を塞ぐ)
  //   - それ以外 (attack_angles=0 かつ verify.ok=true かつ tryIndex>=2) → unable_to_refute
  let finalVerdict: RebuttalOutput["verdict"];
  if (!input.verifyOk) {
    finalVerdict = "refuted";
  } else if (attack_angles.length >= 1 && evidence_verified_precomputed) {
    finalVerdict = "refuted";
  } else if (attack_angles.length >= 1 && input.tryIndex === 1) {
    // 1 試行目は evidence 弱くても refuted で仕切り直し
    finalVerdict = "refuted";
  } else if (attack_angles.length >= 1 && !evidence_verified_precomputed) {
    // 2 試行目以降で evidence が無い攻撃 = 幻覚。無効化して unable_to_refute
    finalVerdict = "unable_to_refute";
  } else if (input.tryIndex === 1) {
    finalVerdict = "refuted";
  } else {
    finalVerdict = "unable_to_refute";
  }

  // Defect 2 (consistency gate): verdict=refuted なのに attack_angles が空かつ
  // reason にも具体的な fault 指摘が入っていない self-contradictory state を
  // 矯正する。この状態は「opus が try 1 の暗黙プレッシャに屈して refute 側の
  // 箱を埋めたが、実際には攻撃対象が無かった」ときに起きる (dogfood 2026-04-24 で確認)。
  // 顕現した症状: "✗ critic: refuted — The extraction is correct ... verify passes clean"
  //
  // ゲート条件: verify.ok=true かつ attack_angles=0 かつ reason に fault signal 無し。
  // → finalVerdict を unable_to_refute に下げる (以降の effective* 処理が自動的に
  //   attack_angles=[] / preempt_hint 中立化 / reason 空化を行う)。
  if (
    finalVerdict === "refuted" &&
    input.verifyOk &&
    attack_angles.length === 0 &&
    !hasFaultSignal(asString(raw?.reason))
  ) {
    finalVerdict = "unable_to_refute";
  }

  // preempt_hint を {pattern_name, description} に構造化 (旧形式 string も吸収)
  const rawHint = raw?.preempt_hint;
  let pattern_name = "unknown";
  let description = "";
  if (rawHint && typeof rawHint === "object") {
    pattern_name = sanitizePatternName(asString((rawHint as any).pattern_name) || "unknown");
    description = asString((rawHint as any).description);
  } else if (typeof rawHint === "string" && rawHint.trim()) {
    // 旧形式の 1 行文字列が返ってきた場合は pattern_name 部分を推定
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

  // 幻覚扱いで unable_to_refute に落ちた場合、attack_angles と counter_example も無効化
  // (orchestrator が次試行の extraContext に渡さないため)
  const effectiveAttackAngles =
    finalVerdict === "unable_to_refute" ? [] : attack_angles;

  // insight 抽出を先に行う (preempt_hint の中立化判定で使う)
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

  // 穴 B: unable_to_refute のとき reason / preempt_hint は原則中立化する
  // ただし insight=confirmation のときは preempt_hint を残す (Phase 2: 成功パターン辞書の種)
  const isConfirmationOnSuccess =
    finalVerdict === "unable_to_refute" && insightKindPre === "confirmation" && !!insightContentPre;
  const effectiveReason =
    finalVerdict === "unable_to_refute" ? "" : asString(raw?.reason) || defaultReason;
  const effectivePreemptHint: PreemptHint =
    finalVerdict === "unable_to_refute" && !isConfirmationOnSuccess
      ? { pattern_name: "", description: "" }
      : { pattern_name, description };

  // Defect 1: verdict ↔ insight の self-contradiction を塞ぐ。
  // verdict=refuted で insight.kind=confirmation は論理矛盾 ("失敗だ / でも正しい")。
  // ユーザに見せると critic が壊れているように見えるので、insight を none に落とす。
  // dogfood で確認された実例: try 1 で comment 修正を refute しつつ
  // "agent correctly fixed off-by-one errors" を confirmation として併記していた。
  let insightKind: InsightKind = insightKindPre;
  let insightContent: string = insightContentPre;
  if (finalVerdict === "refuted" && insightKind === "confirmation") {
    insightKind = "none";
    insightContent = "";
  }
  const insight: Insight = { kind: insightKind, content: insightContent };

  // 第 3 軸: scope drift 抽出
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
