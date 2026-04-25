# Security

Security model and implementation for Shibaki v0.2.

---

## Reporting

Please report security vulnerabilities directly, NOT via GitHub Issues:

- Email: **info@opport.jp**

PoC / repro steps appreciated.
We aim to send an initial ack within 72 hours of receipt.

---

## Implemented defenses

### Critic API key isolation
The agent subprocess does NOT inherit the critic's API key.

[src/agent/secretIsolation.ts](./src/agent/secretIsolation.ts) strips
critic-side keys and config from the env passed to `spawn()` whenever main
provider and critic provider differ:

```
main=anthropic + critic=openai → agent (claude -p) cannot see OPENAI_API_KEY
```

In **Plan mode** (CLI-backed critic — `anthropic-cli` / `gemini-cli` / `codex-cli`)
the critic holds no API key at all. The isolation step becomes a no-op for secrets,
but critic-side configuration (`LLM_PROVIDER_CRITICAL`, `LLM_MODEL_CRITICAL`, etc.)
is still stripped from the agent's env to prevent disclosure of the critic's setup.

opt-out: `SHIBAKI_ALLOW_AGENT_SECRETS=1` (for multi-provider agent CLIs that
need access).

### Pre-flight validation
On startup, validate critic key existence / format / provider separation.
Missing / malformed / same-provider all exit 2 with explicit guidance.

[src/cli/preflight.ts](./src/cli/preflight.ts):
- Missing key → exit with hint that includes a URL to obtain one
- Malformed (`sk-` / `sk-ant-` prefix check) → exit
- main/critic in the same provider family (e.g. both `anthropic` API) → reject
  (opt-out: `SHIBAKI_ALLOW_SAME_PROVIDER=1`)
- Plan mode (CLI critic): the API key check is skipped (no key exists), and
  same-family main/critic is auto-allowed on the assumption that the user is
  relying on model tiering (e.g. sonnet → opus) to mitigate the blind spot.
  CLI availability is verified by `shibaki doctor`.

### Cross-provider enforcement
Critic uses a different provider from main by default ([src/llm.ts](./src/llm.ts)).
Avoids LLM self-critique blind spots structurally.

### Multi-layer verdict
LLM output is validated through multiple layers before declaring completion:
1. Parser (defensive parsing via asString / asArray)
2. Parser-side rules (evidence_verified gate, attack_angles count)
3. Orchestrator-side rules (budget / max-tries / timeout)
4. `--verify` exit code (external truth source)
5. `--ask-human` flag (human-in-meta-loop)

### Secret hygiene
`.env.local` is in `.gitignore`. Same for the debug log directory `.shibaki/`.

### Release-time leak sweep — `shibaki audit-publish`
A deterministic layer separate from the critic loop. Run once before release / public push:

```bash
shibaki audit-publish .
```

Detects:
- Known secret patterns (OpenAI / Anthropic / GitHub / AWS / Stripe / PEM / JWT etc.)
- User forbidden strings (each line of `.shibaki/sensitive-strings.txt`) — register
  past project names / personal names / internal references, one per line
- The above patterns in git commit message / author / committer

Specifically targets a failure mode that traditional tools (gitleaks etc.)
miss: **the AI assistant unconsciously injecting cross-session context
(personal names / other project names) into commit messages**.

Not embedded in the dev iteration loop (avoids slowing down inner loop).

Recommended workflow:
1. Register strings to protect in `.shibaki/sensitive-strings.txt` (one per line, `#` for comment)
2. Run `./scripts/audit-publish.sh` right before release (runs Shibaki + gitleaks)
3. If clean, push. If detected, resolve and re-audit.

---

## OWASP LLM Top 10 (2023)

| ID | Name | Status |
|---|---|---|
| LLM01 | Prompt Injection | Out of scope (post-v0.2 candidate) |
| LLM02 | Insecure Output Handling | Agent's responsibility |
| LLM03 | Training Data Poisoning | N/A |
| LLM04 | Model DoS | budget guard + 5 MiB stdout/stderr cap |
| LLM05 | Supply Chain | User responsibility (`bun audit` etc.) |
| LLM06 | Sensitive Info Disclosure | Critic key isolation + debug log opt-in |
| LLM07 | Insecure Plugin Design | Shibaki IS the plugin layer |
| LLM08 | Excessive Agency | Agent CLI permissions are user-managed |
| LLM09 | Overreliance | Limits openly disclosed in self-verification.md, `--ask-human` keeps human involved |
| LLM10 | Model Theft | N/A |

---

## Out of scope (post-v0.2 candidates)

The following are NOT addressed in v0.2:

| Item | Description |
|---|---|
| Prompt injection defenses | Injection from CLAUDE.md / agent stdout / diff into the critic |
| Sandbox / containerization | Agent runs with the same process permissions as Shibaki |
| Rate limiting | Delegated to the LLM provider |

---

## User responsibilities

Things Shibaki does NOT take responsibility for (handle on your side):

1. **Trust of agent / verify commands**: user input is run via `sh -c` as-is
2. **Sandbox isolation**: the agent has unrestricted file system / network access; containerize if needed
3. **Secret hygiene**: handle `.env` / `.env.local` carefully, watch out for production env when using `--debug`
4. **Dependencies**: vulnerabilities in npm packages installed by `bun install` (run `bun audit` etc.)
5. **Debug log handling**: `.shibaki/` logs contain verify output / diff; review before pushing

---

## Changelog

- v0.2 (2026-04-25): 1-hop import expansion with path-traversal guard (rejects `../`, absolute paths, `node_modules`); subprocess stdout/stderr capped at 5 MiB; debug log moved to `~/.shibaki/logs/`; `--ask-human` is the canonical flag (`--ask` kept as alias).
- v0.1 (2026-04-24): initial release
