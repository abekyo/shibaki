# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-04-25

### Added

- **Plan mode**: API-key-less critic via local CLI (Claude Code / Gemini Code Assist / Codex plans). Auto-detected when `claude` is on PATH and no critic API key is set; routes to opus tier for the critic. (#1)
- **1-hop import expansion**: critic now sees files imported by modified files (relative imports only, capped at 5 files / 10 KB each) for deeper-than-surface analysis. Path-escape guard rejects `../etc/passwd`, `node_modules`, and absolute paths.
- **`--quiet` / `-q`** flag for CI / scripting (suppresses progress dialog, keeps the summary line).
- **`shibaki run --help`** (and other subcommands) now work, matching `gh` / `docker` / `git` convention.
- **Final-line output** locked as a machine-parseable contract for CI integration.
- **Braille spinner + expected-range hints** during slow phases (agent / critic) so long runs don't look hung.
- **"How it works" diagram** added to both English and Japanese READMEs.

### Changed

- **All code comments standardized to English** (~50 files, ~350 comments). Internal development language is now English, matching the existing English README / CLI / LLM prompts.
- **README restructured**: visceral "process addiction" hook moved to the top, Get started reduced to 3 steps with advanced setup folded into `<details>`, cross-provider rule's relaxation in Plan mode explicitly noted (avoids misleading OSS visitors).
- **`--ask` renamed to `--ask-human`** as the canonical flag name; `--ask` kept as an alias for backward compatibility.
- **Critic verdict is now surfaced to the user on every try** (transparency-over-stricture: principle 1 retracted because invisible critic = black-box-with-extra-cost UX).
- **On-brand verdict labels**: "slaps" / "approves" verbs with ANSI color symbols, replacing terse "refuted" / "unable_to_refute" passthrough.
- **Debug log path** moved from `<cwd>/.shibaki/run-<ts>.jsonl` to `~/.shibaki/logs/<project>-<ts>.jsonl` (centralized under user-home so logs don't scatter across repos and are easier to grep / archive).
- **Required-argument error reporting**: all missing required args reported at once instead of one-at-a-time round-trips.
- **`(required)` labels** added to `--agent` / `--verify` in help text.

### Fixed

- `demo` now prints the actually resolved critic provider rather than the misleading "default OpenAI" string.

### Security

- Path-traversal guard in 1-hop import expansion prevents reading files outside the repo (`../`, absolute paths) or under `node_modules`.

## [0.1.0] - Initial release

- Cross-provider AI critic loop (`shibaki run`).
- `--verify` external oracle (must exit 0 for completion).
- Cheat detection (`.skip`, `@ts-ignore`, test-file rewrite, verify-command rewrite, etc.).
- Subcommands: `demo`, `doctor`, `audit-publish`.
- Built-in cheat-bait dogfood fixtures.
