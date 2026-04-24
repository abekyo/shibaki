// 閉ループ本体: main agent → verify → rebuttal → (refuted なら再試行).
//
// 各試行ごとに critic の verdict を stderr へ可視化する (透明性優先)。
// 完遂の必要十分条件: verify.exit === 0 かつ rebuttal.verdict === "unable_to_refute".
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
  if (args.debug) {
    progress(`▶ task accepted (verify: ${args.verify}) [debug: ${debugLog.path}]`);
  } else {
    progress(`▶ task accepted (verify: ${args.verify})`);
  }
  await debugLog.write("start", { task: args.task, verify: args.verify, agent: args.agent, cfg });

  let extraContext: string | undefined;
  let lastPreemptHint = "";
  const pastRebuttals: PastRebuttalBrief[] = [];
  const pastDiffs: PastDiffBrief[] = [];

  // Phase 2: 失敗モード辞書 / 成功パターン辞書を session 開始時に load
  // 以降 session 中は不変 (frozen snapshot semantics)
  const patternsPath = defaultPatternsPath();
  const loadedPatterns = await loadPatterns(patternsPath);
  const patternsSnapshot = buildPatternsSnapshot(loadedPatterns);
  const observedPatterns: { type: "failure" | "success"; pattern_name: string; description: string }[] = [];

  // Level 2: プロジェクト規約 / 構造 / 依存 (frozen, agent と異なる視点の素材)
  const projectContext = await collectProjectContext(process.cwd());

  // Ctrl-C / SIGTERM の最低保証: observedPatterns を辞書に書き戻してから exit。
  // patterns dictionary が session 横断学習の中核なので、長時間 run を途中で
  // 諦めるヘビーユーザにも「学習が残る」体験を保証する。
  // 二度押しは即死 (痺れを切らした user の脱出口を残す)。
  const cleanupSignal = installInterruptHandler(patternsPath, loadedPatterns, observedPatterns);

  try {
  while (true) {
    const breach = checkBudget(budget, cfg);
    if (breach) {
      const s = budgetSummary(budget);
      await debugLog.write("escalate", { breach, ...s, pattern_name: lastPreemptHint || "unknown" });
      escalate(s.tries, s.elapsedSec, breach, lastPreemptHint || "unknown");
      // 失敗時も観測した failure pattern は辞書に積む (次回 preempt で活きる)
      await persistObservedPatterns(patternsPath, loadedPatterns, observedPatterns);
      return { ok: false, tries: s.tries, elapsedSec: s.elapsedSec, costUsd: s.costUsd, pattern_name: lastPreemptHint || "unknown" };
    }

    budget.tries += 1;
    progress(`▶ try ${budget.tries}/${cfg.maxTries}`);

    // 1. main agent を走らせる
    const agentTick = phaseTicker("agent working");
    const agent = await runMainAgent({
      agentCmd: args.agent,
      task: args.task,
      extraContext,
      timeoutMs: Math.max(60_000, cfg.timeoutMs - (Date.now() - budget.startedAt)),
    });
    agentTick.stop();

    // 2. verify
    const verify = await runVerify(args.verify);

    // 3. レベル 1 拡張: 深い分析のための文脈ファイルを収集
    const contextFiles = await collectContextFiles({
      cwd: process.cwd(),
      diff: agent.diff,
      verifyCmd: args.verify,
      maxFiles: 8,
      maxBytesPerFile: 20_000,
    });

    // 4. rebuttal (critic)
    const criticTick = phaseTicker("critic deliberating");
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
        pastRebuttals: pastRebuttals.slice(-5),  // 直近 5 試行分まで (context 肥大防止)
        modifiedFiles: contextFiles.modifiedFiles,
        testFiles: contextFiles.testFiles,
        pastDiffs: pastDiffs.slice(-2),  // 直近 2 試行の diff (agent の変更履歴)
        patternsSnapshot,                  // 1 session 中は不変 (frozen)
        projectContext,                    // Level 2: 別視点の素材 (frozen)
      },
      args.debug ? (e) => { criticDebug = e; } : undefined,
    );
    criticTick.stop();

    // コスト累積
    if (rebuttal.meta.usage && rebuttal.meta.model) {
      budget.costUsd += estimateCostUsd(
        rebuttal.meta.model,
        rebuttal.meta.usage.input_tokens,
        rebuttal.meta.usage.output_tokens,
      );
    }

    // critic の判定をユーザに見せる。原則 1 (= 内省を隠す) は撤回した:
    // critic が core value なのに見えないと「役に立ったか」を user が判定できず、
    // 結果として cost だけ増えた black box に見える。
    printCriticVerdict(rebuttal);

    if (rebuttal.preempt_hint.pattern_name && rebuttal.preempt_hint.pattern_name !== "unknown") {
      lastPreemptHint = rebuttal.preempt_hint.pattern_name;
    }

    // Phase 2: 辞書への persist は質ゲート付き
    //
    // failure pattern として残すのは「真の失敗の根拠がある」場合のみ:
    //   - verify.ok=false (verify 自体が落ちた = 客観的失敗) もしくは
    //   - verdict=refuted かつ evidence_verified=true (引用検証済の真の指摘)
    // tryIndex=1 で強制 refuted になっただけで evidence 無しの pattern は除外
    // (これを入れると幻覚 pattern が辞書を汚染する)
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
    // success pattern: verdict=unable_to_refute + insight.kind=confirmation のときのみ
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

    // 4. 完遂判定
    if (verify.ok && rebuttal.verdict === "unable_to_refute") {
      const s = budgetSummary(budget);
      await debugLog.write("success", s);
      // 完遂時の confirmation insight は最終 "why:" 行として表示する。
      // 各試行ごとの詳細な critic ブロックは printCriticVerdict() が既に出している
      // ので、ここでは最後に 1 行要約するだけ。
      const userInsight =
        rebuttal.insight.kind === "confirmation" && rebuttal.insight.content
          ? rebuttal.insight.content
          : "";
      success(s.tries, s.elapsedSec, s.costUsd, userInsight);
      // Phase 2: 観測した patterns を辞書に書き戻す (frozen snapshot を変えない、
      // 次セッションから反映される)
      await persistObservedPatterns(patternsPath, loadedPatterns, observedPatterns);
      return { ok: true, tries: s.tries, elapsedSec: s.elapsedSec, costUsd: s.costUsd };
    }

    // 5. 履歴に今回の rebuttal と diff を追加 (次試行の critic 入力に渡すため)
    pastRebuttals.push({
      tryIndex: budget.tries,
      reason: rebuttal.reason,
      attack_angles: rebuttal.attack_angles,
      preempt_hint: rebuttal.preempt_hint,
    });
    pastDiffs.push({ tryIndex: budget.tries, diff: agent.diff });

    // 5.5. Shibaki のコア体験: scope drift 検出 → human meta 補正
    let humanMetaCorrection = "";
    if (args.ask && rebuttal.scope_drift_detected && rebuttal.scope_question) {
      humanMetaCorrection = await askHumanMetaQuestion(rebuttal.scope_question);
      await debugLog.write("human_meta", { question: rebuttal.scope_question, response: humanMetaCorrection });
    }

    // 6. 次試行用のコンテキストを組む (agent に読ませる)
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
      // 二度目: 救済を諦めて即死 (130 = 128+SIGINT)
      process.stderr.write("\n  force exit\n");
      process.exit(130);
    }
    firing = true;
    process.stderr.write(`\n⚠ ${sig} received — saving patterns and exiting...\n`);
    // 子プロセスツリー (claude / bun test 等) を即座に kill。
    // ここで殺さないと孤児化して API call の課金だけが発生する。
    killAllChildren("SIGTERM");
    // 同期路で patterns を save。失敗しても exit (silent fail せず stderr に出す)。
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
  const sym = r.verdict === "refuted" ? "✗" : "✓";
  out.write(`  ${sym} critic: ${r.verdict}${r.reason ? ` — ${r.reason}` : ""}\n`);

  if (r.scope_drift_detected && r.scope_question) {
    out.write(`    scope drift: ${r.scope_question}\n`);
  }

  if (r.attack_angles.length > 0) {
    out.write(`    attack angles:\n`);
    for (let i = 0; i < r.attack_angles.length; i++) {
      out.write(`      ${i + 1}. ${r.attack_angles[i]}\n`);
    }
  }

  // 表示上限は field 別に設定。shibaki の本質価値 (AI 対話の中身) が 200 文字 cap で
  // 切れる問題を dogfood で確認したため、各 field の典型長に合わせて緩和:
  //  - evidence は引用ベースで長文化しやすい → 800
  //  - counter-example はコード / 具体例で中程度 → 600
  //  - insight は学び本文、切れると価値激減 → 600
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

// Live elapsed-seconds ticker for slow phases (agent / critic), so the user
// sees the loop is alive instead of facing 30-60s of dead air. On a TTY,
// the line updates in place via \r every second; on non-TTY (CI / pipe to
// file), we only print start and end markers (no \r noise in logs).
function phaseTicker(label: string): { stop: () => void } {
  const start = Date.now();
  const isTty = !!process.stderr.isTTY;
  let interval: ReturnType<typeof setInterval> | null = null;

  if (isTty) {
    process.stderr.write(`  ↳ ${label}... 0s`);
    interval = setInterval(() => {
      const sec = Math.floor((Date.now() - start) / 1000);
      // \r で行頭に戻り、padding 用 spaces で前回末尾を消す
      process.stderr.write(`\r  ↳ ${label}... ${sec}s   `);
    }, 1000);
  } else {
    process.stderr.write(`  ↳ ${label}...\n`);
  }

  return {
    stop() {
      const sec = Math.floor((Date.now() - start) / 1000);
      if (interval) {
        clearInterval(interval);
        // 最終時間で行を確定 + 改行
        process.stderr.write(`\r  ↳ ${label} (${sec}s) ✓     \n`);
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

// observedPatterns を loadedPatterns と merge して prune して保存。
// 何も観測していなければ no-op。
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
