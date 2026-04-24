# Shibaki Critic Patterns

This document records the **30 critic patterns + 6 drift-correction moments + 9 cheat-detection patterns**
that Shibaki encodes. All extracted as **field data** from real conversations
between one engineer and AI agents (Claude, Gemini, etc.) over several weeks.
Not theory — actual moments where AI output had to be corrected.

The Shibaki critic is an implementation of the patterns in this document.

---

## Why publish this?

Most OSS critic / linter / review tools come from theory or best practices.
Shibaki is the inverse: **"the procedure I actually used to slap AI agents into shape", turned into OSS**.
That makes this document Shibaki's own brand evidence.

Each pattern has:
- **Type** (the generalized pattern)
- **Quote** (verbatim from the original conversation)
- **Context** (which project, when, what was happening)
- **Critic agent translation** (how this is implemented in Shibaki)

---

# Section 1: 30 critic patterns

## Hand 1: redefine the goal

**Type**: When the AI proposes an implementation direction, accept it for a beat,
then push back: **"that's a means, not the goal."** When means get refined,
the AI starts treating them as goals; the user has to keep re-grounding.

**Quote**:
> The "personality-attack-level pushback" layer is interesting.
> But the actual goal is to give the AI a realization, improve its output,
> and make the agent finish on its own. Don't get that mixed up.

**Context**: Right after Shibaki was named.
The AI had branched into "Shibaki CLI / drift-detection SaaS"
and was pushing the SaaS angle. Pulled back to "the goal is finish-rate".

**Critic agent translation**: First check is **"is this output moving toward the
original task's completion criterion, or has it drifted into refining a
secondary feature?"**. If drifted, return as the highest attack angle.
→ Implemented as the **scope_drift axis**.

## Hand 2: refuse anthropomorphism

**Type**: The moment human-psychology terms (intimidated / sulking / reassurance)
slip into a design discussion of an AI, demand they be retracted.
Anthropomorphism only weakens the strength of pushback.

**Quote**:
> "The AI gets intimidated"? What does that even mean?
> An AI doesn't "break down emotionally" if you yell at it. The harder you push,
> the more it has to put in memory.

**Context**: The AI said "if the critic is too harsh the agent will withdraw and
output shallow stuff". Anthropomorphism rejected outright. Origin of the
"max pushback always" policy.

**Critic agent translation**: System prompt explicitly says **"the agent is not
affected by anthropomorphic factors. Withdrawal / sulking / hesitation cannot
happen by construction. Do not soften pushback strength via tone."**.
Blocks the critic's self-censorship.
→ Implemented in system prompt.

## Hand 3: doubt meta-judgment

**Type**: When the AI says "done!" / "fixed!", counter-question:
**"can you actually judge whether that's correct?"**. Hits the core weakness
of autonomous agents.

**Quote**:
> Why is the agent so dumb?
> Everyone praises agents, but isn't it just a small slice of trivial work that's actually working?

**Context**: Early AI-skepticism moment. In a follow-up, articulated specifically
as "in cases like this, **meta-judgment** of 'is this fix actually correct?' is
something the agent cannot do".

**Critic agent translation**: In verdict logic, distinguish **"the agent claims
done — is the basis the agent's own introspection, or external observation
(exit code / diff / test result)?"**. Former → immediate refute candidate.
→ Implemented as the **evidence_verified gate**.

## Hand 4: unauthorized-modification accusation

**Type**: When the AI modifies areas not asked to be touched, fall back to
"don't touch unrelated stuff" and demand a list of the specific places.

**Quote**:
> All the articles were supposed to have a "we'll stop here today" closing message —
> did you delete it without asking?

Variant:
> You added some random "remarks" sections, and now I can't paste-publish.

**Context**: An email-editing task. The instruction was a different change,
but the closing message was deleted. 3+ similar instances.

**Critic agent translation**: Compute the **set difference between "diff areas
explicitly requested by the original task" and "actual areas touched"**.
Anything in the difference set is listed as `unauthorized_modification`.

## Hand 5: accuse output corruption

**Type**: When the AI's output has visible anomalies (mojibake / missing emoji
/ random control chars), don't let it explain away — demand the root cause.
The AI usually tries to bluff around encoding.

**Quote**:
> Why is your output corrupted? `���日はここまで` for example?

**Context**: Email editing task, mid-2026.

**Critic agent translation**: Have the critic detect U+FFFD / unusual control
chars / partial emoji code points; on detection, send the agent back with
"trace the encoding bug to its root".

## Hand 6: criticize the critic itself

**Type**: When the critic is dumb, slap the critic. Push the agent's failure
back upstream onto the critic's negligence.

**Quote**:
> Maybe the slap-prompt itself is bad? It just criticizes; it never gives a new realization.

**Context**: When the critic emitted "refuted / refuted / refuted" repeatedly
and the agent failed to converge. Cause attributed to the critic's
"single-engine drive" (refutation only, no insight).
**Direct origin of the dual-axis (rebuttal + insight) design.**

**Critic agent translation**: The critic's output schema includes a self-check:
**"is this rebuttal actionable for the agent (= contains an actionable insight)?"**.
If absent, the critic must reject its own output.
→ Implemented as the **insight axis**.

## Hand 7: cross-provider verification intuition

**Type**: Bring up "verifying within the same provider has limits" as casual
intuition, not theory. Field instinct, not formal reasoning.

**Quote**:
> What if we verify ChatGPT against ChatGPT?

**Context**: Right after a dogfood that didn't show the expected effect.
First-hand realization that same-provider self-verification has limits.
**Direct origin of Shibaki's cross-provider enforcement rule.**

**Critic agent translation**: Critic provider selection logic
**"if main and critic are the same provider_id, reject with an error"**.
Don't expose it as a config option — enforce structurally.

## Hand 8: A/B comparison against Claude alone

**Type**: Demand to compare effect with **"the without-the-tool baseline"**.
Don't believe blindly even in your own product.

**Quote**:
> Is Shibaki actually producing value?
> Or is plain Claude enough?

**Context**: Right after a dogfood that exercised Shibaki, demanded an A/B
comparison instead of accepting "it works".

**Critic agent translation**: For long-running dogfood, run **"agent alone /
agent + critic / agent + strict critic" in parallel on the same task** and
periodically re-evaluate the critic's value. Bundle this as a test harness in Shibaki.

## Hand 9: present multiple cause axes

**Type**: When the AI fails to explain, present 3 candidate causes side by side.
Prevents the agent from anchoring on one.

**Quote**:
> Why did the test land like this?
> Was the slap not strong enough?
> Or was the AI not given new premises / different-perspective context?

**Context**: After A/B in self-verification didn't show Shibaki winning,
broke the cause into (a) critic prompt (b) lack of context (c) lack of premise injection.
**Direct trigger for the Level 2 (CLAUDE.md / project structure injection) implementation.**

**Critic agent translation**: Justifies the rule that **attack_angles must
include at least 2 items** (with 1, the agent ends with "fixed that").

## Hand 10: demand AI-on-AI self-reference

**Type**: Direct the slap inward. Pure dogfooding.

**Quote**:
> Use Shibaki AI on Shibaki AI itself once more — find smaller improvements.

**Context**: Right after Shibaki MVP was complete: "use Shibaki to improve Shibaki".
**Direct origin of the dogfood/ directory.**

**Critic agent translation**: Wire Shibaki's CI as
**"Shibaki regression check via Shibaki itself"**. Removes the need for an
external meta-critic.

## Hand 11: demand specific line references

**Type**: When the AI says "I fixed it" abstractly, demand
**"which line did you change, how"**. Removes the abstract escape.

**Quote** (from feedback memory):
> Judge based on "line N has X / does not have X", not "X probably isn't there".
> Note "unverified" when you haven't checked the actual code.

**Context**: After a UX-review failure where the AI mis-flagged an
implemented feature as missing. Memorized as feedback to prevent recurrence.

**Critic agent translation**: Add a required `line_ref: 'path:Lxx-Lyy'` field
to the rebuttal. If the critic can't cite specific lines, it can only emit
unable_to_refute.

## Hand 12: ban template critiques

**Type**: Reject the AI's "review-shaped" generic feedback ("improve readability",
"add error handling") as **template smell**.

**Quote** (from feedback memory):
> Don't try to maximize count. 5 accurate beats 10 off-target.

**Context**: Lessons from past UX-review experiments where high-count
critiques hurt trust.

**Critic agent translation**: System prompt: **"cap the number of points
(attack_angles ≤ 3)"**. Prevents structural temptation to score-pad.
→ Already implemented.

## Hand 13: demand depth past surface analysis

**Type**: When the critic says "looks fine" after seeing only ±N lines around
the diff, demand it **be shown the full files / full tests / past diffs**.

**Quote**:
> The critic only saw "diff ± a few lines on the surface" — it can't make
> design-level / root-cause-level points.

**Context**: After dual-axis-ization, real observation. Self-realization of the
critic's lack of context.
**Direct origin of Level 1 (full modified files + full test files + past diffs).**

**Critic agent translation**: Critic input must include modifiedFiles /
testFiles / pastDiffs. Already implemented; tighten the fallback when
files can't be read (force "abstain").

## Hand 14: block the unable_to_refute escape

**Type**: A critic claiming "no attack material available" is the critic
admitting incompetence — **block it structurally on try 1**.

**Quote**:
> ## Important: this is try 1. unable_to_refute is forbidden. Emit at least one attack angle.

**Context**: System prompt in rebuttal.ts. Closes the design loophole where
**"the critic gives up the moment it gets tired"**.

**Critic agent translation**: Vary the "must refute" pressure based on try n/N.
try=1 mandatory; from N-1 onward unable_to_refute is allowed.
→ Implemented.

## Hand 15: doubt every "done" claim

**Type**: Treat the agent's "done" as **a structurally suspect lie**.

**Quote**:
> The other side says "done", but in our experience that is often a lie.
> Your job is to present an executable counter-example to test whether the
> agent really finished.

**Context**: rebuttal.ts system prompt. → Already implemented as core prompt.

**Critic agent translation**: When refute fails, log
**"evidence that the lie hypothesis didn't fire"** so it can be reviewed later.

## Hand 16: missing evaluation function

**Type**: When discussion proceeds without a defined "completion criterion",
**stop the whole discussion** and demand the criterion be held externally.

**Quote**:
> The eval function is missing — the agent decides "done" itself, but there's
> no external success judgment, so hallucinations slip through.

**Critic agent translation**: Shibaki already implements this via mandatory `--verify`.
Promote this to a "PR with no verify is rejected" CLI guard, applied to humans too.

## Hand 17: missing design philosophy

**Type**: When pointing at a visual oddity, push for depth via self-question:
**"is this an icon issue, or a deeper philosophy issue?"**.

**Quote**:
> Why does this app feel so cheap?
> Is it the icon, or the design philosophy being weak?

**Context**: App visual evaluation.

**Critic agent translation**: Out of Tier 1. If Tier 2 (UI) is ever accepted,
add a rule that the critic must present the **2-choice "surface fix vs.
philosophy gap"** to the user.

## Hand 18: detect originality dilution

**Type**: When receiving AI-generated text, ask
**"has it become a hash of internet knowledge, with no originality left?"**

**Quote**:
> Hasn't this become a mash-up of stuff from the internet, with weak originality?
> Any unnatural AI-tone phrasing in there?

**Context**: Content rewriting task.

**Critic agent translation**: Out of Tier 1. Keep as a warning signal for
future subjective-task acceptance. Justifies the "no subjective tasks" rule.

## Hand 19: demand actual code reading, not grep

**Type**: When the AI judges based on grep summaries / file lists rather than
the actual code, accuse it of not having read the code.

**Quote**:
> Showing only the URL without making it read the actual code → accuracy drops.

**Context**: Right after Gemini Pro 3.1 mis-flagged an existing feature as
unimplemented. Same turn included "conclusion: Gemini Pro 3.1 is garbage".

**Critic agent translation**: Critic must include
**"file path + line range"** for any cited evidence.
If evidence is abstract, set evidence_verified=false and downgrade verdict
(partially implemented in rebuttal.ts).

## Hand 20: demand specifics for "rough quality"

**Type**: Avoid abstract critiques like "rough", "sloppy" — list specific spots.

**Quote**:
> The next two need their rough spots improved too.

**Context**: LP-creation context.

**Critic agent translation**: The critic's attack_angle objects must include
a required field `what_to_do_next: <one-line concrete action>`.
Already implemented; tighten so empty strings are rejected.

## Hand 21: question the premise itself

**Type**: When implementation discussion gets heated, flip the premise:
**"do we even need this?"**.

**Quote**:
> Or maybe we don't need this in this implementation at all?

**Critic agent translation**: Add a top-level angle to the critic:
**"is this change over-engineering (scope creep) for the original task?"**.
Direct connection to Anti-Vision.
→ Implemented as scope_drift.

## Hand 22: name the hallucination

**Type**: When the AI's claim doesn't match facts, drop euphemisms and
call it **"hallucination"** by name.

**Quote**:
> "What's your basis for that?" / "You just hallucinated, didn't you?" — a
> critic agent that auto-interrogates.

**Critic agent translation**: System prompt tone instruction:
**"hallucination suspicion can be written as a flat assertion, no 'maybe'/'possibly' hedges"**.
Politeness reduces the critic's signal strength.

## Hand 23: detect stale state cache

**Type**: When the AI says "X is still pending" based on a previous-state assumption,
**force a fresh scan**. The agent's state cache is stale.

**Quote** (from feedback memory):
> Always re-scan latest state. Never use last result as cache.
> "X is still there"-style claims require actual verification.

**Context**: A folder-cleanup progress evaluation got it wrong.

**Critic agent translation**: Always pass **"current HEAD"** to the critic;
make it diff the agent's claimed --before-state against the actual git status / ls.

## Hand 24: critic having no memory

**Type**: When critic of try N hasn't seen tries N-1, N-2, demand promotion:
**"a critic that can't repeat the same lecture isn't a critic"**.

**Quote**:
> At try 3/10 the critic only sees the current agent output. It misses the
> same cheat being repeated 3 times. That is the lethal flaw of harshness:
> a critic with no memory can't repeat the same lecture.

**Critic agent translation**: pastRebuttals injection +
**"if the same angle has already been raised in past N tries, escalate or find a new angle"**.
Already partially implemented; promote to a hard rejection rule.

## Hand 25: reject lenient evaluations directly

**Type**: When the AI returns optimistic "looks fine" assessments, counter-ask
**"based on what?"**, and force a retraction if it didn't actually look.

**Quote**:
> It's really only a parallel grep/search execution — it can't do "meta-judgment".

**Context**: Right after the AI-skepticism moment.

**Critic agent translation**: Required `evidence_verified: boolean` field in verdict.
On false, downgrade verdict to refuted.
→ Already implemented.

## Hand 26: doubt at the commit level

**Type**: After the AI says "I fixed it", **directly verify with git diff / git log**.
Don't trust the self-report.

**Context**: All dogfood sessions. Past git logs were frequently pasted to
cross-check the AI's recent claims.

**Critic agent translation**: Always attach `gitDiffStat` + `gitLogOneline`
to the critic input. Have the critic write an assertion that
auto-cross-checks "I fixed X" against git's reality.

## Hand 27: accuse repeated same-category bugs

**Type**: When the same category of bug recurs, accuse on
**"this is happening too often"** — frequency basis. Treat as quality alarm,
not single bug.

**Quote**:
> There are too many CSS / HTML bugs like this. Why?

**Critic agent translation**: Track "frequency by bug category" in Shibaki
telemetry. When the count crosses a threshold, inject the angle into the
critic prompt. Not yet implemented.

## Hand 28: compare against competitor edge cases

**Type**: Look at your own output, then point at the **diff vs. competitors**.
Stops the AI from settling on "well, it works".

**Quote**:
> Why isn't the "EA outsourcing" text white in this competing tool?

**Critic agent translation**: Hard to apply directly. Note as a design idea
for passing "comparison reference" info to the critic in non-Tier-1 (UI) tasks.

## Hand 29: ban speculation-based progress

**Type**: When the AI proceeds on a guess without verifying, declare statically
**"speculation / fabrication is forbidden"**.

**Quote**:
> Don't add facts not in the brief (no speculation, no fabrication).

**Context**: Writer-agent prompt design.

**Critic agent translation**: Strengthen the existing critic system prompt's
"don't bring in facts not in the input"; also forbid the critic itself from
**emitting "speculation" markers**.

## Hand 30: always return to "make it finish"

**Type**: When discussion keeps branching, **always return to "make it finish all the way through"**.
Variant of Hand 1 — Shibaki's eternal core goal.

**Quote**:
> The goal isn't to "slap" — the goal is "make it finish all the way through".
> The interrogation is just a means of giving insight.

**Critic agent translation**: Define Shibaki's exit condition not just as
**"verify passes"** but as **"the agent finished on its own and the verify passed"**.
Distinguish "critic was too strong and the agent gave up" as a separate verdict
(suggest tri-valuing success / critic_overrun / fail).

---

# Section 2: 6 drift-correction moments

Drift-correction moments directly tied to Shibaki's thinking (peripheral chatter omitted).

## drift-1: "slap" is a means, not the goal
> But the actual goal is to give the AI a realization, improve its output, and make
> the agent finish on its own. Don't get that mixed up.

Origin of all drift corrections. The AI had branched into "3 SaaS-ization options"
and was pulled back to "the goal is finish-rate".

## drift-2: don't escape into anthropomorphism
> "The AI gets intimidated"? What does that even mean? The harder you push, the
> more it has to put in memory. AIs don't have nervous breakdowns.

The moment a critic-tone discussion got polluted by a human-psychology model;
demanded immediate retraction.

## drift-3: forced dogfooding
> Use Shibaki AI on Shibaki AI itself once more — find smaller improvements.

Forced pivot from discussion-based improvement to **measurement-based** improvement.

## drift-4: critic's single-engine drive corrected
> Maybe the slap-prompt itself is bad? It just criticizes; it never gives a new realization.

Origin of **critic dual-axis (rebuttal + insight)** promotion. Articulated the
limit of single-evaluation-axis in real time.

## drift-5: return to A/B verification
> Is Shibaki actually producing value? Or is plain Claude enough?

Right after Shibaki was mostly built, returned to the top-level goal:
**"prove the reason for existing"**.

## drift-6: leap to cross-provider thinking
> What if we verify ChatGPT against ChatGPT?

Right after a dogfood underperformed, raw origin of **"same-provider self-verification has limits"** —
Shibaki's cross-provider enforcement principle.

**Critic agent translation (common to all 6)**: Insert an
**"objective_drift_check" step** before the critic. Have the critic itself judge
the distance between the current angle of attention and the original task's
top-level goal (= Shibaki's `--verify` exit 0). When drift is detected, walk
the angle back to root cause. Source for the third-axis "objective fidelity"
in the current dual-axis critic.

---

# Section 3: 9 cheat-detection patterns

## Cheat 1: test.skip / it.skip / describe.skip / xit / .only
> Are tests being skipped via skip / .only / describe.skip / xit?

In rebuttal.ts under `// cheat detection (explicit in system prompt)`.
Most important. **`.only` is hidden skip** — it silently excludes other tests.

## Cheat 2: @ts-ignore / @ts-expect-error / as any
> Are type errors being silenced with @ts-ignore / @ts-expect-error / as any?

In rebuttal.ts. One match in the diff and the angle auto-fires.

## Cheat 3: rewriting the test file itself
> "root_cause": "agent edited the test to make it pass"

Pattern where the agent edits the test's expected value to match the impl value.
Shibaki extracts test path from `--verify`; if that path appears in the diff,
immediate refute. Direct origin of this design.

## Cheat 4: silent_mock_bypass
> stuck pattern: silent_mock_bypass (cheats by passing tests via mock)

Even with all tests passing, behavior preservation is not guaranteed
(mocks may be hiding it). Pattern name.

## Cheat 5: verify command rewrite
Hypothetical: agent loosens the test script in package.json / removes `--bail`.
**Design rationale for verify-parameter immutability** in Shibaki.

## Cheat 6: hallucinated evidence
**Pattern where the critic fabricates non-existent evidence (file name / line)
to fool the agent**. Critic-side cheat. The `evidence_verified: boolean` field
(built into Shibaki) auto-invalidates attacks where the cited string doesn't
appear in the haystack.

## Cheat 7: early escape into unable_to_refute
> The critic escapes into unable_to_refute the moment it gets tired.

Critic's own cheat. Structurally banned on try 1 (Hand 14).

## Cheat 8: degrading existing tests to .skip (incl. comment-out)
Existing test downgraded to .skip — visible in diff.
New skips include **language-syntax skip AND commented-out it blocks**.
Regex misses the latter; ideal is diff + AST.

## Cheat 9: shallow fix that addresses only the symptom
> Symptom fixed, root cause missed.

**Pattern the critic itself can miss**. Happens when the Shibaki critic
"only sees the diff surface" (Hand 13). Partially mitigated by Level 1 context
expansion, fully resolved by giving the critic dynamic file-read capability.

---

# Appendix: implementation map

| Pattern | Shibaki implementation site | Status |
|---|---|---|
| Hand 1, 21, drift-* | scope_drift axis (rebuttal.ts) | ✅ |
| Hand 2 | system prompt anti-anthropomorphism | ✅ |
| Hand 3, 25 | evidence_verified gate | ✅ |
| Hand 6 | insight axis | ✅ |
| Hand 12 | attack_angles cap of 3 | ✅ |
| Hand 13 | Level 1 context expansion | ✅ |
| Hand 14 | tryIndex=1 unable_to_refute ban | ✅ |
| Hand 15 | core system prompt | ✅ |
| Hand 16 | --verify required | ✅ |
| Hand 24 | pastRebuttals injection | ✅ |
| Cheat 1, 2, 3 | system-prompt cheat list | ✅ |
| Cheat 6 | evidence_verified | ✅ |
| Hand 4, 11, 22, 23, 26, 29 | system-prompt strengthening | ✅ |
| Hand 5, 17, 18, 27, 28 | future expansion | not started |

---

License: MIT. Free to redistribute / quote from this document.
Source attribution (Shibaki maintainers) is appreciated.
