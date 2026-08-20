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
| `scripts/backup_pg.py` existed but was scheduled nowhere, so it had never run once | Verifies the dump's TOC at write time, stamps `job_heartbeat('pg-backup')`, scheduled nightly in `ecosystem.config.cjs`. **Live-verified 2026-08-20**: real `--restore` drill (DROP+CREATE DATABASE, not `pg_restore --clean` — TimescaleDB preloads the extension via `template1` and `--clean`'s DROP+CREATE EXTENSION inside one session always fails against it), 215/215 tables + 24/24 hypertables restored, exact row-count match | `pg-backup-recency` check in `dataQualityChecks.ts`, fix in `4cb780b` |
| "server N commits behind HEAD" (AF-14) was always caught by a human, never a check | `scripts/check_deploy_drift.mjs` compares git HEAD's committer time against `bharat-server`'s pm2 boot time, every 15 min. **Live-verified 2026-08-20** on the real prod host — `job_heartbeat('deploy-drift')` green | `deploy-drift` check in `dataQualityChecks.ts` |
| pm2 reports a service "online" while a process with no ancestry link to it has squatted the real port first (found live 2026-08-20 during a Docker Desktop crash — took `ml-api`/`alphaquant-api` fully offline for over an hour, undetected) | `scripts/check_port_drift.mjs` walks the parent-process chain from what's actually LISTENING back to pm2's tracked PID — ancestry, not interpreter path, since this venv's own launcher and pm2's fork-mode wrapper both legitimately spawn the real worker as a child. Every 15 min. **Live-verified**: caught the real incident, corrected version passes clean post-recovery | `port-drift` check in `dataQualityChecks.ts`, commit `5e0bff0` |

Documented in `docs/session-log.md`'s 2026-08-19/20 entries. **All three of the above are now
genuinely live-verified on the production host**, not just syntax-checked — §3 below (which used
to ask for this) is done.

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

## 2. Containerize the 4 app services — images built and verified 2026-08-20; one step left

**Written and building successfully as of 2026-08-20**: `docker/*.Dockerfile` (one per service +
a shared `bharat-python-base`), `docker-compose.override.yml`, `.dockerignore` — all committed
(`71f76d9`). Additive as required: `docker-compose.yml`'s original Redis+TimescaleDB services are
untouched, pm2/`npm start` still works exactly as before.

**Verified with real builds, not a syntax read**: all 5 images (`bharat-python-base`, `bharat-ml-api`,
`bharat-chatbot`, `bharat-alphaquant-api`, `bharat-server-docker`) build successfully via
`docker build`. `bharat-server`'s build (`npm ci` + a full Vite build inside the container) twice
wedged Docker Desktop's WSL2 engine — root-caused (not to memory, an initial wrong diagnosis — see
`infra_gotchas` memory's correction) to the C: drive running out of space, since Docker's own data
disk lives there by default. Fixed by relocating Docker's data disk to D: via a directory junction;
the same build then completed cleanly in ~9 minutes.

**Not yet done — the one remaining step**: `docker compose up` running all 4 containers
*simultaneously* against the real Postgres/Redis containers, confirming actual end-to-end traffic
(not just that each image builds). Deferred because host memory was tight immediately after the
build; individual `docker build` success is confirmed, full-stack integration is not. To finish:
stop the pm2 app services (frees both the ports — the compose services bind the same 3000/8000/
8001/8002 — and memory), `docker compose up -d`, health-check all 4 endpoints, confirm each reaches
Postgres/Redis by container name (not `127.0.0.1`/`localhost` — see the compose file's own comment
about `REDIS_HOST`/`POSTGRES_URL` needing container-network values), then stop the compose stack
and restart pm2 to return to the live path.

## 3. ~~Deploy-drift and backup checks need a real production run~~ — DONE, see §0

## 4. Cost-aware validation of the two live measurement leads — DONE 2026-08-20, both resolved

`measurement.md` identified two promising, unresolved leads. Both re-measured live against
production this session, results written into `measurement.md` itself (not summarized here —
read the two new dated sections there for the full numbers and caveats):

- **The capitulation triple** — re-run via `screener_combo_finder.py --tier1`: 430 days / 658
  signal-rows (up from 425/651), spread +0.5064%/day net of 0.15% round-trip cost, t=+3.48,
  p=0.0005. Reconfirms the 2026-08-13 read (t=3.61) with 5 more days of data — same combo still
  wins, magnitude essentially unchanged. This construct's cost accounting was already adequate at
  first measurement (single next-session open→close round-trip, not a rebalanced hold, so the
  `gap_down`/`gap_up` turnover-drag concern doesn't transfer) — re-running under the same harness
  with more data was the right bar, and it cleared it. **Still open**: a per-year breakdown to
  reconfirm "6/6 years positive" (this run doesn't emit that split).
- **`win_probability`** — re-run via `factor_edge.py` (the same harness already scheduled for
  `unified_ranker.py`'s own engine scores), properly powered this time: 53/49/33 dates per
  horizon (not the 1-date `LOW-DATA` reads seen elsewhere). Rank_IC is real and *grows* with
  horizon (+0.044 → +0.077 → +0.103, 1d→5d→21d) and replicates the 2026-08-15 preliminary read's
  magnitude — but `hit_AUC` never clears this repo's own 0.55 `USABLE` bar (tops out at 0.537 on
  21d), so the verdict is "real signal, not tradeable as scored" rather than a flat no-edge.
  **Still open**: the actual cost/turnover-aware portfolio backtest — this AUC result argues it
  likely isn't worth running (a signal this weak on classification power is unlikely to survive
  25bps costs even with real IC), but that's an inference from this session, not a measurement.

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
