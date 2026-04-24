// CLI 引数 parser (最小)。受理判定のルールは scope.md に従う。

export interface RunArgs {
  agent: string;
  verify: string;
  task: string;
  maxTries: number;
  timeoutSec: number;
  dryRun: boolean;
  debug: boolean;
  ask: boolean;   // critic が scope drift を検出したら human に 1 行 meta question を問う
}

export class ArgError extends Error {
  constructor(msg: string, public readonly hint?: string) {
    super(msg);
  }
}

export function parseRunArgs(argv: string[]): RunArgs {
  let agent: string | undefined;
  let verify: string | undefined;
  let maxTries = 10;
  let timeoutSec = 1800;
  let dryRun = false;
  let debug = false;
  let ask = false;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--agent":
        agent = argv[++i];
        break;
      case "--verify":
        verify = argv[++i];
        break;
      case "--max-tries": {
        const raw = argv[++i];
        const v = Number(raw);
        if (!Number.isFinite(v) || v < 1) {
          throw new ArgError(`--max-tries must be a positive integer (got: ${formatBadValue(raw)})`);
        }
        maxTries = Math.min(v, 50);
        break;
      }
      case "--timeout": {
        const raw = argv[++i];
        const v = Number(raw);
        if (!Number.isFinite(v) || v < 1) {
          throw new ArgError(`--timeout must be a positive integer in seconds (got: ${formatBadValue(raw)})`);
        }
        timeoutSec = v;
        break;
      }
      case "--dry-run":
        dryRun = true;
        break;
      case "--debug":
        debug = true;
        break;
      case "--ask":
        ask = true;
        break;
      default:
        if (a.startsWith("--")) {
          const suggestion = nearestFlag(a);
          const hint = suggestion ? `did you mean ${suggestion}?` : undefined;
          throw new ArgError(`unknown option: ${a}`, hint);
        }
        positional.push(a);
    }
  }

  if (!agent) {
    throw new ArgError(
      "--agent is required",
      "example: --agent \"claude -p\"",
    );
  }
  if (!verify) {
    throw new ArgError(
      "--verify is required (tasks with no completion criterion are not accepted)",
      "use plain claude -p directly. details: docs/scope.md",
    );
  }
  const task = positional.join(" ").trim();
  if (!task) {
    throw new ArgError("task body is empty");
  }

  return { agent, verify, task, maxTries, timeoutSec, dryRun, debug, ask };
}

const KNOWN_FLAGS = [
  "--agent", "--verify", "--max-tries", "--timeout",
  "--dry-run", "--debug", "--ask",
];

/** Suggest the closest known flag for a typo (Levenshtein distance ≤ 2).
 *  Returns undefined when nothing is close enough — better to say nothing
 *  than to suggest a wrong fix. */
function nearestFlag(input: string): string | undefined {
  let best: { flag: string; dist: number } | undefined;
  for (const f of KNOWN_FLAGS) {
    const d = levenshtein(input, f);
    if (d <= 2 && (!best || d < best.dist)) best = { flag: f, dist: d };
  }
  return best?.flag;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

/** Render an out-of-range / unparseable arg value back to the user.
 *  undefined → "(missing)" so they see the flag had no value at all. */
function formatBadValue(raw: string | undefined): string {
  if (raw === undefined) return "(missing)";
  return `"${raw}"`;
}
