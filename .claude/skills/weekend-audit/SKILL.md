---
name: weekend-audit
description: Weekly whole-system health sweep across repo/build, the four services, jobs, Postgres, the ML layer and the six frontend shells — runs the checks that already exist, adds only the ones nothing covers, rotates through the 15 deep audit commands, then hands every finding to the audit-loop skill to be fixed, verified and immunized. Use on a weekend, when asked to audit the whole system / check everything is running right, or when scheduling a recurring health check.
---

# Weekend audit

Nothing here is a new monitoring engine. The 15-minute `jobWatchdog`, the 62 checks in
`dataQualityChecks.ts`, and the 12 `.claude/commands/*-audit|*-review` files already cover most
of this. This skill exists for the gaps those cannot see:

- **They answer "is it fresh", never "is it correct".** `recurring-bugs.md`'s dominant class is
  a pipeline reporting health while producing nothing — skip stamped as success, a job SIGKILLed
  before its last step, a fresh table whose feature column is 100% NULL, a monitor that has fired
  on 16/16 runs.
- **`data_quality_results` is PK'd on `check_id`** — one row per check, overwritten every run.
  There is **no history**, so a check that has always passed and one that started passing an hour
  ago look identical. Week-over-week comparison has to come from this skill's own ledger.
- **The frontend has zero monitoring and zero component tests.** Six shells, `v6` is what a fresh
  visitor lands on.
- **The 12 deep audits are run only when someone remembers.** Rotation below fixes that.

Read `.claude/rules/recurring-bugs.md` before starting. Run lanes in order; a red lane does not
stop the others. **Do not fix as you go.** Collect findings through Lane 6, then run the whole set
through the `audit-loop` skill in Lane 8 — that skill owns triage, fixing, live verification and
immunization. An audit that turns into an ad-hoc refactor mid-sweep stops being comparable to last
week's, and skips the triage gate that keeps unmeasured scoring changes from landing.

---

## Lane 0 — What changed, and is it actually deployed

Start by reconciling the open rows in `docs/audit-findings.md` from previous runs. **Re-check
those before hunting new ones** — closing a known issue beats discovering a new one, and an open
row that survives three runs is itself a finding.

```bash
git log --oneline --since="7 days ago" | cat
git status --short
pm2 jlist | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const p of JSON.parse(s))console.log(p.name,p.pm2_env.status,'restarts='+p.pm2_env.restart_time,'up_since='+new Date(p.pm2_env.pm_uptime).toISOString())})"
```

`pm_uptime` **older than the newest commit touching `.ts` / `.py` for that service is a finding**,
not a curiosity — committed ≠ deployed, and `.ts` is not hot-reloaded. `restart_time` climbing
between weekends means a crash loop nothing alerted on.

## Lane 1 — Repo & build

```bash
npx tsc --noEmit
npx vitest run
backend-python/venv/Scripts/python.exe -m pytest src/server/__tests__/ src/server/tests/ -q
backend-python/venv/Scripts/python.exe scripts/check_recurring_bugs.py
npm run schema:drift
npm run build
```

`check_recurring_bugs.py` normally runs on changed files in CI — run it over the whole tree here;
that is the only pass that sees a class hiding in a file nobody touched this week. Use
`backend-python/venv`, never bare `python` (different sklearn).

## Lane 2 — Services

The four processes (`bharat-server`:3000, `ml-api`:8000, `chatbot`:8001, `alphaquant-api`:8002).
`pm2 jlist` says "online"; that is not the same as answering.

```bash
for p in 3000 8000 8001 8002; do echo -n "$p "; curl -s -o /dev/null -w "%{http_code}\n" --max-time 5 http://127.0.0.1:$p/ || echo DOWN; done
npm run smoke:ci   # boots the real tRPC router against Postgres — catches router-vs-schema drift
```

## Lane 3 — Jobs & data quality

```bash
npm run dq:check
```

Then the two things `dq:check` structurally cannot report (see Lane 4 for how to run SQL here —
`psql` is not on PATH):

```sql
-- (a) Jobs that never succeed, and jobs that have never failed (a check that cannot fail is not a check)
SELECT job_name, last_status, run_count, fail_count,
       round(100.0*fail_count/NULLIF(run_count,0),1) AS fail_pct,
       to_timestamp(last_success_at/1000) AS last_success, left(coalesce(last_error,''),120) AS err
FROM job_heartbeat
WHERE run_count > 5 AND (fail_count = run_count OR fail_count = 0)
ORDER BY fail_pct DESC NULLS LAST;

-- (b) Everything currently not-pass, with how stale the verdict itself is
SELECT status, critical, check_id, left(detail,140) AS detail,
       to_timestamp(checked_at/1000) AS checked_at
FROM data_quality_results
WHERE status <> 'pass' ORDER BY critical DESC, status;
```

A `checked_at` more than a day old on any row means the watchdog itself stopped running — that
finding outranks every individual check below it.

Then grep the logs for the silent-truncation class (`recurring-bugs.md`: a step at the end of a
script that gets killed at its budget has *never executed*):

```bash
pm2 logs --nostream --lines 3000 2>/dev/null | grep -iE "killed by timeout|Timed out after|SIGKILL|heap out of memory" | sort | uniq -c | sort -rn | head
```

## Lane 4 — Database

**`psql` is not on PATH on this machine.** Run SQL through the production venv with psycopg2 and
`POSTGRES_URL` from `.env` — and set a statement timeout first, or a slow catalogue query will
hang the whole audit (verified 2026-08-15: two of the queries below did exactly that):

```python
# backend-python/venv/Scripts/python.exe
import os, psycopg2
from dotenv import load_dotenv; load_dotenv(r"d:\Github\bharat-stock-intelligence\.env")
cur = psycopg2.connect(os.environ["POSTGRES_URL"]).cursor()
cur.execute("SET statement_timeout = '25s'")
```

A `tsx` script is the other option, but **only with `import 'dotenv/config'`** — without it
`USE_POSTGRES` is unset, `dbAsync` silently falls back to dev SQLite, and it will print
convincing numbers from the wrong database.

Run in this order — cheap and actionable first:

```sql
-- 1. Connections and anything wedged. Fast, and the most actionable row in this lane.
SELECT state, count(*) FROM pg_stat_activity GROUP BY 1;
SELECT pid, state, now()-xact_start AS xact_age, left(query,100)
FROM pg_stat_activity WHERE state <> 'idle' AND now()-xact_start > interval '5 min';

-- 2. Bloat / autovacuum keeping up (migration 1787030000000 tuned thresholds for large tables)
SELECT relname, n_live_tup, n_dead_tup,
       round(100.0*n_dead_tup/NULLIF(n_live_tup+n_dead_tup,0),1) AS dead_pct,
       last_autovacuum, last_autoanalyze
FROM pg_stat_user_tables
WHERE n_dead_tup > 100000 ORDER BY dead_pct DESC LIMIT 20;

-- 3. Hypertable compression still applying (a predicate-wide UPDATE can silently destroy it)
SELECT hypertable_name, count(*) FILTER (WHERE is_compressed) AS compressed, count(*) AS chunks
FROM timescaledb_information.chunks GROUP BY 1 ORDER BY 3 DESC;

-- 4. EXPENSIVE — run last, expect timeouts under load. Size growth vs last weekend's ledger:
SELECT c.relname, pg_size_pretty(pg_total_relation_size(c.oid)) AS total
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 20;

-- 5. EXPENSIVE — indexes nobody reads (write cost, no read benefit)
SELECT relname, indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid)) AS sz
FROM pg_stat_user_indexes WHERE idx_scan = 0 AND pg_relation_size(indexrelid) > 50*1024*1024
ORDER BY pg_relation_size(indexrelid) DESC;
```

Reading the results:

- **A multi-hour `active` query is the finding**, not the backdrop. Queries running 70+ minutes
  hold snapshots that block autovacuum on every table they touched, which then shows up as bloat
  in query 2 — treat query 1 as the cause and query 2 as the symptom, in that order.
- **If queries 4 and 5 time out, that is itself a datapoint** about contention, not a reason to
  skip the lane. Record it and move on; retry them when the tape is quiet.
- Compare sizes against last weekend's ledger entry, never against a gut feel.

## Lane 5 — Frontend

No component tests exist, so the check is that it actually renders. Use the
`run-bharat-stock-intelligence` skill to boot and drive it; screenshot **v6 first** (the default a
fresh visitor gets), then spot-check one other shell.

- Browser console clean of errors on load?
- Does the home surface show real numbers, or the "looks healthy, is actually broken" shape —
  zeros, `--`, yesterday's date rendered as if live? (`data-honesty-review` covers this properly
  when it comes up in rotation.)

## Lane 6 — Deep audit rotation

Three per weekend, so all 15 land every 5 weeks. Pick the group by ISO week (`date +%V`) mod 5:

| week % 5 | Group | Commands |
|---|---|---|
| 0 | Data layer | `/data-coverage-audit` · `/fetcher-accuracy-review` · `/cross-writer-collision-audit` |
| 1 | Backend | `/job-runtime-audit` · `/trpc-surface-review` · `/migration-safety-review` |
| 2 | ML & measurement | `/signal-accuracy-review` · `/measurement-integrity-review` · `/ml-promotion-gate-review` |
| 3 | Frontend & canonical | `/canonical-read-audit` · `/shell-parity-audit` · `/data-honesty-review` |
| 4 | Silent-green | `/temporal-correctness-audit` · `/test-integrity-audit` · `/threshold-calibration-audit` |

Group 4 covers the three clusters with the highest recorded recurrence counts and, until now, no
command coverage at all: date anchors and trading-day arithmetic (~35 instances), suites that are
green while protecting nothing, and monitors whose verdict never varies.

Record which group ran, so a skipped weekend is visible as a gap rather than silently rotating on.
If a lane above went red in a way one of the other 12 commands is built for, run that one too
regardless of rotation — the schedule is the floor, not the ceiling.

## Lane 7 — Report and ledger

Append one section to `docs/weekend-audit-log.md` (create it if absent). Keep the shape identical
every week or the trend is unreadable:

```markdown
## 2026-08-15 (week 33, rotation group 1 — backend)

| Lane | Verdict | Notes |
|---|---|---|
| 0 deploy | ✅ / ⚠️ / ❌ | services vs HEAD, restart counts |
| 1 repo | | tsc / vitest / pytest / recurring-bugs / schema-drift / build |
| 2 services | | 4 ports, smoke:ci |
| 3 jobs+DQ | | n critical fail, n warn, n jobs 100%-failing |
| 4 database | | largest table + delta vs last week, dead_pct worst, idle-in-txn |
| 5 frontend | | v6 renders, console errors |
| 6 rotation | | group N — findings |

**New this week:** …
**Unchanged from last week:** … (a finding repeating 3 weeks running is its own finding)
**Fixed and live-verified:** …
```

State plainly what is red, what got worse *since last weekend* (the part no other tool in this
repo can tell you), and what you deliberately did not fix. Only claim a lane passed if its command
actually ran — a skipped lane is reported as skipped, never as green.

## Lane 8 — Remediate

Hand every finding from Lanes 0-7 to the **`audit-loop`** skill. It owns the rest: triage into
FIX / EVIDENCE / INVESTIGATE / ACCEPT, fix the safe ones root-cause-first, negative-control each
test, verify against live production via `deploy-and-verify`, immunize with a static check in
`scripts/check_recurring_bugs.py` where possible, and carry every unclosed finding forward in
`docs/audit-findings.md` with a stable ID.

Do not shortcut it here. The triage gate is what keeps an unmeasured scoring change from riding
in on a green test suite — the single most repeated failure in this repo's history.

---

## Scheduling it

Two options, both external to this skill:

- `/schedule` — a cloud cron agent running `/weekend-audit`, e.g. Saturdays 09:00 IST.
- `/loop` — for a one-off supervised run in the current session.

Do not add a BullMQ job for this. It needs a model in the loop to read the results and drive
Lane 8; a cron that writes an unread report is exactly the failure mode this skill exists to
detect.
