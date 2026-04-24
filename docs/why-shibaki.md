# Why Shibaki

A short essay on the layer that's missing in the LLM era.

The arguments in this document are backed by **30 critic patterns extracted
from real conversations** ([critic-patterns.md](./critic-patterns.md)).
Concrete records, not abstract claims.

---

## Observation 1: AI agents fall into "process addiction"

Ask an LLM agent (Claude Code / Cursor / Devin / Copilot) to "fix this failing test":

```
agent's behavior:
  ✓ fixed the failing test
  + also refactored other functions in auth.ts
  + also added defensive input validation across 3 files
  + also created a new AuthHelper class
  + also added JSDoc to every function
  + also rewrote types to be more strict
returned diff: 47 files / 1200 lines
```

This is **not "cheating"**. It's not a bug. The code review passes.
The tests pass. **But it's not what the user asked for.**

LLMs have a tendency to "make things better" — to over-engineer, to add
defensive code, to expand scope, to start "while we're at it" refactors.

We call this **process addiction**.

Real example (verbatim):

> All the articles were supposed to have a "we'll stop here today" closing
> message — did you delete it without asking?

> You added some random "remarks" sections, and now I can't paste-publish.

These are typical "agent touched things it wasn't asked to touch" cases.
Tests pass. Code is correct. **But not requested.**
([critic-patterns.md hand 4](./critic-patterns.md#hand-4-unauthorized-modification-accusation))

## Observation 2: Existing tools cannot catch this

| Tool | What it checks | Catches process addiction? |
|---|---|---|
| Linter (eslint, ruff) | Code style | ❌ no |
| Test runner | Code correctness | ❌ "extras" still pass tests |
| Code review (Codium / Copilot Review) | Code quality | ❌ would say "great improvement!" |
| Type checker | Type consistency | ❌ doesn't catch over-engineering |
| Claude Code's built-in self-review | Agent's own judgment | ❌ self-critique bias; the addicted agent doesn't stop itself |

These see **code-level correctness**. None of them check **"is this what the user asked for?"**.

## Observation 3: AI critic alone doesn't fix this

You'd think "just run a critic AI to stop the agent" — but it's structurally hard:

- The critic only sees a **subset** of the agent's information (just diff + verify result)
- The agent has full filesystem / multi-turn reasoning / search
- **You cannot give better-informed feedback with less information**
- Result: the critic can't override the agent's judgment, or it hallucinates attacks

Shibaki itself proved this in early implementation. Strengthening the critic
just made it look like a re-skin of existing tools, with no real value.

A direct quote from that period:

> Is Shibaki actually producing value? Or is plain Claude enough?

This was the question I asked myself right after implementing Shibaki.
If we don't beat plain Claude, the product has no reason to exist.
([critic-patterns.md hand 8](./critic-patterns.md#hand-8-ab-comparison-against-claude-alone))

## Observation 4: A 30-second human meta-correction solves it

Here's what works: when a human can say **"that's not what I asked for"** in
30 seconds, the agent immediately re-aligns:

```
agent: "I fixed the failing test, and also refactored along the way."
human: "Don't refactor — just the failing test."
agent: "Got it, reverting the refactor and recommitting."
```

This pattern is:
- **Far faster than code review** (60 seconds vs. 30 minutes)
- **Far more accurate than agent self-review** (the human knows the actual goal)
- **Keeps the human out of the loop body** (one 30-second touch, no detailed reading)

Shibaki implements exactly this **"human 30 seconds → agent finishes"** pattern.

## Shibaki's role

```
[AI agent] does the coding (most of the time)
[AI critic] catches scope drift from a different angle (Shibaki)
[Human] gives 30 seconds of meta correction (Shibaki invokes this when needed)
[AI agent] redirects and finishes (Shibaki drives the loop)
```

Shibaki = **a meta-collaboration scaffold between AI and human**.

Compared to existing categories:

| Existing category | How Shibaki differs |
|---|---|
| Linter / formatter | Code-level; Shibaki is goal-level |
| Code review tool | Post-hoc; Shibaki is pre-completion |
| Agent framework | Empowers the agent; Shibaki **stops** the agent |
| Critic-loop research | Aims at full automation; Shibaki **accepts 30 seconds of human time** |

## North Star (revised)

Old:
> "Get back what you don't have to fix."
> "Humans don't enter the loop."

New (this document):
> **"When AI falls into process addiction, a human reminds it of the goal in 30 seconds."**
> **"Humans don't enter the code loop, but they DO give meta-level course corrections."**

A real example of the same principle, expressed by the founder during early
development:

> The goal isn't to "slap" — the goal is "make the agent finish on its own."
> The slap is just a means to give the agent insight.

Even the product's own name — "Shibaki" (slap) — was once at risk of being
treated as the goal. That meta-correction is itself the pattern Shibaki encodes.
([critic-patterns.md hand 30](./critic-patterns.md#hand-30-always-return-to-make-it-finish))

## Why "Shibaki" (slap)

To "shibaku" (しばく) = to land a sharp meta-correction.
The critic isn't the only one who slaps. **The human slaps the AI for
30 seconds.** That's the core of this product.

## Three critic axes

Shibaki's critic evaluates the agent on three axes:

| Axis | What | Role |
|---|---|---|
| Refute | Cheats / rule violations / bugs | Standard critic territory |
| Insight | Meta-level observation about the approach | Educational |
| **Goal alignment (scope drift)** | Did the agent stay within the original task? | **Shibaki's unique axis** |

The third one is unique. It's what triggers the 30-second human intervention.

## Why isn't asking the AI directly enough?

"If Claude is smart enough, won't it notice on its own?" — fair counter.
But empirically:
- Modern Claude **doesn't outright cheat** (Constitutional AI works)
- But **process addiction doesn't stop** (over-helping isn't an alignment violation)
- The agent itself believes it's helping
- An **external goal-reminder** is needed

That's Shibaki's reason for existing.
