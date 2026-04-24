# Shibaki scope (accepted tasks)

Acceptance is decided **only by whether an objective completion signal exists**.
The moment subjectivity enters, the critic loses traction and the North Star
collapses.

---

## Tier 1: accepted

**Definition**: tasks where "done" can be judged by the exit code of a single command.

| Category | Example | verify command example |
|---|---|---|
| Fix failing test | "make this test pass" | `bun test path/to/test.ts` |
| Type errors | "make tsc clean" | `tsc --noEmit` |
| Lint / format | "fix eslint violations" | `eslint src/ --max-warnings 0` |
| Build pass | "make the build pass" | `bun run build` |
| Arbitrary script | "make this script exit 0" | `./scripts/check.sh` |

**The critic's job**: while the agent works toward that signal, watch for cheats
(test skip, `@ts-ignore`, mock bypass) and push back with concrete evidence.

---

## Tier 2: future

**Definition**: tasks where the user can explicitly state success criteria.

- Refactors ("change X to Y, behavior unchanged" + all existing tests pass)
- New features (only when acceptance criteria are passed via `--accept`)

Currently rejected. Asking the user to write acceptance criteria is close to
adding a setting knob, which is in tension with the simplicity principle.
Tier 1 needs to mature first.

---

## Tier 3: never accepted

**Definition**: success is subjective / context-dependent.

- Design decisions ("which library should we use?")
- Documentation / comment generation
- Error message wording
- Vague commands like "clean up this code"
- UI visual tweaks
- Code review ("what do you think of this?")

**Why**: the critic cannot produce a counter-example → the user ends up
reading critic logs to decide → violates "humans don't enter the loop".

**Behavior**: Shibaki rejects and points the user to use the bare agent directly.
