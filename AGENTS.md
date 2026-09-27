# Agent Guide — Bharat Stock Intelligence

For any coding agent (Claude Code, Codex, Cursor, …). Claude Code also loads `CLAUDE.md`
automatically; other agents should read it first — it holds the rules, the Definition of done,
and the service map. Domain orientation is in `CONTEXT.md`.

> The previous version of this file described a GPT-4o "agents/openai.yaml" registry and tools
> (read_files, search_codebase, a postgres MCP) that do not exist in this repo.
> Everything below is a real file; if you add or remove one, update this list in the same change.

## Non-negotiables (full text in CLAUDE.md)
1. **Done = the check ran and passed** — `npx tsc --noEmit`, `npx vitest run`,
   `backend-python/venv/Scripts/python.exe -m pytest src/server/__tests__/ src/server/tests/ tests/chatbot/`,
   `npm run schema:drift` for migrations. Signal/scoring changes also need backtest evidence
   (enforced by the `verify-gate.mjs` Stop hook).
2. **Verify against live production, not the code** — `scripts/sql.py` for read-only queries.
3. **Committed ≠ deployed** — `.ts` needs `pm2 restart bharat-server`; migrations need `npm run migrate:up`.
4. **One tracker** — findings go to `docs/audit-findings.md`; fix and close in the same pass by default.
5. **Commit by explicit path**, never `git add -A` — several sessions edit this repo concurrently.
6. **Never fabricate evidence** — a number a model reports about itself is not evidence; grade against realized returns.

## Rules (auto-scoped by `paths:` frontmatter — Claude Code loads each when you touch a matching file)
| File | Covers |
|---|---|
| `.claude/rules/recurring-bugs.md` | every bug class that has recurred — skim before any Python/SQL/TS |
| `.claude/rules/data-sources.md` | fetchers, provider ids, endpoint registry, "vendor is dead" protocol |
| `.claude/rules/scoring-authority.md` | the canonical ranking, the four signal tables |
| `.claude/rules/measurement.md` | how to measure edge, and every current verdict |
| `.claude/rules/ml-model-bugs.md` | models, promotion gates, measurement harnesses |

Rules apply even when you only *quote* a number without touching a file — read `measurement.md` then.

## Skills (`.claude/skills/<name>/SKILL.md`)
| Skill | Use when |
|---|---|
| `verify-gate-runner` | running the Definition-of-done checks |
| `deploy-and-verify` | taking a change from committed to live and queried back |
| `repo-doctor` | one consolidated health check (code, DB, frontend, logs) |
| `audit-loop` | turning audit findings into fixed, verified, immunized, closed rows |
| `weekend-audit` | weekly whole-system sweep |
| `session-close` | end-of-session log / memory / rules / findings update |
| `onboard-data-source` | adding a URL/API as a fetcher |
| `e2e-lifecycle-check` | tracing 10 real stocks through every pipeline stage |
| `production-grade-hardening` | outstanding production-readiness gaps |
| `run-bharat-stock-intelligence` | starting and driving the web app / screenshots |
| `trade-desk`, `screener-combo-predictor` | daily trading loop and intraday pick lists |
| `setup-matt-pocock-skills` | issue-tracker / label / domain-doc config |

## Review commands (`.claude/commands/*.md`, invoked as `/<name>`)
`production-debug` (live failure end-to-end) · `fetcher-accuracy-review` · `data-coverage-audit` ·
`measurement-integrity-review` · `ml-promotion-gate-review` · `migration-safety-review` ·
`trpc-surface-review` · `canonical-read-audit` · `cross-writer-collision-audit` ·
`data-honesty-review` · `deploy-reliability-review` · `job-runtime-audit` · `performance-audit` ·
`security-audit` · `signal-accuracy-review` · `temporal-correctness-audit` ·
`test-integrity-audit` · `threshold-calibration-audit`

## Subagents (`.claude/agents/`)
- `graphify-explorer` — codebase questions answered from the knowledge graph (`graphify-out/`).
- `fetcher-live-verifier` — fast gate: does a fetcher have its live test + freshness check?

When you spawn any subagent for code exploration, tell it to run `graphify query` first — the
PreToolUse hook only reminds the parent session.

## Hooks (`.claude/settings.json`, all `node .claude/hooks/*.mjs`, all unit-tested)
| Event | Hook | Does |
|---|---|---|
| SessionStart | `run-session-start.mjs` → `session-start.sh` | venv / POSTGRES_URL / Postgres socket / memory / graph-freshness check |
| PreToolUse Edit\|Write | `rules-pointer.mjs`, `env-guard.mjs` | names the rule file for the path; guards `.env` |
| PreToolUse Bash, Read\|Glob | `graphify-pointer.mjs` | query-the-graph-first reminder |
| Stop | `verify-gate.mjs` | blocks "done" if `.ts`/`.py` changed without the matching check (reads real Bash calls) |

Changing a hook: run `npx vitest run .claude/hooks` — `settings-hooks.replay.test.mjs` replays
every declared command. A hook that cannot run exits 0 silently and looks like a pass.

## Not for Claude Code
`bharat-*-skill.md` at the repo root and `HERMES_MIGRATION_GUIDE.md` belong to the Hermes agent
integration; Claude Code does not load them.

## Data sourcing contract
A source that stops returning data is never declared dead without: registry lookup →
`--find-alternates` → raw URL corpus → repo grep → route-by-route probing with the minimum headers
(start from NO headers) → only then ask the user for a captured browser request. Detail:
`.claude/rules/data-sources.md`.

## Handoff
Append a dated entry to `docs/session-log.md` (what changed, evidence, anything left open and why);
open items become `docs/audit-findings.md` rows. `/session-close` walks this.
