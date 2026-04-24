# One-Loop Contract

The contract between Shibaki and the user. **Features that break this contract will not be added.**

---

## What the user provides (only 3 things)

1. `--agent <cmd>` — the working agent command (e.g. `claude -p`)
2. `--verify <cmd>` — the completion-judgment command. Exit 0 = success.
3. The task body (natural language)

**Nothing else is asked of the user.** Settings like tone / personality /
critic log level will never be added (Anti-Vision §3).

## What Shibaki returns

- The artifact (file diff) and a single-line completion / failure status
- **After every try**: the critic's verdict + reason + (when refuted)
  attack angles, counter-example, evidence, and insight — printed to stderr
- **On success**: the loop terminates with `✓ done` and the cost summary

The critic's pushback is **shown by design**. Earlier versions hid it under
a "minimalism" principle, but that left users unable to evaluate whether the
critic earned its keep on a given run, and unable to distinguish a real catch
from a hallucinated retry. Transparency over minimalism.

What stays internal: the failure-mode dictionary contents (loaded once per
session, persisted at end) and the raw JSONL debug log (written only with
`--debug`).

## How waiting feels

- Each try prints in-place tickers: `↳ agent (Ns)` and `↳ critic (Ns)`,
  followed by the critic's verdict block when the rebuttal returns.
- Long-running tasks: `--detach` for background + completion notification (future)

## Completion criteria

- `--verify` exits 0
- AND the rebuttal critic returns `unable_to_refute`

## On failure

When max tries / budget is exhausted:

```
✗ failed (10 tries / 12m)
  stuck pattern: <pattern_name>
  recommendation: review manually
```

The per-try critic blocks above already explain *why* it failed; the final
line just summarizes the breach reason. The user is not asked to read or
react inside the loop — only after.

## Tasks not accepted

If `--verify` is missing, or the task is Tier 3 (subjective), Shibaki rejects:

```
✗ Shibaki cannot accept this task
  reason: --verify (completion command) is missing
  alternative: use plain `claude -p` directly
```

Details: [scope.md](./scope.md).
