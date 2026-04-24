// `shibaki doctor` — read-only environment diagnostic.
//
// Does not violate Anti-Vision (zero knobs, no settings saved, no loop entered).
// Reduces "it doesn't work" debugging effort for the user.
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { detectCriticProvider, detectMainProvider, type Provider } from "../agent/secretIsolation.ts";

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

  const checks: CheckResult[] = [];

  checks.push(await checkBun());
  checks.push(await checkClaude());
  checks.push(checkCriticKey());
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

const KEY_NAME: Record<Provider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
};

const KEY_HINT_URL: Record<Provider, string> = {
  anthropic: "https://console.anthropic.com",
  openai: "https://platform.openai.com/api-keys",
  gemini: "https://aistudio.google.com/apikey (free tier available, recommended)",
};

function checkCriticKey(): CheckResult {
  const provider = detectCriticProvider();
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
function listAvailableProviders(env: NodeJS.ProcessEnv = process.env): Provider[] {
  const out: Provider[] = [];
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
//      (self-critique blind spot) → recommend free Gemini instead.
//   3. No keys at all → standard "go get one" with Gemini-first nudge.
export function buildMissingKeyHint(detected: Provider, env: NodeJS.ProcessEnv = process.env): string {
  const main = detectMainProvider(env);
  const available = listAvailableProviders(env).filter((p) => p !== detected);

  const lines: string[] = [];
  const usableNow = available.filter((p) => p !== main);
  const sameAsMain = available.filter((p) => p === main);

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
  lines.push(`No provider key found. Easiest path (free):`);
  lines.push(`  export GEMINI_API_KEY=AIza...   # https://aistudio.google.com/apikey`);
  lines.push(`  export LLM_PROVIDER_CRITICAL=gemini`);
  lines.push(`Or get the detected provider's key:`);
  lines.push(`  export ${KEY_NAME[detected]}=...   # ${KEY_HINT_URL[detected]}`);
  return lines.join("\n");
}

// "Did you mean Gemini?" nudge — fires only when the critic key check is
// PASSING (otherwise the missing-key hint above already covers the same
// recommendation, and we'd be duplicating the warning).
function checkGeminiHint(): CheckResult {
  const hasGeminiKey = !!(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim().length >= 8);
  const criticOverride = process.env.LLM_PROVIDER_CRITICAL;
  const detectedCritic = detectCriticProvider();
  const criticKeySet = isCriticKeySet();

  if (hasGeminiKey && !criticOverride && criticKeySet && detectedCritic !== "gemini") {
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

// Helper used by both checkProviderSeparation and checkGeminiHint: is the
// critic provider's API key actually present? When missing, downstream
// "everything is fine" ✓ checks are misleading because there's no critic
// to run in the first place.
function isCriticKeySet(env: NodeJS.ProcessEnv = process.env): boolean {
  const detected = detectCriticProvider(env);
  const value = env[KEY_NAME[detected]];
  return !!(value && value.trim().length >= 8);
}

function checkProviderSeparation(): CheckResult {
  // If the critic has no key, separation is moot — checkCriticKey already
  // raised an error above. Reporting "✓ Provider separation" here would
  // give a false sense that the env is half-OK.
  if (!isCriticKeySet()) {
    return {
      status: "warn",
      label: "Provider separation",
      detail: "(skipped — fix the critic key first)",
    };
  }
  const main = detectMainProvider();
  const critic = detectCriticProvider();
  if (main === critic && process.env.SHIBAKI_ALLOW_SAME_PROVIDER !== "1") {
    return {
      status: "error",
      label: `Provider separation`,
      detail: `(main=${main} == critic=${critic})`,
      hint:
        `Set LLM_PROVIDER_CRITICAL to a different provider\n` +
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
  - Critic API key (auto-detect provider + format check)
  - Main / Critic provider separation (prevents self-critique)
  - Whether current dir is a git repo
  - Whether .env.local is gitignored

Saves nothing (zero knobs). Output goes to stdout only.
`;
