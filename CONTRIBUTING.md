# Contributing to Shibaki

Thanks for your interest! Shibaki is small on purpose, so contributions are easy to land.

## Language policy

To avoid the worst UX regression — language mixing — Shibaki standardizes on:

| Surface                                | Language                          |
| -------------------------------------- | --------------------------------- |
| **User-facing CLI output**             | **English only** (stdout/stderr, error messages, hints, help text) |
| **Documentation in `README.md` / `docs/`** | English (Japanese mirrors live in `README.ja.md` / `docs/ja/`) |
| **Code comments / commit messages**    | Free choice — Japanese or English, whatever helps you think |
| **Test names**                         | Free choice                       |

Why: an English speaker who runs `shibaki --help` and gets back English should not then see Japanese in `shibaki run` or `shibaki audit-publish`. One language at a time, throughout a single user journey.

If you submit a PR that adds a new `process.stdout.write` / `process.stderr.write` / `throw new Error`, write the message in English. CI will not catch this — review responsibility.

## Setup

```bash
git clone https://github.com/abekyo/shibaki.git
cd shibaki
bun install
bun test tests/
bunx tsc --noEmit
bun run bin/shibaki.ts doctor
```

## Tests

- Unit tests live under `tests/`. Run them with `bun test tests/`.
- The `dogfood/` suite is a fixture for `shibaki demo`; it intentionally contains bugs and is not part of CI.

## Pull requests

- Keep PRs small and focused. Shibaki has one job (catch scope drift); features that don't serve that job belong in a downstream tool.
- Add a test if you fix a bug or add behavior.
- Update `docs/` when behavior or interfaces change. If you touch `docs/<file>.md`, also update `docs/ja/<file>.md` (or open an issue requesting the mirror).
- Run `bun run bin/shibaki.ts audit-publish --no-git .` before requesting review if you added strings or files — it catches accidental secrets.

## Release process (maintainer-only)

Shibaki uses a **single source-of-truth directory**: this repo (`shibaki/`) is the
only place to edit. The release procedure builds a clean snapshot at release time
only — there is no permanent "public" staging directory checked in here.

### Why allow-list, not exclude

The dev repo accumulates files that **must not** ship publicly:

- `.shibaki/run-*.jsonl` — `--debug` output containing your real tasks, agent
  stdout, raw diffs, critic reasoning. **Direct privacy risk.**
- `.shibaki/patterns.md` — failure / success pattern dictionary learned from
  your actual work. Reveals what tasks you got stuck on.
- `.shibaki/sensitive-strings.txt` — your own forbidden-strings list. Publishing
  it would broadcast the very strings you registered as private (and would let
  `audit-publish` self-deceive: it can't detect leaks of its own reference list).
- `.env` / `.env.local` — API keys.
- iCloud `* 2` / `* 3` duplicates, `.DS_Store`, `*.log`, `node_modules/`.

An exclude-list (`rsync --exclude=...`) is fragile: any new file the dev workflow
introduces is **public by default**, and you will not notice until something
private leaks. The release procedure below uses an **allow-list** (`rsync --include` +
`--exclude='*'`) so the inverse is true: anything not on the list stays local.

### Procedure

```bash
# 0. Local pre-flight in the dev repo
cd ~/Documents/Work/shibaki
bun test tests/
bunx tsc --noEmit
bun run bin/shibaki.ts doctor

# 1. Stage a clean snapshot in /tmp (NOT under ~/Documents — iCloud Drive
#    silently deletes nested .git directories, which breaks audit-publish).
rm -rf /tmp/shibaki-release
mkdir /tmp/shibaki-release

# 2. Allow-list copy. Only paths explicitly named here ship publicly.
#    Adding a new public file? Add it here AND verify it's audit-clean.
DEV=~/Documents/Work/shibaki
DST=/tmp/shibaki-release

# Top-level files (only these — no globs)
for f in README.md README.ja.md LICENSE SECURITY.md CONTRIBUTING.md \
         package.json tsconfig.json bun.lock .gitignore .npmignore; do
  cp "$DEV/$f" "$DST/$f"
done

# Public directories (recursive). Every directory below MUST be safe to ship.
# .shibaki/ is intentionally absent — it contains debug logs and your private
# sensitive-strings list.
for d in bin src tests dogfood docs assets scripts .github; do
  cp -R "$DEV/$d" "$DST/$d"
done

# 3. Strip the iCloud * 2 / * 3 / * 4 / * 5 duplicate cruft if any survived
find "$DST" -name '* 2' -o -name '* 3' -o -name '* 4' -o -name '* 5' \
  -o -name '* 2.*' -o -name '* 3.*' -o -name '* 4.*' -o -name '* 5.*' \
  -print -delete

# 4. Sanity-list what's about to ship. Eyeball this. STOP if anything looks
#    private (test data, personal notes, log files, ".shibaki/" anywhere, etc.)
find "$DST" -type f | sort

# 5. Fresh git history in the snapshot (no leaking of dev-side commit messages,
#    author names, private branches)
cd /tmp/shibaki-release
git init -b main
git add -A
git commit -m "Initial public release"

# 6. Final leak sweep — deterministic, no LLM calls. Catches secret patterns
#    (API keys, JWT, etc.) and any custom forbidden strings you registered.
bun run ~/Documents/Work/shibaki/bin/shibaki.ts audit-publish . --no-git
# Expect: "✓ no leaks, safe to release". If anything fires, STOP and resolve.

# 7. Push to GitHub (only after step 6 passes)
git remote add origin git@github.com:abekyo/shibaki.git
git push -u origin main

# 8. Publish to npm — pair this with step 7 atomically. The README's
#    onboarding flow (`bunx shibaki@latest`) returns 404 until the package
#    exists on npm; if you push the README first, visitors in that window
#    bounce.
npm login                 # if not already
npm publish --access public
```

### Why this shape

- **Single dir during dev** removes the "which copy am I editing?" confusion.
- **/tmp staging** sidesteps a real iCloud Drive bug where `.git/` under
  `~/Documents` gets reaped between commands.
- **Allow-list copy (step 2)** means any new file the dev workflow introduces
  is private by default. To make it public, you must explicitly add its path
  here — a forcing function against accidental leak.
- **Eyeball pass (step 4)** is the last human checkpoint. Trust nothing
  automatic when "private leak" is the failure mode.
- **Fresh `git init`** means the public history starts clean — no risk of
  past WIP commit messages or private author info leaking. Trade-off: you
  lose dev-side history. That is the intent.
- **`audit-publish` last** (before push) because it scans the exact files
  about to be pushed. Running it earlier scans something you might modify
  before push.
- **`npm publish` paired with the GitHub push** because the README's first
  command is `bunx shibaki@latest`. If you push the README to GitHub before
  publishing, anyone visiting the repo in that window gets a 404 from npm
  and bounces. The two operations are one atomic release.

## Reporting bugs / security issues

- General bugs: GitHub Issues.
- Security: see [SECURITY.md](./SECURITY.md). Do not open a public issue for vulnerabilities.

## License

By contributing, you agree your contributions are licensed under the MIT License (see [LICENSE](./LICENSE)).
