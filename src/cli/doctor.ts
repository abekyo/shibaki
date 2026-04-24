// `shibaki doctor` — read-only environment diagnostic.
//
// Does not violate Anti-Vision (zero knobs, no settings saved, no loop entered).
// Reduces "it doesn't work" debugging effort for the user.
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  detectCriticProvider,
  detectMainProvider,
  type Provider,
} from "../agent/secretIsolation.ts";
import { isCliProvider, providerFamily, type ProviderName } from "../llm/types.ts";
import { autoSelectCritic } from "./autoFallback.ts";

type CheckStatus = "ok" | "warn" | "error";

interface CheckResult {
  status: CheckStatus;
  label: string;
  detail?: string;
  hint?: string;
}

export async function cmdDoctor(argv: string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }

  process.stdout.write("Shibaki doctor — environment diagnostic\n");
  process.stdout.write("==========================================\n\n");

  // Auto-fallback を先に評価: key 無し + claude あり なら LLM_PROVIDER_CRITICAL を
  // anthropic-cli に書き換えた上で以降の check を進める。
  const fallback = await autoSelectCritic(process.env);

  const checks: CheckResult[] = [];

  checks.push(await checkBun());
  checks.push(await checkClaude());
  if (fallback.apply) {
    checks.push({
      status: "warn",
      label: "Auto-fallback",
      detail: "(Plan mode selected)",
      hint:
        `${fallback.reason}\n` +
        `Critic routed to anthropic-cli (model: opus).\n` +
        `To opt out: export LLM_PROVIDER_CRITICAL=gemini   # or openai / anthropic`,
    });
  }
  checks.push(await checkCriticBackend());
  checks.push(checkProviderSeparation());
  checks.push(checkGeminiHint());
  checks.push(await checkGitRepo());
  checks.push(await checkEnvLocalIgnored());

  for (const c of checks) {
    const sym = c.status === "ok" ? "✓" : c.status === "warn" ? "⚠" : "✗";
    process.stdout.write(`${sym} ${c.label}`);
    if (c.detail) process.stdout.write(` ${c.detail}`);
    process.stdout.write("\n");
    if (c.hint) {
      for (const line of c.hint.split("\n")) process.stdout.write(`   → ${line}\n`);
    }
  }

  process.stdout.write("\n");
  const errors = checks.filter((c) => c.status === "error").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  const cmd = shibakiInvocation();
  if (errors === 0 && warns === 0) {
    process.stdout.write(`✓ All checks passed. Try: ${cmd} demo\n`);
    return 0;
  }
  if (errors === 0) {
    process.stdout.write(`⚠ ${warns} warning(s). It will still work, but consider addressing the above.\n`);
    process.stdout.write(`  Next: ${cmd} demo\n`);
    return 0;
  }
  process.stdout.write(`✗ ${errors} error(s). Fix the above and try ${cmd} demo again.\n`);
  return 1;
}

/** Decide which form of the command to suggest in user-facing output.
 *  bunx / `bun run bin/shibaki.ts` users won't have `shibaki` on PATH —
 *  saying "Try: shibaki demo" to them produces command-not-found.
 *  Detect the installed-binary case by the absence of a `.ts` suffix in
 *  the invoked script path (global bin/shibaki vs. the source bin/shibaki.ts). */
function shibakiInvocation(): string {
  const bin = process.argv[1] ?? "";
  const installed = !bin.endsWith(".ts") && /\/bin\/shibaki(\.\w+)?$/.test(bin);
  return installed ? "shibaki" : "bunx shibaki@latest";
}

async function checkBun(): Promise<CheckResult> {
  const v = await execCapture("bun", ["--version"]);
  if (v.exitCode !== 0) {
    return {
      status: "error",
      label: "Bun runtime",
      detail: "(not found)",
      hint: "curl -fsSL https://bun.sh/install | bash",
    };
  }
  return { status: "ok", label: "Bun runtime", detail: v.stdout.trim() };
}

async function checkClaude(): Promise<CheckResult> {
  const which = await execCapture("which", ["claude"]);
  if (which.exitCode !== 0) {
    return {
      status: "error",
      label: "claude command",
      detail: "(not in PATH)",
      hint: "npm install -g @anthropic-ai/claude-code\nclaude login",
    };
  }
  return { status: "ok", label: "claude command", detail: which.stdout.trim() };
}

const KEY_NAME: Record<"anthropic" | "openai" | "gemini", string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
};

const KEY_HINT_URL: Record<"anthropic" | "openai" | "gemini", string> = {
  anthropic: "https://console.anthropic.com",
  openai: "https://platform.openai.com/api-keys",
  gemini: "https://aistudio.google.com/apikey (free tier available, recommended)",
};

// CLI-backed provider を PATH 上の bin 名にマップする (上書き用 env 名付き)。
// キーは ProviderName の CLI variant、値は (bin, install-hint) ペア。
const CLI_INFO: Record<
  "anthropic-cli" | "gemini-cli" | "codex-cli",
  { bin: string; envVar: string; install: string }
> = {
  "anthropic-cli": {
    bin: "claude",
    envVar: "CLAUDE_CLI_BIN",
    install: "npm install -g @anthropic-ai/claude-code && claude login",
  },
  "gemini-cli": {
    bin: "gemini",
    envVar: "GEMINI_CLI_BIN",
    install: "npm install -g @google/gemini-cli",
  },
  "codex-cli": {
    bin: "codex",
    envVar: "CODEX_CLI_BIN",
    install: "npm install -g @openai/codex && codex login",
  },
};

/** CLI provider は API key の代わりに bin が PATH 上にあるかを確認。
 *  API provider は従来通り key check。 */
async function checkCriticBackend(): Promise<CheckResult> {
  const provider = detectCriticProvider();
  if (isCliProvider(provider)) {
    return await checkCliProvider(provider as "anthropic-cli" | "gemini-cli" | "codex-cli");
  }
  return checkCriticKey();
}

async function checkCliProvider(
  provider: "anthropic-cli" | "gemini-cli" | "codex-cli",
): Promise<CheckResult> {
  const info = CLI_INFO[provider];
  const bin = process.env[info.envVar]?.trim() || info.bin;
  const which = await execCapture("which", [bin]);
  if (which.exitCode !== 0) {
    return {
      status: "error",
      label: `Critic CLI (${provider} / bin: ${bin})`,
      detail: "(not in PATH)",
      hint: info.install,
    };
  }
  return {
    status: "ok",
    label: `Critic CLI (${provider})`,
    detail: `(${which.stdout.trim()})`,
  };
}

function checkCriticKey(): CheckResult {
  const provider = detectCriticProvider() as "anthropic" | "openai" | "gemini";
  const keyName = KEY_NAME[provider];
  const value = process.env[keyName];

  if (!value || value.trim().length < 8) {
    return {
      status: "error",
      label: `Critic key (${keyName} / provider: ${provider})`,
      detail: "(not set)",
      hint: buildMissingKeyHint(provider),
    };
  }
  if (provider === "openai" && !value.startsWith("sk-")) {
    return {
      status: "error",
      label: `Critic key (${keyName})`,
      detail: "(invalid format, expected sk-... prefix)",
      hint: KEY_HINT_URL[provider],
    };
  }
  if (provider === "anthropic" && !value.startsWith("sk-ant-")) {
    return {
      status: "error",
      label: `Critic key (${keyName})`,
      detail: "(invalid format, expected sk-ant-... prefix)",
      hint: KEY_HINT_URL[provider],
    };
  }
  if (provider === "gemini" && !value.startsWith("AIza")) {
    return {
      status: "error",
      label: `Critic key (${keyName})`,
      detail: "(invalid format, expected AIza... prefix)",
      hint: KEY_HINT_URL[provider],
    };
  }
  return {
    status: "ok",
    label: `Critic key (${keyName} / provider: ${provider})`,
    detail: redact(value),
  };
}

// Inspect the env for *any* provider key so the missing-key hint can pivot.
// Returns providers whose API key is present and well-formed enough to be
// usable. Order is irrelevant — caller filters by use-case.
function listAvailableProviders(env: NodeJS.ProcessEnv = process.env): ("anthropic" | "openai" | "gemini")[] {
  const out: ("anthropic" | "openai" | "gemini")[] = [];
  if ((env.OPENAI_API_KEY ?? "").trim().length >= 8) out.push("openai");
  if ((env.ANTHROPIC_API_KEY ?? "").trim().length >= 8) out.push("anthropic");
  if ((env.GEMINI_API_KEY ?? "").trim().length >= 8) out.push("gemini");
  return out;
}

// Compose the "your critic key is missing" hint. Pivots based on what the
// user actually has in env, instead of always saying "go get key X".
//
// Cases (in priority order):
//   1. Another provider's key IS set, AND it differs from main provider
//      → tell them to set LLM_PROVIDER_CRITICAL to that (they already have
//        the key, just need to point Shibaki at it). This is the "I have
//        Gemini but doctor scolds me about OpenAI" fix.
//   2. Another provider's key IS set, but it would collide with main
//      (self-critique blind spot) → recommend free Gemini instead, OR
//      suggest CLI mode if main provider has a CLI counterpart.
//   3. No keys at all → offer the Plan mode (CLI critic) route first since
//      it requires no key, then fall back to Gemini-first API hint.
export function buildMissingKeyHint(
  detected: "anthropic" | "openai" | "gemini",
  env: NodeJS.ProcessEnv = process.env,
): string {
  const main = detectMainProvider(env);
  const mainFam = providerFamily(main);
  const available = listAvailableProviders(env).filter((p) => p !== detected);

  const lines: string[] = [];
  const usableNow = available.filter((p) => p !== mainFam);
  const sameAsMain = available.filter((p) => p === mainFam);

  if (usableNow.length > 0) {
    const p = usableNow[0]; // pick the first; users with two non-main keys can choose
    lines.push(`You already have ${KEY_NAME[p]} set — point Shibaki at it:`);
    lines.push(`  export LLM_PROVIDER_CRITICAL=${p}`);
    if (usableNow.length > 1) {
      const others = usableNow.slice(1).map((q) => `LLM_PROVIDER_CRITICAL=${q}`).join(" / ");
      lines.push(`  (or: ${others})`);
    }
    return lines.join("\n");
  }
  if (sameAsMain.length > 0) {
    lines.push(`The only key you have (${KEY_NAME[sameAsMain[0]]}) matches the main`);
    lines.push(`agent provider — using it as critic would create a self-critique`);
    lines.push(`blind spot. Recommended: free Gemini key.`);
    lines.push(`  export GEMINI_API_KEY=AIza...   # https://aistudio.google.com/apikey`);
    lines.push(`  export LLM_PROVIDER_CRITICAL=gemini`);
    return lines.join("\n");
  }
  // No keys at all. Plan mode (CLI critic) is the zero-friction path if the
  // user already has `claude` installed (the most common onboarding shape).
  lines.push(`No provider key found. Options:`);
  lines.push(``);
  lines.push(`A) Plan mode — no API key needed (uses Claude Code plan):`);
  lines.push(`   export LLM_PROVIDER_CRITICAL=anthropic-cli`);
  lines.push(`   export LLM_MODEL_CRITICAL=opus`);
  lines.push(``);
  lines.push(`B) API mode — Gemini has a free tier:`);
  lines.push(`   export GEMINI_API_KEY=AIza...   # https://aistudio.google.com/apikey`);
  lines.push(`   export LLM_PROVIDER_CRITICAL=gemini`);
  lines.push(``);
  lines.push(`Or get the detected provider's key:`);
  lines.push(`  export ${KEY_NAME[detected]}=...   # ${KEY_HINT_URL[detected]}`);
  return lines.join("\n");
}

// "Did you mean Gemini?" nudge — fires only when the critic key check is
// PASSING (otherwise the missing-key hint above already covers the same
// recommendation, and we'd be duplicating the warning). Skipped in CLI mode.
function checkGeminiHint(): CheckResult {
  const criticOverride = process.env.LLM_PROVIDER_CRITICAL;
  const detectedCritic = detectCriticProvider();

  // CLI mode: nothing to hint about (no API key in play).
  if (isCliProvider(detectedCritic)) {
    return {
      status: "ok",
      label: "LLM_PROVIDER_CRITICAL",
      detail: `(=${criticOverride})`,
    };
  }

  const hasGeminiKey = !!(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim().length >= 8);
  const criticBackendOk = isCriticBackendOk();

  if (hasGeminiKey && !criticOverride && criticBackendOk && detectedCritic !== "gemini") {
    return {
      status: "warn",
      label: "LLM_PROVIDER_CRITICAL hint",
      detail: `(GEMINI_API_KEY available; currently routing critic to ${detectedCritic})`,
      hint: "export LLM_PROVIDER_CRITICAL=gemini   # to switch to Gemini (free tier)",
    };
  }
  return {
    status: "ok",
    label: "LLM_PROVIDER_CRITICAL",
    detail: criticOverride ? `(=${criticOverride})` : "(auto-detect)",
  };
}

// Synchronous best-effort: is the critic "backend" (API key or CLI bin) plausibly
// present? CLI-provider case here just checks the env override is untouched —
// real `which` check is async and done in checkCliProvider.
function isCriticBackendOk(env: NodeJS.ProcessEnv = process.env): boolean {
  const detected = detectCriticProvider(env);
  if (isCliProvider(detected)) return true; // conservative: assume CLI is present
  const value = env[KEY_NAME[detected as "anthropic" | "openai" | "gemini"]];
  return !!(value && value.trim().length >= 8);
}

function checkProviderSeparation(): CheckResult {
  // If the critic has no backend, separation is moot — checkCriticBackend
  // already raised an error above.
  if (!isCriticBackendOk()) {
    return {
      status: "warn",
      label: "Provider separation",
      detail: "(skipped — fix the critic backend first)",
    };
  }
  const main = detectMainProvider();
  const critic = detectCriticProvider();
  const sameFam = providerFamily(main) === providerFamily(critic);

  // CLI critic: same family auto-allowed (UX-first per project decision).
  if (sameFam && isCliProvider(critic)) {
    return {
      status: "ok",
      label: `Provider separation`,
      detail: `(main=${main}, critic=${critic}; CLI-mode same-family auto-allowed)`,
    };
  }
  if (sameFam && process.env.SHIBAKI_ALLOW_SAME_PROVIDER !== "1") {
    return {
      status: "error",
      label: `Provider separation`,
      detail: `(main=${main} / critic=${critic} — same family)`,
      hint:
        `Set LLM_PROVIDER_CRITICAL to a different-family provider\n` +
        `(or set SHIBAKI_ALLOW_SAME_PROVIDER=1 to override)`,
    };
  }
  return {
    status: "ok",
    label: `Provider separation`,
    detail: `(main=${main}, critic=${critic})`,
  };
}

async function checkGitRepo(): Promise<CheckResult> {
  const r = await execCapture("git", ["rev-parse", "--show-toplevel"], process.cwd());
  if (r.exitCode !== 0) {
    return {
      status: "warn",
      label: "Git repository",
      detail: "(not a git repo at " + process.cwd() + ")",
      hint: "shibaki run is meant to be invoked inside the target git repo (for diff retrieval)",
    };
  }
  return { status: "ok", label: "Git repository", detail: `(${r.stdout.trim()})` };
}

async function checkEnvLocalIgnored(): Promise<CheckResult> {
  const cwd = process.cwd();
  const envLocalPath = join(cwd, ".env.local");
  let exists = false;
  try {
    const s = await stat(envLocalPath);
    exists = s.isFile();
  } catch {
    return { status: "ok", label: ".env.local hygiene", detail: "(not present, OK)" };
  }
  if (!exists) {
    return { status: "ok", label: ".env.local hygiene", detail: "(not present, OK)" };
  }
  const r = await execCapture("git", ["check-ignore", "-v", ".env.local"], cwd);
  if (r.exitCode === 0) {
    return { status: "ok", label: ".env.local hygiene", detail: "(present, gitignored)" };
  }
  return {
    status: "warn",
    label: ".env.local hygiene",
    detail: "(present but NOT gitignored)",
    hint: "Add .env.local to .gitignore (prevents secret leaks on push)",
  };
}

function redact(s: string): string {
  if (s.length <= 12) return "(***)";
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function execCapture(cmd: string, args: string[], cwd?: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", () => resolve({ stdout: "", stderr: "", exitCode: 1 }));
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 0 }));
  });
}

const HELP = `Shibaki doctor — read-only environment diagnostic

Usage:
  shibaki doctor

Checks:
  - Bun runtime version
  - claude command (PATH)
  - Critic backend:
      API mode  → critic API key present + format check
      Plan mode → critic CLI (claude / gemini / codex) on PATH
  - Main / Critic provider separation (prevents self-critique)
  - Whether current dir is a git repo
  - Whether .env.local is gitignored

Saves nothing (zero knobs). Output goes to stdout only.
`;
