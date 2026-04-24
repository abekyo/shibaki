// `shibaki audit-publish` sub-command — final sweep before release / public push.
// Independent from the critic loop, deterministic, no LLM calls.
import { auditDirectory, type Leak } from "../audit/leakDetector.ts";
import { resolve } from "node:path";

export async function cmdAuditPublish(argv: string[]): Promise<number> {
  let dir = ".";
  let noGit = false;
  let depth = 200;
  let customPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-git") noGit = true;
    else if (a === "--depth") depth = Number(argv[++i]) || 200;
    else if (a === "--custom-strings") customPath = argv[++i];
    else if (a === "--help" || a === "-h") {
      process.stdout.write(HELP);
      return 0;
    } else if (a.startsWith("--")) {
      process.stderr.write(`✗ unknown option: ${a}\n`);
      return 2;
    } else {
      dir = a;
    }
  }

  const cwd = resolve(dir);
  process.stderr.write(`▶ Shibaki audit-publish: ${cwd}\n`);

  let result;
  try {
    result = await auditDirectory({
      cwd,
      customStringsPath: customPath,
      scanGitHistory: !noGit,
      gitHistoryDepth: depth,
    });
  } catch (e: any) {
    process.stderr.write(`✗ audit error: ${e?.message ?? e}\n`);
    return 1;
  }

  process.stderr.write(
    `  scanned: ${result.scannedFiles} files / ${result.scannedCommits} commits / ${result.customStringCount} custom strings\n`,
  );

  if (result.ok) {
    process.stderr.write(`✓ no leaks, safe to release\n`);
    process.stderr.write(`  recommendation: also run gitleaks / trufflehog as a second pass\n`);
    return 0;
  }

  // group by location for compact output
  const grouped = groupByLocation(result.leaks);
  process.stderr.write(`\n✗ ${result.leaks.length} potential leak(s) found:\n\n`);
  for (const [loc, leaks] of grouped) {
    process.stderr.write(`  📍 ${loc}\n`);
    for (const l of leaks) {
      const lineRef = l.line ? `:L${l.line}` : "";
      process.stderr.write(`     [${l.kind}/${l.patternId}]${lineRef}  ${l.description}\n`);
      process.stderr.write(`        → ${l.excerpt}\n`);
    }
    process.stderr.write("\n");
  }
  process.stderr.write(`  Resolve the above before releasing.\n`);
  process.stderr.write(`  Manage custom forbidden strings in: .shibaki/sensitive-strings.txt (one per line)\n`);
  return 1;
}

function groupByLocation(leaks: Leak[]): Map<string, Leak[]> {
  const m = new Map<string, Leak[]>();
  for (const l of leaks) {
    const arr = m.get(l.location) ?? [];
    arr.push(l);
    m.set(l.location, arr);
  }
  return m;
}

const HELP = `Shibaki audit-publish — leak sweep before release

Usage:
  shibaki audit-publish [<dir>] [options]

Arguments:
  <dir>                   directory to audit (default: current dir)

Options:
  --no-git                skip git history scan (file scan only)
  --depth <n>             git history depth (default: 200 commits)
  --custom-strings <path> path to forbidden-strings list (default: <dir>/.shibaki/sensitive-strings.txt)

Detects:
  - Known secret patterns (OpenAI / Anthropic / GitHub / AWS / Stripe / etc.)
  - PEM private key blocks / JWT tokens
  - User forbidden strings (each line of .shibaki/sensitive-strings.txt)
    → register past project names / personal names / internal references, one per line
  - The above patterns in git commit message / author / committer

On detection:
  exit code 1, summary of potential leaks. Blocks release.

Recommended workflow:
  - Do not run during development (slows down the loop)
  - Run once just before public push / npm publish
  - Pair with gitleaks / trufflehog for higher confidence
`;
