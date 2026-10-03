# Agent Guide — Bharat Stock Intelligence

For any coding agent (Claude Code, Codex, Cursor, …). Read in this order:

1. `CLAUDE.md` — the operating manual: rules, Definition of done, services, conventions.
2. `CONTEXT.md` — what the product is for and which contracts a change must preserve.
3. The rule file for the area you touch (table below).

This file is only the **inventory of agent tooling**. It holds no rules of its own, so it cannot
drift from `CLAUDE.md`. Every name below is a real file — `claude-config.test.mjs` fails if a
skill, command or subagent exists but is not listed here, or if a cited path does not exist.

## Rules (auto-scoped by `paths:` frontmatter — loaded when you touch a matching file)
| File | Covers |
|---|---|
| `.claude/rules/recurring-bugs.md` | every bug class that has recurred — skim before any Python/SQL/TS |
| `.claude/rules/data-sources.md` | fetchers, provider ids, endpoint registry, "vendor is dead" protocol |
| `.claude/rules/scoring-authority.md` | the canonical ranking, the four signal tables |
| `.claude/rules/measurement.md` | how to measure edge, and every current verdict |
| `.claude/rules/ml-model-bugs.md` | models, promotion gates, measurement harnesses |

Rules apply even when you only *quote* a number without touching a file — read `measurement.md` then.

## Skills (`.claude/skills/<name>/SKILL.md`, model-invocable)
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
| `run-bharat-stock-intelligence` | starting and driving the web app / screenshots |
| `trade-desk`, `screener-combo-predictor` | daily trading loop and intraday pick lists |

## Review commands (`.claude/commands/*.md`)
Invoked by the user as `/<name>`. All but `production-debug` carry `disable-model-invocation`, so
they stay out of the model's skill list; to run one yourself, Read the file and follow it.
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
integration (with the `*hermes*` scripts and `hermes-*.yaml`); Claude Code does not load them.
