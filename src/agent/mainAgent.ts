// Spawn an external agent command (e.g., "claude -p"), pass it a task, and collect the output.
// Phase 1 is a minimal implementation: launch command via shell → write task to stdin → collect stdout.
//
// Note: the main agent is assumed to work on the same repository as the Shibaki process.
// The git diff before and after work is used as critic input.
//
// Security: the agent subprocess **does not inherit** critic-only API keys
// (sanitized in secretIsolation.ts). Can opt-out via SHIBAKI_ALLOW_AGENT_SECRETS=1.
//
// OOM prevention: subprocess stdout/stderr is cut off at MAX_OUTPUT_BYTES (5MB).
// Safety net for killing a runaway agent (infinite loop spewing huge logs) via the critic.
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
  diff: string; // git diff before and after work (for reviewing the modified range)
}

export interface MainAgentOptions {
  agentCmd: string;      // e.g., "claude -p"
  task: string;          // Natural-language task
  cwd?: string;
  timeoutMs?: number;
  extraContext?: string; // Inject previous counterexamples + preempt hints
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
    // Don't let the agent inherit critic-only secrets (secret isolation principle)
    const env = buildAgentEnv(process.env);
    // detached: true puts sh + its descendants in an independent process group.
    // On timeout / when the parent receives SIGINT, we can kill the whole tree with kill(-pid)
    // (default child.kill only kills sh, leaving claude as an orphan).
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

// Track live children (sh + leaders of their descendant process groups) in the parent process.
// Enables kill-all when SIGINT/SIGTERM is received.
const liveChildren: Set<ReturnType<typeof spawn>> = new Set();
function trackChild(c: ReturnType<typeof spawn>): void { liveChildren.add(c); }
function untrackChild(c: ReturnType<typeof spawn>): void { liveChildren.delete(c); }

function killTree(child: ReturnType<typeof spawn>, sig: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    // A child launched with detached: true is a process group leader (pgid === pid).
    // Passing -pid sends the signal to the entire group.
    process.kill(-child.pid, sig);
  } catch {
    // already dead / EPERM: fall back to a single kill
    try { child.kill(sig); } catch { /* swallow */ }
  }
}

/** Public: when the parent receives SIGINT/SIGTERM, kill all living child process trees.
 *  Intended to be called from the orchestrator's SIGINT handler. Idempotent. */
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
    // verify / git subprocesses likewise don't inherit critic-only secrets
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
