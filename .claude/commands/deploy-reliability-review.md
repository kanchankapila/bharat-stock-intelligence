---
description: Close the deploy/reliability gaps on this single-box pm2 stack — manual restarts that get skipped, migrations written but not applied, duplicate catch-up runs, lateness branches that can never fire, and monitoring that watches table freshness instead of feature delivery. Not a Kubernetes migration.
---

# Deploy & Reliability Review

## Verified current state — do not propose against an imagined baseline

- **Deployment is pm2 on a single host** (`ecosystem.config.cjs`): 4 long-lived services plus
  greenfield one-shot cron jobs (`gfCron`: `autorestart:false`, `cron_restart`, `tsx`). pm2
  replaced `concurrently` after `alphaquant-api` (:8002) silently died and stock scores went
  stale **for weeks**.
- Restart policy: `autorestart:true`, `max_restarts:10`, `restart_delay:3000`, `min_uptime:10s`,
  `kill_timeout:10s`. Logs merged into `logs/pm2-{out,err}.log`.
- **There is no `Dockerfile` and no Kubernetes.** `docker-compose.yml` runs Redis 7 (AOF,
  `requirepass`, 512mb `noeviction`) and `timescaledb:2.17.2-pg16` only — infra deps, not the app.
- CI is one workflow (`.github/workflows/ci.yml`), 3 jobs (`build-test`, `python-tests`,
  `smoke-test`), both test jobs with a `timescaledb` service, using `PGTEST_*` and never
  `POSTGRES_*` — deliberately, so a stray production URL can't redirect a schema-creating run.
- Monitoring: `src/server/dataQualityChecks.ts` (~150 checks, daily cron + Telegram),
  `job_heartbeat`, `jobs/jobHeartbeat.ts` lateness, 4 Grafana dashboards.

**Do not propose Kubernetes, a service mesh, or multi-region** unless you first establish this
workload needs it. It is a single-box analytics platform serving one market's trading day.
Proposing K8s here is the failure mode, not the solution.

## Address these documented gaps first

### A. Deploy is manual and silently skipped

`.ts` is not hot-reloaded; `pm2 restart bharat-server` is a step humans forget. **"server N
commits behind HEAD" is a recurring audit finding (AF-14).** The documented manual check is
comparing `pm_uptime` against the fix commit's timestamp — **automate exactly that**. Design the
smallest reliable thing: a deploy script or post-merge hook that restarts what changed and then
verifies it actually restarted, rather than assuming.

### B. Written ≠ applied ≠ installed

Three separate gates, each of which has broken a live job:

- A migration verified against a throwaway local cluster is **not** applied to production —
  confirm `npm run migrate:up` ran against the real `POSTGRES_URL`.
- **Declared ≠ installed**: `node-pg-migrate` was in `package.json` but never `npm install`ed;
  `nse` was in `requirements.txt` but not in the venv. Both silently broke a live job for days.
- `PYTHON_PATH=backend-python/venv` is what production uses. Bare `python` on PATH is a different
  install with a different sklearn.

Gate deploy on all three. See `/migration-safety-review` for the migration half.

### C. Job reliability — three specific shapes

- **Duplicate catch-up runs.** `addJobWithCatchup`'s guard matched on `data.isCatchup` alone, so a
  restart landing during a legitimate in-flight run saw nothing catch-up-shaped pending and queued
  a second full run behind it. `ml-daily-ops`: **49% job-level fail rate (44/89)**, 129 catch-up
  events since 2026-07-25.
- **Lateness branches that can never fire.** All three `everyMs` entries in `jobHeartbeat.ts` were
  in a state where the grace period exceeded the interval it was measured against, putting the
  deadline permanently in the future. Proven, not reasoned: a heartbeat seeded **7 months stale**
  still reported `late=false` for `news-sentiment`, which is marked `critical`. **Tell:** any
  deadline arithmetic where grace can exceed the interval.
- **Skip paths stamped as success** — 6 recurrences, including the shared `registerJob.ts`
  handler, where `confluence-compute` (critical, no-ops ~9h/day) had genuine failures overwritten
  within 30 minutes by the next out-of-window skip.

Audit for these three shapes and propose **durable guards in the shared helper**, not per-job
one-offs — the shared-helper fix is what protects every job routed through it.

### D. Monitoring blind spot — the specific one this platform has

**A fresh table is not a delivered feature.** ~90 checks answered only "is this table getting
rows," while **21 of `ml_ensemble.py`'s 254 declared inputs were 100% NULL on every one of the
last 10 trading dates** (a hardcoded default fed to every stock) and 106 more were under 50% —
with the monitor reading 86 pass / 1 fail throughout.

Extend coverage toward **feature delivery**, and do it **generically** (via `jsonb_each` over the
row) — an enumerated column list only ever guards what someone remembered to add. Also verify:

- No check is uninformative: `SELECT status, count(*) FROM <results> GROUP BY 1` returning one
  row means it carries no information, in either direction.
- No check is watching an **abandoned table** (`insider-transactions-recency` warned on all 114
  runs it ever made, against a table no consumer reads).
- `pythonRunner`'s warning hook only inspects **stderr**. `unified_ranker.py` had ~30 real
  degraded-read messages printed to **stdout**, so they existed and were still invisible.

### E. CI gaps

- **The workflow's own top comment is stale** — it claims "vitest uses an in-memory SQLite DB …
  never `USE_POSTGRES`" while the job body directly below runs a Postgres service. Fix it. This is
  the "deleting a thing does not delete the docs pointing at it" class.
- Does CI run `scripts/check_recurring_bugs.py`, `npm run schema:drift`, and `verify-gate.mjs`?
- **Does any lane green-by-skipping?** The `python-tests` job's own comment warns that a
  service-less runner turns ~37 files **green by skipping** — confirm `pytest_sessionfinish`'s
  non-zero-exit guard actually prevents this, and that `vitest.globalSetup.ts` still throws.
- `live_datasource`-gated tests **never run in CI by design** and therefore rot silently. A
  by-hand run on 2026-08-17 found 3 failures and only 1 was an upstream blip. Propose a cadence.

### F. Backup, recovery, secrets

Establish what exists **today** for the `bharat_pgdata` volume, Redis AOF, and trained model
artifacts, and what the real RPO/RTO is. Confirm production is not running on the compose file's
dev-fallback credentials (`bharat`/`bharat`, `bharatredis`).

## Deliver

1. **Current-state architecture diagram** (mermaid) — what IS, accurately.
2. **Gap table**: gap | evidence (`file:line` or a live query) | blast radius | severity.
3. **Concrete improvements ranked by (risk reduced ÷ effort)**, each implementable on THIS
   single-box pm2 stack.
4. An **improved deployment workflow** closing A and B, **including its verification step**.
5. A **containerization recommendation with honest tradeoff analysis — including not doing it.**
   If you recommend it, say specifically what it buys here.
6. **Monitoring strategy focused on feature-delivery coverage**, not more table-freshness rows.
7. A **production deployment checklist** derived from this repo's actual recurring failures:
   committed ≠ deployed · declared ≠ installed · written ≠ applied · skip ≠ success ·
   fresh table ≠ delivered feature.

Every recommendation must cite what in THIS repo motivates it. A generic best practice with no
local evidence is noise.
