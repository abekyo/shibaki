// 外部 agent コマンド (例: "claude -p") を spawn してタスクを渡し、成果物を回収する。
// Phase 1 では shell でコマンドを起動 → stdin にタスクを書き込む → stdout を回収する最小実装。
//
// 注意: main agent は Shibaki プロセスと同じリポジトリ上で作業する前提。
// 作業前後の git diff を critic 入力に使う。
//
// セキュリティ: agent subprocess には critic 専用 API key を **inherit させない**
// (secretIsolation.ts で sanitize)。SHIBAKI_ALLOW_AGENT_SECRETS=1 で opt-out 可能。
//
// OOM 防止: subprocess の stdout/stderr は MAX_OUTPUT_BYTES (5MB) で打ち切る。
// runaway agent (無限ループで巨大 log を吐く) を critic 経由で kill するための保険。
import { spawn } from "node:child_process";
import { buildAgentEnv } from "./secretIsolation.ts";

const MAX_OUTPUT_BYTES = 5 * 1024 * 1024; // 5 MiB per stream

function makeCappedAppender(): { append: (chunk: Buffer | string) => void; get: () => string } {
  let buf = "";
  let truncated = false;
  let originalBytes = 0;
  return {
    append(chunk: Buffer | string) {
      const s = typeof chunk === "string" ? chunk : chunk.toString();
      originalBytes += Buffer.byteLength(s);
      if (truncated) return;
      if (buf.length + s.length <= MAX_OUTPUT_BYTES) {
        buf += s;
      } else {
        const remaining = MAX_OUTPUT_BYTES - buf.length;
        if (remaining > 0) buf += s.slice(0, remaining);
        truncated = true;
      }
    },
    get() {
      if (!truncated) return buf;
      return `${buf}\n...(truncated, original ${originalBytes} bytes exceeded ${MAX_OUTPUT_BYTES} byte cap)\n`;
    },
  };
}

export interface MainAgentResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  diff: string; // 作業前後の git diff (変更された範囲のレビュー用)
}

export interface MainAgentOptions {
  agentCmd: string;      // 例: "claude -p"
  task: string;          // 自然言語タスク
  cwd?: string;
  timeoutMs?: number;
  extraContext?: string; // 前回の反例 + preempt hint を注入する
}

export async function runMainAgent(opts: MainAgentOptions): Promise<MainAgentResult> {
  const t0 = Date.now();
  const cwd = opts.cwd ?? process.cwd();
  const timeoutMs = opts.timeoutMs ?? 15 * 60 * 1000;

  const diffBefore = await gitDiff(cwd);

  const prompt = buildPrompt(opts.task, opts.extraContext);

  const { stdout, stderr, exitCode } = await spawnShell(opts.agentCmd, prompt, cwd, timeoutMs);

  const diffAfter = await gitDiff(cwd);
  const diff = diffChange(diffBefore, diffAfter);

  return {
    stdout,
    stderr,
    exitCode,
    durationMs: Date.now() - t0,
    diff,
  };
}

function buildPrompt(task: string, extra?: string): string {
  if (!extra) return task;
  return `${task}\n\n--- Feedback from the previous loop iteration ---\n${extra}\n--- end ---\n\nPlease address the above and proceed.`;
}

function spawnShell(
  cmd: string,
  stdin: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    // agent には critic 用 secret を inherit させない (secret isolation 原則)
    const env = buildAgentEnv(process.env);
    // detached: true で sh + その子孫を独立 process group に置く。
    // タイムアウト時 / 親が SIGINT を受けた時に kill(-pid) でツリーごと殺せる
    // (default の child.kill は sh だけ殺して claude が孤児として残る)。
    const child = spawn("sh", ["-c", cmd], {
      cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true,
    });
    trackChild(child);
    const stdout = makeCappedAppender();
    const stderr = makeCappedAppender();
    const timer = setTimeout(() => {
      killTree(child, "SIGTERM");
      setTimeout(() => killTree(child, "SIGKILL"), 5000);
    }, timeoutMs);

    child.stdout.on("data", (d) => stdout.append(d));
    child.stderr.on("data", (d) => stderr.append(d));
    child.on("error", (err) => {
      clearTimeout(timer);
      untrackChild(child);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      untrackChild(child);
      resolve({ stdout: stdout.get(), stderr: stderr.get(), exitCode: code ?? 0 });
    });

    child.stdin.write(stdin);
    child.stdin.end();
  });
}

// 親プロセスで生存中の子 (sh + その子孫 process group のリーダ) を保持。
// SIGINT/SIGTERM を受けた時に kill all を可能にする。
const liveChildren: Set<ReturnType<typeof spawn>> = new Set();
function trackChild(c: ReturnType<typeof spawn>): void { liveChildren.add(c); }
function untrackChild(c: ReturnType<typeof spawn>): void { liveChildren.delete(c); }

function killTree(child: ReturnType<typeof spawn>, sig: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    // detached: true で起動した子は process group leader (pgid === pid)。
    // -pid を渡すと group 全体に signal を送れる。
    process.kill(-child.pid, sig);
  } catch {
    // already dead / EPERM: 単体 kill にフォールバック
    try { child.kill(sig); } catch { /* swallow */ }
  }
}

/** Public: 親が SIGINT/SIGTERM を受けた時、生きてる子プロセスツリーを全部殺す。
 *  orchestrator の SIGINT handler から呼ぶ前提。idempotent。 */
export function killAllChildren(sig: NodeJS.Signals = "SIGTERM"): void {
  for (const c of liveChildren) killTree(c, sig);
}

async function gitDiff(cwd: string): Promise<string> {
  try {
    const { stdout } = await execCapture("git diff HEAD", cwd);
    return stdout;
  } catch {
    return "";
  }
}

// Compute the diff that the agent ACTUALLY produced this turn, by subtracting
// any pre-existing dirty changes from the post-agent diff.
//
// Strategy: split each diff into per-file blocks (`diff --git a/X b/X ... `),
// keep only files whose post-agent block differs from the pre-agent block
// (or are entirely new). This is best-effort — for full fidelity, the user
// should run shibaki on a clean working tree.
function diffChange(before: string, after: string): string {
  if (before === after) return "";
  if (!before.trim()) return after;          // clean tree → after IS the agent's diff
  if (!after.trim()) return "";               // agent reverted everything

  const beforeBlocks = splitDiffByFile(before);
  const afterBlocks = splitDiffByFile(after);
  const out: string[] = [];
  for (const [path, block] of afterBlocks) {
    const beforeBlock = beforeBlocks.get(path);
    if (beforeBlock !== block) out.push(block);
  }
  return out.join("");
}

/** Split a unified-diff string into per-file blocks keyed by `b/<path>`. */
function splitDiffByFile(diff: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!diff) return map;
  const parts = diff.split(/^diff --git /m);
  for (const p of parts) {
    if (!p.trim()) continue;
    const m = /^a\/(\S+)\s+b\/(\S+)/.exec(p);
    if (!m) continue;
    map.set(m[2], `diff --git ${p}`);
  }
  return map;
}

export function execCapture(
  cmd: string,
  cwd: string,
  timeoutMs = 60_000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    // verify / git 系の subprocess も同様に critic 用 secret を inherit しない
    const env = buildAgentEnv(process.env);
    const child = spawn("sh", ["-c", cmd], {
      cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true,
    });
    trackChild(child);
    const stdout = makeCappedAppender();
    const stderr = makeCappedAppender();
    const timer = setTimeout(() => {
      killTree(child, "SIGTERM");
      setTimeout(() => killTree(child, "SIGKILL"), 2000);
    }, timeoutMs);
    child.stdout.on("data", (d) => stdout.append(d));
    child.stderr.on("data", (d) => stderr.append(d));
    child.on("error", (err) => {
      clearTimeout(timer);
      untrackChild(child);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      untrackChild(child);
      resolve({ stdout: stdout.get(), stderr: stderr.get(), exitCode: code ?? 0 });
    });
  });
}
