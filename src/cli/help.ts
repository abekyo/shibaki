// Help text は 2 段構成:
//  - SHORT_HELP_TEXT: `shibaki --help` の default。reference 用途、~20 行。
//  - HELP_TEXT (LONG): `shibaki --help-long` と `shibaki run --help` の中身。
//                     Before/After の物語 + run の全 option / env / scope 説明。
//
// 設計意図: 軽い reference は短く、深い学習は明示要求 (`--help-long`) 経由。

export const SHORT_HELP_TEXT = `Shibaki — Slap your AI agent when it drifts off-task.

Subcommands:
  run            Run a critic loop on an AI agent (main feature)
  demo           60-second built-in demo (intentional bug fix)
  doctor         Read-only environment diagnostic
  audit-publish  Leak sweep before public push / npm publish

Try first:
  shibaki doctor    # check environment
  shibaki demo      # see it work

Usage:
  shibaki run --agent <cmd> --verify <cmd> "<task>"
       [--max-tries N] [--timeout SEC] [--ask-human] [--debug] [--dry-run]

For more:
  shibaki run --help     # run-specific reference (options, env vars, scope)
  shibaki --help-long    # full reference + design philosophy
`;

export const HELP_TEXT = `Shibaki — Slap your AI agent when it drifts off-task.

Subcommands:
  shibaki run            Run a critic loop on an AI agent (main feature)
  shibaki demo           60-second built-in demo (intentional bug fix)
  shibaki doctor         Read-only environment diagnostic (run this first if it doesn't work)
  shibaki audit-publish  Leak sweep before public push / npm publish

Try first:
  shibaki doctor    # check environment
  shibaki demo      # see it work

Usage:
  shibaki run --agent <cmd> --verify <cmd> "<task>"

Before (without Shibaki):
  00:00 send a task → "done!" comes back
  00:05 run it → error → ask for fix → another part breaks
  00:30 finally works  (30 minutes captive)

After (with Shibaki):
  00:00 send a task
        ↓ (agent ↔ critic slap each other internally)
  00:08 usable artifact returns  (only the 30s of input was captive)

Options:
  --agent <cmd>      (required) Working agent (e.g. "claude -p")
  --verify <cmd>     (required) Completion check command. Must exit 0.
  --max-tries <n>    Max retry count (default 10)
  --timeout <sec>    Total task timeout in seconds (default 1800)
  --dry-run          Acceptance check only, do not execute
  --debug            Write critic loop full log to ~/.shibaki/logs/<project>-<ts>.jsonl
                     (not for normal use, for debugging false negatives).
                     The file contains your task text, agent stdout/stderr,
                     verify stdout/stderr, the working diff, and any human
                     meta answers — scrub it before sharing publicly.
  --ask-human        On scope drift, ask the human a 1-line meta question
                     and inject the answer into the next try (Shibaki's
                     core experience; off = fully automatic).
                     (alias: --ask  — kept for backward compat)

Environment:
  ANTHROPIC_API_KEY           For main agent (claude -p)
  OPENAI_API_KEY              For critic (different-provider, default openai)
  LLM_PROVIDER_CRITICAL       Override critic provider (anthropic | openai | gemini)
  LLM_MODEL_CRITICAL          Override critic model (e.g. gpt-4o)

  Safety overrides (advanced — read SECURITY.md before use):
  SHIBAKI_ALLOW_SAME_PROVIDER=1   Allow main and critic to use the same
                                   provider (default: refused, to avoid
                                   self-critique blind spots).
  SHIBAKI_ALLOW_AGENT_SECRETS=1   Do NOT strip the critic's API key from
                                   the agent subprocess env (default: stripped,
                                   so a malicious agent can't exfiltrate it).
                                   Only set if your agent CLI legitimately
                                   needs the same provider as the critic.

Accepted tasks (Tier 1):
  - Make failing tests pass     (--verify "bun test ...")
  - Eliminate type errors        (--verify "tsc --noEmit")
  - Fix lint violations          (--verify "eslint ...")

Rejected tasks:
  - Subjective ones (refactor / docs / design / UI text)
  - Tasks without --verify
  → use plain \`claude -p\` directly

Details: docs/scope.md / docs/one-loop-contract.md
`;
