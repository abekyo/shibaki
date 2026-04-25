// Shared subprocess spawn logic for CLI-backed providers.
//
// claude-cli / gemini-cli / codex-cli all share the same shape: "pass a prompt to a
// local CLI and receive the result on stdout". Concentrate spawn + timeout + output
// size cap here.
//
// Security:
//  - Always spawn with args as an array (no shell) — avoids injection
//  - Since the critic invokes this, never pass a string mixed with the user's prompt to the shell
//
// Note: flags may change across CLI versions. Let the user override only the actual binary name
// via env (e.g. CLAUDE_CLI_BIN) to swap implementations.
import { spawn } from "node:child_process";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024; // 2 MiB
const DEFAULT_TIMEOUT_MS = 180_000; // 3 minutes (larger models respond slowly)

export interface CliSpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface CliSpawnOptions {
  bin: string;
  args: string[];
  stdin?: string;
  timeoutMs?: number;
  /** env override for spawn. Defaults to process.env if unset */
  env?: NodeJS.ProcessEnv;
}

export async function cliSpawn(opts: CliSpawnOptions): Promise<CliSpawnResult> {
  const t0 = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const child = spawn(opts.bin, opts.args, {
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutTrunc = false;
    let stderrTrunc = false;
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* swallow */ }
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* swallow */ } }, 3000);
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      if (stdoutTrunc) return;
      const s = d.toString();
      if (stdout.length + s.length > MAX_OUTPUT_BYTES) {
        stdout += s.slice(0, MAX_OUTPUT_BYTES - stdout.length);
        stdoutTrunc = true;
      } else {
        stdout += s;
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderrTrunc) return;
      const s = d.toString();
      if (stderr.length + s.length > MAX_OUTPUT_BYTES) {
        stderr += s.slice(0, MAX_OUTPUT_BYTES - stderr.length);
        stderrTrunc = true;
      } else {
        stderr += s;
      }
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(new Error(
          `CLI not found: ${opts.bin}. ` +
          `Install the CLI or set PATH / override bin via env.`
        ));
        return;
      }
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 0,
        durationMs: Date.now() - t0,
      });
    });

    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();
  });
}

/** Compose system + user into a single CLI prompt.
 *  For CLIs without API-style role separation (claude -p / codex exec etc.), this layout is the most reliable. */
export function composeCliPrompt(system: string, user: string, jsonMode: boolean): string {
  const parts: string[] = [];
  if (system && system.trim()) {
    parts.push("# System\n" + system.trim());
  }
  if (jsonMode) {
    parts.push(
      "# Output format (strict)\n" +
      "- Reply with EXACTLY ONE valid JSON object.\n" +
      "- Start with `{`, end with `}`.\n" +
      "- Do NOT wrap in code fences (```).\n" +
      "- Do NOT include any text before or after the JSON."
    );
  }
  parts.push("# Task\n" + user);
  return parts.join("\n\n");
}

// Aggregates each CLI provider's binary + override env + install hint.
// Keys are the CLI variants of ProviderName; values are (defaultBin, envVar, install) triples.
export const CLI_INFO: Record<
  "anthropic-cli" | "gemini-cli" | "codex-cli",
  { defaultBin: string; envVar: string; install: string }
> = {
  "anthropic-cli": {
    defaultBin: "claude",
    envVar: "CLAUDE_CLI_BIN",
    install: "npm install -g @anthropic-ai/claude-code && claude login",
  },
  "gemini-cli": {
    defaultBin: "gemini",
    envVar: "GEMINI_CLI_BIN",
    install: "npm install -g @google/gemini-cli  (experimental — flags may vary by version)",
  },
  "codex-cli": {
    defaultBin: "codex",
    envVar: "CODEX_CLI_BIN",
    install: "npm install -g @openai/codex && codex login  (experimental — flags may vary by version)",
  },
};

/** CLI which-check helper. Used by testApiKey to surface a friendly error when the CLI is not installed. */
export async function cliAvailable(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = spawn("which", [bin], { stdio: "ignore" });
    c.on("close", (code) => resolve(code === 0));
    c.on("error", () => resolve(false));
  });
}
