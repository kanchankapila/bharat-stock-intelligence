---
name: production-grade-hardening
description: Work through this platform's outstanding production-readiness gaps one at a time — containerizing the 4 services, a declarative fetcher framework, knowable_at point-in-time correctness, dashboard-shell consolidation, and cost-aware validation of the two live measurement leads. Two items (backup verification, deploy-drift detection) are already done; this skill is for the rest. Use when asked to "make this production grade", "harden the platform", or to continue the production-readiness work.
---

# Production-Grade Hardening

This is a **multi-session roadmap**, not a single task. Each item below has a different risk
profile and a different amount of this repo's own evidence behind it — some are safe to just
implement, some need a live production run to verify, and at least two are product/architecture
decisions this skill must not make unilaterally. Read the whole file before starting any one
item; do not skip to "implement everything."

**The standing instruction that shaped this list**: take local, reversible actions freely; ask
before anything hard to reverse or high-blast-radius (`CLAUDE.md`'s operational-safety rules).
Every item below is tagged with which bucket it's in.

## 0. Already done — do not re-implement these

| Gap | Closed by | Where |
|---|---|---|
| `scripts/backup_pg.py` existed but was scheduled nowhere, so it had never run once | Verifies the dump's TOC at write time, stamps `job_heartbeat('pg-backup')`, scheduled nightly in `ecosystem.config.cjs` | `pg-backup-recency` check in `dataQualityChecks.ts` |
| "server N commits behind HEAD" (AF-14) was always caught by a human, never a check | `scripts/check_deploy_drift.mjs` compares git HEAD's committer time against `bharat-server`'s pm2 boot time, every 15 min | `deploy-drift` check in `dataQualityChecks.ts` |

Both are documented in `docs/session-log.md`'s 2026-08-19/20 entries, including exactly what was
and was not verified (this work was done from a machine that is **not** the production host —
see `/memories/repo/dev-vs-prod-machine.md` — so `tsc --noEmit`/`vitest run` on those changes are
still owed on the real box). **Before starting anything else in this skill, run those two now if
they haven't been run yet**: `npx tsc --noEmit`, `npx vitest run`, and one real invocation of
`node scripts/check_deploy_drift.mjs` + `python scripts/backup_pg.py` on the prod host, then a
real `--restore` drill into a throwaway database. An untested backup is a belief, not a backup.

## 1. Before touching anything — re-verify the ground truth, don't trust this file's dates

This file will go stale the moment the codebase moves. Before acting on any item below:

- Run `/deploy-reliability-review`, `/performance-audit`, and `/security-audit` (already in
  `.claude/commands/`) to re-derive the current gap list from the live repo, not from memory of
  this one. **A rule file or skill is a claim with a date on it — the code is the authority**
  (`recurring-bugs.md`'s own master rule, which has cost this repo real time when violated).
- Check `graphify-out/GRAPH_REPORT.md`'s freshness hash against `git rev-parse HEAD` before
  trusting it for architecture questions.
- Confirm which machine you're on. If it's not the production host, you can write and
  syntax-check code, but you **cannot** verify it end-to-end — say so explicitly rather than
  presenting a `py_compile`/`node --check` pass as "verified." See
  `/memories/repo/dev-vs-prod-machine.md`.

## 2. Containerize the 4 app services — additive, do this next

**Bucket: safe to implement, needs a real Docker build to verify.**

There is no `Dockerfile` anywhere; `docker-compose.yml` only containerizes Redis + TimescaleDB.
The app itself runs bare-metal under pm2. This has already caused a real incident class:
"declared ≠ installed" (`node-pg-migrate` in `package.json` but never `npm install`ed; `nse` in
`requirements.txt` but not in the venv — both broke a live job for days).

Do this **additively** — it must not remove the pm2 bare-metal path, only offer a second,
reproducible one:

1. One `Dockerfile` per service (`bharat-server`, `ml-api`, `chatbot`, `alphaquant-api`), each
   pinned to the exact runtime the corresponding `venv`/`node_modules` uses today. Read
   `requirements.txt` (root, for `ml-api`/`chatbot`) and `backend-python/requirements.txt` (for
   `alphaquant-api`) — do not assume they're identical.
2. **Preserve the CPU-torch-first install order** from `.github/workflows/ci.yml` — the comment
   there explains why: installing CPU torch first is what makes it the build everything else
   (`transformers`, `sentence-transformers`) resolves against, or you silently get a multi-GB
   CUDA wheel on a machine with no GPU.
3. Add these as **new, additional** services in `docker-compose.yml` (or a
   `docker-compose.override.yml`), not a replacement for the pm2 config. Anyone can still run
   bare-metal.
4. **Verify with a real build**, not a syntax read: `docker build` each image, `docker compose up`
   the full stack, confirm all 4 services actually serve traffic and reach Postgres/Redis. If you
   are not on a machine with a Docker daemon, say so and stop at "written, unbuilt" rather than
   claiming this is done.

## 3. Deploy-drift and backup checks need a real production run

Already implemented (see §0) but only syntax-verified. This is the cheapest remaining item:
`pm2 reload ecosystem.config.cjs` on the prod host, wait one cycle of each new job, confirm
`deploy-drift` and `pg-backup-recency` both go green in `dataQualityChecks`' output, and do one
real `--restore` drill.

## 4. Cost-aware validation of the two live measurement leads

**Bucket: needs the production Postgres instance + pandas. Cannot be done from a dev machine.**

`measurement.md` already identifies exactly two promising, unresolved leads — resolve these two
before building anything new; they're worth more than new infrastructure:

- **The capitulation triple** (`gap_down` AND `open_eq_low` AND `top_loser`,
  `live_capitulation_screener.py`): t=+3.61, 6/6 years positive, survives dropping the 3 most
  extreme days. Needs a cost/turnover-aware re-run — the same file's own gap-down/gap-up rows
  show a real edge can still be a turnover trap net of costs (delivery_pct had spread t=+7.82 and
  was still dead long-only after costs).
- **`win_probability`**: h=1 raw IC +0.0364, t=+2.58, provenance now traceable via
  `win_probability_scored_at` (migration `1787050000000`). Needs the write-timing verified in
  production (not assumed) and a real cost/turnover-aware portfolio run, per `measurement.md`'s
  own "next step, in order" list.

**Use `factor_backtest.py`** (or the harness `measurement.md`'s "already tested" table references)
against real Postgres. Follow the panel spec exactly: per-date then average, winsorize with
`interpolation="higher"/"lower"`, filter `is_suspect`, liquidity floor ≥₹1cr ADT, next-day OPEN
entry. **Update `measurement.md` itself** with the result, whichever way it comes out — a null
result is exactly as valuable to record as a positive one, per this repo's own retraction
discipline (several past sessions retracted a confident wrong number once the real query ran).

## 5. `knowable_at` — point-in-time correctness as a schema invariant

**Bucket: needs an owner decision. Do not implement without explicit sign-off.**

This is the single highest-leverage architectural change available (see the "how I'd have built
it" analysis in session history), but it is also the riskiest:

- Touches **200+ tables**, several of which are **compressed hypertables** — a predicate-wide
  `ADD CONSTRAINT`/`UPDATE` can fail or destroy compression on those.
- It would retroactively explain (and could have prevented) at least three separate incidents:
  `signal_generated_at` refreshed on every re-run (29,433 logically-impossible rows),
  `win_probability`'s write-cadence misdiagnosed twice in both directions, and
  `unified_recommendations` overwriting its own history until an append-only table was bolted on.

**Before writing a single migration**: get an explicit owner decision on scope (all 200+ tables,
or just the ones that have already caused an incident?), and do a live, per-column analysis of
which tables can safely take a `NOT NULL, never-updated knowable_at` column without breaking a
compressed hypertable's chunking. This needs the production Postgres instance — do not draft the
migration blind. If asked to proceed, propose starting with the 3 tables already burned by this
class of bug, not all 200+ at once.

## 6. A declarative `FetcherSpec` framework

**Bucket: large refactor. Propose a pilot before a repo-wide rewrite.**

`recurring-bugs.md`'s catalogue is dominated by the same ~8 mistakes recurring across ~140
fetchers (composite key missing the provider — 4×; skip-stamped-as-success — 6×; write
amplification — 2×; `.get(k, {})` against a nullable vendor field — 8 sites; ~115/140 fetchers
once had no freshness check at all). A shared runner that owns identifier resolution, incremental
writes, retry/backoff, transaction hygiene, heartbeat-with-skip-marker, and auto-registered
freshness + delivery checks would make most of that catalogue structurally unreachable rather
than documented.

**Do not rewrite 140 fetchers in one pass.** Per `CLAUDE.md`'s conventions (prefer reusing an
existing helper, don't refactor beyond what's requested):

1. Design the `FetcherSpec` shape and the shared runner as a **new, additive** module.
2. Pilot it on **one** already-broken or new fetcher (a good candidate: whichever showed up in
   `/job-runtime-audit`'s last run as write-amplified or non-resumable).
3. Verify that fetcher's own live_datasource test and freshness check still pass against real
   production data before touching a second one.
4. Only propose a wider rollout once the pilot has run clean in production for a real cycle —
   and even then, migrate fetchers individually, not in bulk, so a regression is attributable.

## 7. Consolidate six dashboard shells to one

**Bucket: product decision. Do not implement without explicit sign-off.**

v1/v2/v3/v4/v5/v6 coexist, all reading the same tRPC surface, with a real history of "fix applied
to the nav" being wrong about *which* shell (`/shell-parity-audit` exists because of this). This
is the biggest maintainability tax in the frontend — but which shell has real users, and whether
any shell-unique feature needs to be preserved, is **not** something this skill can determine from
the repo alone. Ask the user which shell(s) have real traffic before proposing a deletion plan.
If given the green light, use the `LegacyScoreBanner`-style deprecation-disclosure pattern
already established in this repo (`scoring-authority.md`) rather than an abrupt removal.

## How to work through this skill across sessions

1. Re-run step 1 (re-verify ground truth) at the start of every session that continues this work.
2. Pick exactly one numbered item. Do not parallelize items 5 and 7 with anything else — they
   need a human answer before any code gets written.
3. For every item, follow `CLAUDE.md`'s Definition of Done and the `/deploy-and-verify` skill:
   committed ≠ deployed ≠ applied ≠ live-verified are four different states, and a session must
   say explicitly which of the four it reached, not round up.
4. Update `docs/session-log.md` and this file's "Already done" table (§0) as items close, so the
   next session doesn't re-discover or re-litigate a finished item — the exact failure this skill
   exists to prevent one level up.
