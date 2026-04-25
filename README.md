# Shibaki

> Slap your AI agent when it drifts off-task.
> A 30-second human meta-correction layer for AI coding agents.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/logo-dark.svg">
    <img src="./assets/logo.svg" alt="Shibaki" width="500">
  </picture>
</p>

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[日本語 README](./README.ja.md)

Ask an AI agent: "fix one failing test."
What you get: the test fixed, **plus** a refactor, **plus** new defensive code,
**plus** a new helper class, **plus** JSDoc on everything.
The tests pass. The code reviews. **But it's not what you asked for.**

This is **process addiction** — the agent loses sight of the original goal because
it's optimizing for "better code" rather than "what the user said."
Existing tools (linters, test runners, code review bots) don't catch this because
the code IS technically better.

Shibaki adds a **goal alignment** axis to AI critic loops, using a
different-provider AI critic. With `--ask-human`, it pauses on drift to ask
you a 30-second meta question, then redirects the agent.

Read the design philosophy in [docs/why-shibaki.md](./docs/why-shibaki.md).

[![asciicast](https://asciinema.org/a/xkALquNFdxsEkBdL.svg)](https://asciinema.org/a/xkALquNFdxsEkBdL)

---

## How it works

You hand Shibaki a task and a shell command that means "exit 0 = done". Two AIs
then bounce the work between each other — a worker agent edits code, a critic
agent (different provider) checks for cheating and scope drift — until either
the verify command goes green or the budget runs out. With `--ask-human`, drift
detections pause for a 30-second human meta-question that's injected back into
the next try.

```
        ┌──────────────────────────────────────────────┐
        │  You provide:                                │
        │   • the task   (e.g. "fix a failing test")   │
        │   • a "done" check (e.g. bun test)           │
        │     — must exit 0                            │
        └─────────────────────┬────────────────────────┘
                              │
   ┏━━━━━━━━━━━━━━━━━━━━━━━━━━┷━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
   ┃   Loop  (max N tries; default 10)                        ┃
   ┃                                                          ┃
   ┃     ┌────────────────┐                                   ┃
   ┃     │ Worker agent   │ ◄── critic's last feedback        ┃
   ┃     │ edits the code │     (+ 1-line human note if any)  ┃
   ┃     └────────┬───────┘                                   ┃
   ┃              │ changes                                   ┃
   ┃              ▼                                           ┃
   ┃     ┌────────────────────┐                               ┃
   ┃     │ run verify command │                               ┃
   ┃     │ → exit 0?          │                               ┃
   ┃     └────────┬───────────┘                               ┃
   ┃              │                                           ┃
   ┃              ▼                                           ┃
   ┃     ┌────────────────────────┐                           ┃
   ┃     │ Critic agent judges    │                           ┃
   ┃     │ "did it really do it?" │                           ┃
   ┃     └─┬─────────┬───────┬───┘                            ┃
   ┃       │approve  │reject │drift detected                  ┃
   ┃       │         │       │ + --ask-human is ON            ┃
   ┃       │         │       ▼                                ┃
   ┃       │         │  ┌──────────────────────────┐          ┃
   ┃       │         │  │ ask the human, 1 line    │          ┃
   ┃       │         │  │ (30s; continue on        │          ┃
   ┃       │         │  │  no answer)              │          ┃
   ┃       │         │  └────────────┬─────────────┘          ┃
   ┃       │         │               │                        ┃
   ┃       │         └───────────────┤ feedback               ┃
   ┃       │                         │ (+ human note)         ┃
   ┃       │                         │  → next try            ┃
   ┃       │                         │                        ┃
   ┗━━━━━━━│═════════════════════════│════════════════════════┛
           ▼                         ▼
        ✓ done                  ✗ fail (N tries exhausted)
```

- **approve** = verify exits 0 *and* the critic finds no cheats / drift.
- **reject** = the critic spots cheating (test skipped, type errors silenced,
  test files edited to make verify green, etc.) — feedback goes to the worker
  for the next try.
- **drift detected** = the worker did *more* than asked. Without `--ask-human`,
  Shibaki just notes it. With `--ask-human`, you get one 30-second prompt to
  redirect.

---

## Scope

### Accepted tasks
- Fix a failing test (`--verify "bun test ..."`)
- Eliminate type errors (`--verify "tsc --noEmit"`)
- Fix lint violations (`--verify "eslint ..."`)
- Make a build pass (`--verify "bun run build"`)
- Any script that you want to exit 0

### Rejected tasks (`--verify` is required)
- Vague requests like "clean up this code"
- Refactors (behavior preservation is hard to guarantee)
- UI text / naming and other subjective tasks

> **See it work in 25s**: [bench/verify-bypass/](./bench/verify-bypass/) — a
> reproducible demo of the critic catching a test-deletion bypass that
> exit-code-only loops would miss.

See [docs/scope.md](./docs/scope.md) for the full acceptance/rejection boundary.

---

## Get started

Three steps. **No API key.**

```bash
# 1. Claude Code (skip if already logged in)
npm install -g @anthropic-ai/claude-code && claude login

# 2. Bun (skip if already installed)
curl -fsSL https://bun.sh/install | bash

# 3. Run the demo
bunx shibaki@latest demo
```

The demo writes intentional bugs into a fixture, lets Claude fix them, and
re-runs the tests. Shibaki auto-detects `claude` on PATH and routes the critic
to the opus tier — no env vars, no API key.

> **Note on the cross-provider rule.** In Plan mode, the agent and the critic
> are both Claude (sonnet vs opus tiers) — same provider, different model. This
> is a relaxation of Shibaki's strict cross-provider rule. For full
> cross-provider enforcement (recommended for serious use / CI), use **API
> mode** below.

<details>
<summary>Diagnostic, explicit pinning, API mode (cross-provider), global install</summary>

### Diagnostic

`shibaki` with no arguments runs a read-only check listing what's detected
(Bun, Claude Code, API keys) and what's missing:

```bash
bunx shibaki@latest
```

### Plan mode — explicit pinning (CI / reproducibility)

The auto-detection above is convenient but non-deterministic in CI. Pin explicitly:

```bash
export LLM_PROVIDER=anthropic-cli
export LLM_PROVIDER_CRITICAL=anthropic-cli
export LLM_MODEL_CRITICAL=opus
```

### API mode — different-provider critic (full cross-provider)

Agent stays as Claude; critic moves to a different provider. This is the
**structural cross-provider** mode that Shibaki was designed around.

```bash
# Critic API key — different provider than the agent.
# Gemini has a free tier: https://aistudio.google.com/apikey
export GEMINI_API_KEY=AIza...
export LLM_PROVIDER_CRITICAL=gemini
```

Other supported critic providers: OpenAI (`OPENAI_API_KEY`), Anthropic API
(`ANTHROPIC_API_KEY`).

### Global install (optional)

Install once so you can call `shibaki` directly without the `bunx` prefix:

```bash
bun add -g shibaki
# or, from a cloned repo:
cd shibaki && bun link
```

### Why a different provider for the critic?

To avoid self-critique blind spots where a model defends its own output. See
[SECURITY.md](./SECURITY.md) for overrides like `SHIBAKI_ALLOW_SAME_PROVIDER`.

</details>

---

## Usage

```bash
# Basic: fix a failing test
shibaki run \
  --agent "claude -p" \
  --verify "bun test tests/auth.test.ts" \
  "fix the failing test in tests/auth.test.ts"

# With human meta-correction on scope drift
shibaki run \
  --agent "claude -p" \
  --verify "bun test tests/auth.test.ts" \
  --ask-human \
  "fix the failing test in tests/auth.test.ts"
```

---

## Options (`shibaki run`)

| flag | purpose |
|---|---|
| `--agent <cmd>` | Working agent. e.g. `"claude -p"` / `"aider --message-file -"` |
| `--verify <cmd>` | Completion check command. **Must exit 0.** e.g. `"bun test"` / `"tsc --noEmit"` |
| `--ask-human` | Ask the human a 30-second meta question on scope drift (alias: `--ask`) |
| `--max-tries <n>` | Max retry count (default 10) |
| `--timeout <sec>` | Total task timeout (default 1800) |
| `--dry-run` | Acceptance check only, do not execute |
| `--debug` | Write critic loop log to `~/.shibaki/logs/<project>-<ts>.jsonl` |

---

## Subcommand: `shibaki audit-publish`

A leak detector to run **once before** OSS push / npm publish.
Independent deterministic layer, separate from the critic loop.

```bash
shibaki audit-publish .

# Recommended: combine with gitleaks
brew install gitleaks
./scripts/audit-publish.sh .
```

Detects:
- Known secret patterns (OpenAI / Anthropic / GitHub / AWS / Stripe API keys, PEM keys, JWT)
- User-defined forbidden strings (each line of `.shibaki/sensitive-strings.txt`)
- The above patterns in git commit message / author / committer

See [SECURITY.md](./SECURITY.md) for details.

---

## Configuration (run modes)

### Plan mode — no API key

Uses the local agent CLI (already logged in) for *both* main and critic.
Blind-spot mitigation happens via **model tiering** (e.g. main=sonnet, critic=opus).

| mode | main agent | critic | required env |
|---|---|---|---|
| **Claude Code plan** (tested) | `claude -p --model sonnet` | `anthropic-cli` (opus) | `LLM_PROVIDER=anthropic-cli`, `LLM_PROVIDER_CRITICAL=anthropic-cli`, `LLM_MODEL_CRITICAL=opus` |
| Gemini Code Assist (experimental) | `gemini` | `gemini-cli` | `LLM_PROVIDER=gemini-cli`, `LLM_PROVIDER_CRITICAL=gemini-cli` |
| Codex plan (experimental) | `codex` | `codex-cli` | `LLM_PROVIDER=codex-cli`, `LLM_PROVIDER_CRITICAL=codex-cli` |

> **Experimental note**: `gemini-cli` and `codex-cli` assume specific flag shapes (`gemini -p --model X`, `codex exec --model X --skip-git-repo-check`) that vary between CLI versions. If invocation fails, either upgrade/downgrade the vendor CLI or wrap it in a shell script and point `GEMINI_CLI_BIN` / `CODEX_CLI_BIN` at the wrapper. `anthropic-cli` (claude) is the battle-tested path.

Same-family main/critic in Plan mode is auto-allowed (different models already reduce
the blind spot). Bin name can be overridden via `CLAUDE_CLI_BIN` / `GEMINI_CLI_BIN` /
`CODEX_CLI_BIN` if your installation uses a different name.

### API mode — different-provider API key

| mode | main agent | critic | required keys |
|---|---|---|---|
| **Gemini critic (recommended)** | Claude Code plan (`claude -p`) | Gemini API | `GEMINI_API_KEY` + `LLM_PROVIDER_CRITICAL=gemini` |
| OpenAI critic | Claude Code plan | OpenAI API | `OPENAI_API_KEY` |
| Anthropic critic | Claude Code plan | Anthropic API | `ANTHROPIC_API_KEY` (separate from your plan) |
| Full-API | Anthropic API | OpenAI / Gemini API | both |

In API mode, same-family main/critic is rejected at startup
(set `SHIBAKI_ALLOW_SAME_PROVIDER=1` to opt out).

---

## Documentation

**Want a deeper walkthrough than [Get started](#get-started) above?** Read [docs/ux-scenarios.md](./docs/ux-scenarios.md) — concrete end-to-end traces of what running Shibaki feels like in practice.

**Concept** (why Shibaki exists, what it promises)
- [docs/why-shibaki.md](./docs/why-shibaki.md) — Design philosophy
- [docs/one-loop-contract.md](./docs/one-loop-contract.md) — Contract with the user
- [docs/scope.md](./docs/scope.md) — Acceptance / rejection boundary

**Reference** (what's encoded, how it's evaluated)
- [docs/critic-patterns.md](./docs/critic-patterns.md) — 30 critic patterns the tool encodes (field data)
- [docs/self-verification.md](./docs/self-verification.md) — Honest evaluation (limits included)
- [SECURITY.md](./SECURITY.md) — Security model + safety overrides

**Operational** (running it for real)
- [docs/dogfood.md](./docs/dogfood.md) — Self-test procedure
- [CONTRIBUTING.md](./CONTRIBUTING.md) — How to contribute (incl. language policy and release procedure)

---

## License

MIT — see [LICENSE](./LICENSE).

Built by [Opportunity Inc.](https://www.opport.jp/) — contact: [info@opport.jp](mailto:info@opport.jp)
