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

When an AI coding agent (Claude Code / Cursor / Devin / Copilot) goes beyond what
you actually asked, Shibaki — using a different-provider AI critic — catches the drift.
With `--ask`, Shibaki pauses to ask you a 30-second meta question, then redirects the agent.

Read the design philosophy in [docs/why-shibaki.md](./docs/why-shibaki.md).

[![asciicast](https://asciinema.org/a/7DGghK2axV9HjvsG.svg)](https://asciinema.org/a/7DGghK2axV9HjvsG)

---

## Get started

Shibaki runs on [Bun](https://bun.sh). Install if you don't have it:

```bash
curl -fsSL https://bun.sh/install | bash
```

Check your environment — Shibaki with no arguments runs a read-only diagnostic that
lists what's set up (Bun, Claude Code, an API key) and what isn't:

```bash
bunx shibaki@latest
```

If the diagnostic flagged anything, fill in the gaps:

```bash
# Claude Code (the working agent)
npm install -g @anthropic-ai/claude-code
claude login

# A critic API key — must be a different provider than the agent.
# Gemini is free, no card required: https://aistudio.google.com/apikey
export GEMINI_API_KEY=AIza...
export LLM_PROVIDER_CRITICAL=gemini
```

Then run the built-in demo — Shibaki writes intentional bugs into a fixture, lets
Claude fix them, and re-runs the tests:

```bash
bunx shibaki@latest demo
```

Why a separate critic key? Shibaki by default routes the critic to a *different* LLM
provider than the working agent. This avoids self-critique blind spots where a model
defends its own output. See [SECURITY.md](./SECURITY.md) for the override.

---

## What is "process addiction"?

Ask an AI agent: "fix one failing test."
What you get: the test fixed, **plus** a refactor, **plus** new defensive code,
**plus** a new helper class, **plus** JSDoc on everything.
The tests pass. The code reviews. **But it's not what you asked for.**

This is **process addiction** — the agent loses sight of the original goal because it's
optimizing for "better code" rather than "what the user said."
Existing tools (linters, test runners, code review bots) don't catch this because
the code IS technically better.

Shibaki adds a **goal alignment** axis to AI critic loops.

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
  --ask \
  "fix the failing test in tests/auth.test.ts"
```

To make `shibaki` available globally:

```bash
# Option A: bun link (from the cloned repo)
cd shibaki && bun link
shibaki --help

# Option B: install from npm
bun add -g shibaki
```

---

## Options (`shibaki run`)

| flag | purpose |
|---|---|
| `--agent <cmd>` | Working agent. e.g. `"claude -p"` / `"aider --message-file -"` |
| `--verify <cmd>` | Completion check command. **Must exit 0.** e.g. `"bun test"` / `"tsc --noEmit"` |
| `--ask` | Ask the human a 30-second meta question on scope drift |
| `--max-tries <n>` | Max retry count (default 10) |
| `--timeout <sec>` | Total task timeout (default 1800) |
| `--dry-run` | Acceptance check only, do not execute |
| `--debug` | Write critic loop log to `.shibaki/run-<ts>.jsonl` |

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

## Configuration (API key combinations)

| mode | main agent | critic | required keys |
|---|---|---|---|
| **Gemini critic (recommended)** | Claude Code plan (`claude -p`) | Gemini API | `GEMINI_API_KEY` + `LLM_PROVIDER_CRITICAL=gemini` |
| OpenAI critic | Claude Code plan | OpenAI API | `OPENAI_API_KEY` |
| Anthropic critic | Claude Code plan | Anthropic API | `ANTHROPIC_API_KEY` (separate from your plan) |
| Full-API | Anthropic API | OpenAI / Gemini API | both |

Same provider for main and critic is rejected at startup
(set `SHIBAKI_ALLOW_SAME_PROVIDER=1` to opt out).

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

See [docs/scope.md](./docs/scope.md).

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
