# UX Scenarios

Scripted out user experiences (second-by-second) used to spot
"feels wrong" moments before writing code. Read these before changing
the loop UX.

---

## Scenario A: fix a failing test (the basic flow)

```
[00:00] User input
$ shibaki run \
    --agent "claude -p" \
    --verify "bun test tests/auth.test.ts" \
    "fix the failing test in tests/auth.test.ts"

[00:02] Shibaki
▶ task accepted (verify: bun test tests/auth.test.ts)
▶ try 1/10

[00:45] Shibaki
▶ try 2/10

[01:30] Shibaki
▶ try 3/10

[02:50] Shibaki
✓ done (2m50s / 3 tries)
  changes: src/auth.ts (+12 -3), tests/auth.test.ts (+2)
```

**Internally (not shown to the user)**:
- try 1: agent says "done" → verify fails → rebuttal: "AssertionError line 42" → retry
- try 2: agent says "done" → verify passes → rebuttal: "still fails on null input" → retry
- try 3: agent says "done" → verify passes → rebuttal: "no counter-example available" → done

**Sanity checks**:
- ✅ Human is not in the loop (principle 1)
- ✅ Critic is on a different provider (principle 2)
- ✅ Rebuttals come with counter-examples (principle 3)
- ✅ Progress tickers + critic verdict block shown per try

---

## Scenario B: eliminate type errors

```
[00:00] $ shibaki run --agent "claude -p" --verify "tsc --noEmit" "make all type errors go away"
[00:02] ▶ task accepted
[00:02] ▶ try 1/10
[01:40] ▶ try 2/10
[03:10] ✓ done (3m10s / 2 tries)
```

**Risk**:
- Agent might silence errors with `as any` / `@ts-ignore`
- The rebuttal critic must inspect the diff for these patterns
- "This type is essentially any, breaks at runtime with `{foo: null}`" → counter-example
- Force the agent to actually type properly on retry

**Hole**: detecting `@ts-ignore` requires the rebuttal to see the diff
→ Implementation: pass post-agent git diff to rebuttal input

---

## Scenario C: refactor (Tier 2 → rejected)

```
[00:00] $ shibaki run --agent "claude -p" --verify "bun test" "convert authService from class to function"
[00:01] ✗ failed: refactor tasks are not currently accepted
  reason: passing existing tests doesn't guarantee behavior preservation (mocks may hide it)
  alternative: use plain `claude -p` directly
```

**Currently rejected**. Tier 2 evaluation comes later, after the North Star is proven.

---

## Scenario D: giving up

```
[00:00] $ shibaki run --agent "claude -p" --verify "bun test" "fix this hard test"
[00:02] ▶ try 1/10
...
[12:40] ▶ try 10/10
[13:15] ✗ failed (10 tries / 13m)
  stuck pattern: silent_mock_bypass
  recommendation: check the test execution log manually
```

**Returns only the one-line pattern_name**. Critic logs are not shown.
Knowing "ah, it was trying to fake it with mocks" is enough for the user.

---

## Scenario E: reject when --verify is missing

```
[00:00] $ shibaki run --agent "claude -p" "refactor this nicely or whatever"
[00:01] ✗ Shibaki cannot accept this task
  reason: --verify is missing (no completion criterion)
  alternative: use plain `claude -p` directly
```

**Shibaki refuses ambiguous tasks**. This is the last gate that protects the
North Star.

---

## Sanity checklist (review before any UX change)

- [ ] User has nothing to type after submission
- [ ] Progress display is one line max
- [ ] Critic logs leak nowhere
- [ ] On failure, the return is just the pattern_name
- [ ] Rejection messaging clearly says "use the bare agent"
- [ ] The first 5 lines of help let a newcomer decide use/skip in 30s
