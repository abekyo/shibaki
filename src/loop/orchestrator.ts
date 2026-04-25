// Closed-loop core: main agent → verify → rebuttal → (retry if refuted).
//
// Surface the critic's verdict to stderr on every try (transparency first).
// Necessary and sufficient condition for completion: verify.exit === 0 and rebuttal.verdict === "unable_to_refute".
import type { RunArgs } from "../cli/args.ts";
import { runMainAgent, killAllChildren } from "../agent/mainAgent.ts";
import { runVerify } from "../agent/verify.ts";
import { runRebuttal, type PastRebuttalBrief, type PastDiffBrief } from "../critic/rebuttal.ts";
import { estimateCostUsd } from "../llm/cost.ts";
import { newBudget, checkBudget, budgetSummary } from "./budget.ts";
import { openDebugLog, NULL_LOGGER, type DebugLogger } from "./debugLog.ts";
import { collectContextFiles } from "../agent/context.ts";
import { collectProjectContext } from "../agent/projectContext.ts";
import {
  loadPatterns,
  savePatterns,
  mergeObservation,
  prunePatterns,
  defaultPatternsPath,
  type Pattern,
} from "../memory/patterns.ts";
import { buildPatternsSnapshot } from "../memory/snapshot.ts";
import { red, green } from "../cli/colors.ts";

export interface LoopResult {
  ok: boolean;
  tries: number;
  elapsedSec: number;
  costUsd: number;
  pattern_name?: string;
}

export async function runLoop(args: RunArgs): Promise<LoopResult> {
  const cfg = {
    maxTries: args.maxTries,
    timeoutMs: args.timeoutSec * 1000,
  };
  const budget = newBudget(cfg);

  const debugLog: DebugLogger = args.debug
    ? await openDebugLog(process.cwd())
    : NULL_LOGGER;
  // --quiet (CI / scripting): suppress per-try progress markers, spinner, and
  // critic dialog. The final ✓/✗ summary, preflight failures, retry warnings,
  // and human meta-question prompts (--ask-human) are always shown.
  if (!args.quiet) {
    if (args.debug) {
      progress(`▶ task accepted (verify: ${args.verify}) [debug: ${debugLog.path}]`);
    } else {
      progress(`▶ task accepted (verify: ${args.verify})`);
    }
  }
  await debugLog.write("start", { task: args.task, verify: args.verify, agent: args.agent, cfg });

  let extraContext: string | undefined;
  let lastPreemptHint = "";
  const pastRebuttals: PastRebuttalBrief[] = [];
  const pastDiffs: PastDiffBrief[] = [];

  // Phase 2: load failure-mode and success-pattern dictionaries at session start.
  // Immutable for the rest of the session (frozen snapshot semantics).
  const patternsPath = defaultPatternsPath();
  const loadedPatterns = await loadPatterns(patternsPath);
  const patternsSnapshot = buildPatternsSnapshot(loadedPatterns);
  const observedPatterns: { type: "failure" | "success"; pattern_name: string; description: string }[] = [];

  // Level 2: project conventions / structure / dependencies (frozen, material from a different angle than the agent's).
  const projectContext = await collectProjectContext(process.cwd());

  // Minimum guarantee on Ctrl-C / SIGTERM: write observedPatterns back to the dictionary before exit.
  // The patterns dictionary is the core of cross-session learning, so heavy users who
  // bail on long runs still get the "learning is preserved" experience.
  // Double-press = hard exit (escape hatch for impatient users).
  const cleanupSignal = installInterruptHandler(patternsPath, loadedPatterns, observedPatterns);

  try {
  while (true) {
    const breach = checkBudget(budget, cfg);
    if (breach) {
      const s = budgetSummary(budget);
      await debugLog.write("escalate", { breach, ...s, pattern_name: lastPreemptHint || "unknown" });
      escalate(s.tries, s.elapsedSec, breach, lastPreemptHint || "unknown");
      // Even on failure, push observed failure patterns into the dictionary (useful for next preempt)
      await persistObservedPatterns(patternsPath, loadedPatterns, observedPatterns);
      return { ok: false, tries: s.tries, elapsedSec: s.elapsedSec, costUsd: s.costUsd, pattern_name: lastPreemptHint || "unknown" };
    }

    budget.tries += 1;
    if (!args.quiet) progress(`▶ try ${budget.tries}/${cfg.maxTries}`);

    // 1. run the main agent — spinner suppressed in quiet mode (NULL_TICKER no-ops both start/stop)
    const agentTick = args.quiet
      ? NULL_TICKER
      : phaseTicker("agent working", { expectedRange: "20-60s" });
    const agent = await runMainAgent({
      agentCmd: args.agent,
      task: args.task,
      extraContext,
      timeoutMs: Math.max(60_000, cfg.timeoutMs - (Date.now() - budget.startedAt)),
    });
    agentTick.stop();

    // 2. verify
    const verify = await runVerify(args.verify);

    // 3. Level 1 expansion: collect context files for deeper analysis
    const contextFiles = await collectContextFiles({
      cwd: process.cwd(),
      diff: agent.diff,
      verifyCmd: args.verify,
      maxFiles: 8,
      maxBytesPerFile: 20_000,
    });

    // 4. rebuttal (critic) — spinner suppressed in quiet mode
    const criticTick = args.quiet
      ? NULL_TICKER
      : phaseTicker("critic deliberating", { expectedRange: "30-90s" });
    let criticDebug: { system: string; user: string; raw: any } | null = null;
    const rebuttal = await runRebuttal(
      {
        task: args.task,
        verifyCmd: args.verify,
        verifyOk: verify.ok,
        verifyExitCode: verify.exitCode,
        verifyStdout: verify.stdout,
        verifyStderr: verify.stderr,
        agentStdout: agent.stdout,
        diff: agent.diff,
        tryIndex: budget.tries,
        maxTries: cfg.maxTries,
        pastRebuttals: pastRebuttals.slice(-5),  // last 5 tries only (prevent context bloat)
        modifiedFiles: contextFiles.modifiedFiles,
        testFiles: contextFiles.testFiles,
        dependencyFiles: contextFiles.dependencyFiles,  // Phase 1: 1-hop import expansion
        pastDiffs: pastDiffs.slice(-2),  // last 2 tries' diffs (agent's change history)
        patternsSnapshot,                  // immutable for the session (frozen)
        projectContext,                    // Level 2: material from a different angle (frozen)
      },
      args.debug ? (e) => { criticDebug = e; } : undefined,
    );
    criticTick.stop();

    // accumulate cost
    if (rebuttal.meta.usage && rebuttal.meta.model) {
      budget.costUsd += estimateCostUsd(
        rebuttal.meta.model,
        rebuttal.meta.usage.input_tokens,
        rebuttal.meta.usage.output_tokens,
      );
    }

    // Show the critic's verdict to the user. Principle 1 (= hide introspection) has been retracted:
    // the critic is the core value, but if it's invisible the user can't judge "was it useful",
    // so the run looks like a black box that just costs more.
    // --quiet suppresses the per-try dialog (CI / scripting) — the final summary line still fires.
    if (!args.quiet) printCriticVerdict(rebuttal);

    if (rebuttal.preempt_hint.pattern_name && rebuttal.preempt_hint.pattern_name !== "unknown") {
      lastPreemptHint = rebuttal.preempt_hint.pattern_name;
    }

    // Phase 2: persisting to the dictionary is quality-gated.
    //
    // Only record a failure pattern when there is real evidence of failure:
    //   - verify.ok=false (verify itself failed = objective failure), or
    //   - verdict=refuted AND evidence_verified=true (quote-verified real critique)
    // Exclude patterns that became refuted only due to forced refuted at tryIndex=1 with no evidence
    // (admitting these would let hallucinated patterns pollute the dictionary).
    const isGenuineFailure =
      !verify.ok ||
      (rebuttal.verdict === "refuted" && rebuttal.evidence_verified && rebuttal.attack_angles.length > 0);
    if (
      isGenuineFailure &&
      rebuttal.preempt_hint.pattern_name &&
      rebuttal.preempt_hint.pattern_name !== "unknown"
    ) {
      observedPatterns.push({
        type: "failure",
        pattern_name: rebuttal.preempt_hint.pattern_name,
        description: rebuttal.preempt_hint.description,
      });
    }
    // success pattern: only when verdict=unable_to_refute AND insight.kind=confirmation
    if (
      rebuttal.verdict === "unable_to_refute" &&
      rebuttal.insight.kind === "confirmation" &&
      rebuttal.insight.content &&
      rebuttal.preempt_hint.pattern_name &&
      rebuttal.preempt_hint.pattern_name !== "unknown"
    ) {
      observedPatterns.push({
        type: "success",
        pattern_name: rebuttal.preempt_hint.pattern_name,
        description: rebuttal.insight.content.slice(0, 200),
      });
    }

    await debugLog.write("try", {
      tryIndex: budget.tries,
      agent: {
        exitCode: agent.exitCode,
        durationMs: agent.durationMs,
        stdout: agent.stdout,
        stderr: agent.stderr,
        diff: agent.diff,
      },
      verify: {
        ok: verify.ok,
        exitCode: verify.exitCode,
        stdout: verify.stdout,
        stderr: verify.stderr,
        durationMs: verify.durationMs,
      },
      rebuttal: {
        verdict: rebuttal.verdict,
        reason: rebuttal.reason,
        counter_example: rebuttal.counter_example,
        evidence: rebuttal.evidence,
        evidence_verified: rebuttal.evidence_verified,
        attack_angles: rebuttal.attack_angles,
        insight: rebuttal.insight,
        preempt_hint: rebuttal.preempt_hint,
        scope_drift_detected: rebuttal.scope_drift_detected,
        scope_question: rebuttal.scope_question,
        meta: rebuttal.meta,
      },
      criticPrompt: criticDebug,
    });

    // 4. completion check
    if (verify.ok && rebuttal.verdict === "unable_to_refute") {
      const s = budgetSummary(budget);
      await debugLog.write("success", s);
      // On completion, show the confirmation insight as the final "why:" line.
      // The per-try detailed critic block is already printed by printCriticVerdict(),
      // so here we just emit a one-line summary at the end.
      const userInsight =
        rebuttal.insight.kind === "confirmation" && rebuttal.insight.content
          ? rebuttal.insight.content
          : "";
      success(s.tries, s.elapsedSec, s.costUsd, userInsight);
      // Phase 2: write observed patterns back to the dictionary (does not mutate the frozen snapshot;
      // takes effect from the next session)
      await persistObservedPatterns(patternsPath, loadedPatterns, observedPatterns);
      return { ok: true, tries: s.tries, elapsedSec: s.elapsedSec, costUsd: s.costUsd };
    }

    // 5. append this try's rebuttal and diff to history (feed into the next try's critic input)
    pastRebuttals.push({
      tryIndex: budget.tries,
      reason: rebuttal.reason,
      attack_angles: rebuttal.attack_angles,
      preempt_hint: rebuttal.preempt_hint,
    });
    pastDiffs.push({ tryIndex: budget.tries, diff: agent.diff });

    // 5.5. Shibaki core experience: scope-drift detection → human meta correction
    let humanMetaCorrection = "";
    if (args.ask && rebuttal.scope_drift_detected && rebuttal.scope_question) {
      humanMetaCorrection = await askHumanMetaQuestion(rebuttal.scope_question);
      await debugLog.write("human_meta", { question: rebuttal.scope_question, response: humanMetaCorrection });
    }

    // 6. build extra context for the next try (fed into the agent)
    extraContext = buildExtraContext(rebuttal, humanMetaCorrection);
  }
  } finally {
    cleanupSignal();
  }
}

// SIGINT/SIGTERM handler: persist observedPatterns to dict before exit.
// Returns a cleanup function to call on normal exit (removes the listeners).
// Double signal = hard exit (escape hatch for impatient users).
function installInterruptHandler(
  patternsPath: string,
  loaded: Pattern[],
  observed: { type: "failure" | "success"; pattern_name: string; description: string }[],
): () => void {
  let firing = false;
  const onSignal = (sig: NodeJS.Signals) => {
    if (firing) {
      // Second press: give up on rescue, hard exit (130 = 128+SIGINT)
      process.stderr.write("\n  force exit\n");
      process.exit(130);
    }
    firing = true;
    process.stderr.write(`\n⚠ ${sig} received — saving patterns and exiting...\n`);
    // Kill the child process tree (claude / bun test / etc.) immediately.
    // Without this, they orphan and keep racking up API call charges.
    killAllChildren("SIGTERM");
    // Save patterns synchronously. Exit even on failure (don't fail silently — write to stderr).
    persistObservedPatterns(patternsPath, loaded, observed)
      .then(() => {
        if (observed.length > 0) {
          process.stderr.write(`✓ saved ${observed.length} pattern(s) for next session\n`);
        } else {
          process.stderr.write(`  (no patterns observed yet)\n`);
        }
        process.exit(130);
      })
      .catch((e) => {
        process.stderr.write(`✗ pattern save failed: ${e?.message ?? e}\n`);
        process.exit(130);
      });
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return () => {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  };
}

function buildExtraContext(r: Awaited<ReturnType<typeof runRebuttal>>, humanMeta?: string): string {
  const lines: string[] = [];
  lines.push(`critic verdict: ${r.verdict}`);
  if (r.reason) lines.push(`reason: ${r.reason}`);
  if (r.counter_example.kind !== "none" && r.counter_example.content) {
    lines.push("");
    lines.push(`counter-example (${r.counter_example.kind}):`);
    lines.push(r.counter_example.content);
  }
  if (r.evidence) {
    lines.push("");
    lines.push(`evidence:`);
    lines.push(r.evidence);
  }
  if (r.attack_angles.length > 0) {
    lines.push("");
    lines.push(`Attack angles you MUST address in the next try:`);
    r.attack_angles.forEach((a, i) => lines.push(`${i + 1}. ${a}`));
  }
  // insight: meta-level observation passed to agent (informational, not mandatory)
  if (r.insight.content) {
    lines.push("");
    lines.push(`insight (${r.insight.kind}): ${r.insight.content}`);
  }
  // Shibaki core: human meta correction (highest-priority instruction)
  if (humanMeta) {
    lines.push("");
    lines.push(`[META CORRECTION FROM HUMAN — follow this with highest priority]`);
    lines.push(humanMeta);
  }
  return lines.join("\n");
}

// On scope drift, ask the human a 1-line meta question.
// If no answer within 30 seconds, treat as "continue as-is".
const ASK_TIMEOUT_MS = 30_000;

async function askHumanMetaQuestion(question: string): Promise<string> {
  process.stderr.write("\n");
  process.stderr.write("? Shibaki: scope drift detected\n");
  process.stderr.write(`  question: ${question}\n`);
  process.stderr.write("  answer (one line, Enter to send; blank Enter = continue, 30s timeout): ");

  return new Promise((resolve) => {
    const stdin = process.stdin;
    let response = "";
    let resolved = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finalize = (r: string) => {
      if (resolved) return;
      resolved = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      stdin.removeListener("data", onData);
      stdin.pause();
      const trimmed = r.trim();
      if (trimmed) {
        process.stderr.write(`  → received: "${trimmed}"\n\n`);
      } else {
        process.stderr.write(`  → no answer, continuing as-is\n\n`);
      }
      resolve(trimmed);
    };

    const onData = (chunk: Buffer) => {
      response += chunk.toString();
      const idx = response.indexOf("\n");
      if (idx >= 0) {
        finalize(response.slice(0, idx));
      }
    };

    stdin.resume();
    stdin.on("data", onData);

    timer = setTimeout(() => finalize(response), ASK_TIMEOUT_MS);
  });
}

function progress(line: string): void {
  process.stderr.write(line + "\n");
}

// Render the critic's verdict + reason + (when refuted) attack angles + insight
// so the user can see what the critic actually said. This was previously hidden
// under principle 1, but that left users unable to evaluate whether the critic
// earned its keep on a given run. The transparency cost is a few extra lines
// per try; the trust gain is being able to see the AI-vs-AI dialog directly.
function printCriticVerdict(r: Awaited<ReturnType<typeof runRebuttal>>): void {
  const out = process.stderr;
  // On-brand verb choice: refuted → "slaps" (the project's namesake), unable_to_refute → "approves".
  // Replaces the previous bare "✗ critic: refuted —" / "✓ critic: unable_to_refute" lines.
  // Color carries the same semantic (red = bad, green = good) for at-a-glance scanning.
  if (r.verdict === "refuted") {
    out.write(`  ${red("✗")} critic ${red("slaps")}: ${r.reason || ""}\n`);
  } else {
    out.write(`  ${green("✓")} critic ${green("approves")}${r.reason ? `: ${r.reason}` : ""}\n`);
  }

  if (r.scope_drift_detected && r.scope_question) {
    out.write(`    scope drift: ${r.scope_question}\n`);
  }

  if (r.attack_angles.length > 0) {
    out.write(`    attack angles:\n`);
    for (let i = 0; i < r.attack_angles.length; i++) {
      out.write(`      ${i + 1}. ${r.attack_angles[i]}\n`);
    }
  }

  // Display caps set per field. Dogfood confirmed that Shibaki's core value (AI dialog content)
  // was being truncated at a 200-char cap, so we relaxed it per typical field length:
  //  - evidence is quote-based and tends to be long → 800
  //  - counter-example is code / concrete-example, medium length → 600
  //  - insight is the actual learning; truncating gutted the value → 600
  if (r.counter_example.kind !== "none" && r.counter_example.content) {
    out.write(`    counter-example (${r.counter_example.kind}): ${truncate(r.counter_example.content, 600)}\n`);
  }

  if (r.evidence) {
    const tag = r.evidence_verified ? "evidence ✓" : "evidence (unverified)";
    out.write(`    ${tag}: ${truncate(r.evidence, 800)}\n`);
  }

  if (r.insight.content) {
    out.write(`    insight (${r.insight.kind}): ${truncate(r.insight.content, 600)}\n`);
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

// Live ticker for slow phases (agent / critic), so the user sees the loop
// is alive instead of facing 30-60s of dead air.
//
// TTY: animated Braille spinner + elapsed seconds + (optional) expected
// duration hint, updated in place via \r every 80ms (~12 fps — smooth
// enough to read as "moving" without burning CPU).
// Non-TTY (CI / pipe to file): only print start and end markers
// (no \r noise in logs).
//
// expectedRange is a per-phase hint of "this is roughly how long it normally takes".
// Lets the user judge for themselves whether "60s elapsed and got refuted = abnormal?".

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

// No-op ticker used when --quiet suppresses spinner output. Same shape as phaseTicker's
// return so call sites don't have to special-case.
const NULL_TICKER = { stop: () => {} } as const;

function phaseTicker(
  label: string,
  opts: { expectedRange?: string } = {},
): { stop: () => void } {
  const start = Date.now();
  const isTty = !!process.stderr.isTTY;
  let interval: ReturnType<typeof setInterval> | null = null;
  const hint = opts.expectedRange ? ` (~${opts.expectedRange} expected)` : "";

  if (isTty) {
    let frame = 0;
    process.stderr.write(`  ${SPINNER_FRAMES[0]} ${label}... 0s${hint}`);
    interval = setInterval(() => {
      frame = (frame + 1) % SPINNER_FRAMES.length;
      const sec = Math.floor((Date.now() - start) / 1000);
      // \r returns to line start; trailing padding spaces erase the previous tail
      process.stderr.write(`\r  ${SPINNER_FRAMES[frame]} ${label}... ${sec}s${hint}   `);
    }, SPINNER_INTERVAL_MS);
  } else {
    process.stderr.write(`  ↳ ${label}...\n`);
  }

  return {
    stop() {
      const sec = Math.floor((Date.now() - start) / 1000);
      if (interval) {
        clearInterval(interval);
        // Finalize the line with the final elapsed time + newline (✓ green for symmetry with verdict)
        process.stderr.write(`\r  ↳ ${label} (${sec}s) ${green("✓")}     \n`);
      } else {
        process.stderr.write(`  ↳ ${label} done (${sec}s)\n`);
      }
    },
  };
}

function success(tries: number, elapsedSec: number, costUsd: number, insight?: string): void {
  const mins = Math.floor(elapsedSec / 60);
  const secs = elapsedSec % 60;
  const time = mins > 0 ? `${mins}m${secs}s` : `${secs}s`;
  process.stderr.write(`✓ done (${time} / ${tries} tries / $${costUsd.toFixed(3)})\n`);
  if (insight) {
    process.stderr.write(`  why: ${insight}\n`);
  }
}

// Merge observedPatterns into loadedPatterns, prune, and save.
// No-op if nothing was observed.
async function persistObservedPatterns(
  path: string,
  loaded: Pattern[],
  observed: { type: "failure" | "success"; pattern_name: string; description: string }[],
): Promise<void> {
  if (observed.length === 0) return;
  let merged: Pattern[] = loaded;
  for (const obs of observed) {
    merged = mergeObservation(merged, obs);
  }
  const pruned = prunePatterns(merged);
  await savePatterns(path, pruned);
}

function escalate(tries: number, elapsedSec: number, breach: string, pattern: string): void {
  const mins = Math.floor(elapsedSec / 60);
  const secs = elapsedSec % 60;
  const time = mins > 0 ? `${mins}m${secs}s` : `${secs}s`;
  const breachLabel =
    breach === "tries" ? "max tries hit" : breach === "timeout" ? "timeout" : "cost cap hit";
  process.stderr.write(`✗ failed (${tries} tries / ${time} / ${breachLabel})\n`);
  process.stderr.write(`  stuck pattern: ${pattern}\n`);
  process.stderr.write(`  recommendation: review manually\n`);
}
