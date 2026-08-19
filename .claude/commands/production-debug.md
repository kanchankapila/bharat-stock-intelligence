---
description: Investigate a live production failure end-to-end — establish what the code actually does, reproduce against live data without orphaning a query, check this repo's known recurring root causes before inventing a new theory, and deliver a fix with a negative-controlled test and a plan for the rows the bug already wrote
---

# Production Debug

For a live failure: a job dying, a column going NULL, a dashboard showing nothing, a number that
looks wrong. **Do not skip to a fix.** This repo's most expensive debugging failures were all
plausible-sounding theories adopted before anything was traced — see `measurement.md`'s note that
the 2026-08-06 session's first-pass KECL lead ("market_cap is NULL, that's probably it") was
entirely wrong once traced properly.

## 1. Establish what the code actually does

Query the graph before reading files — it's free (local AST, 0 tokens):

```powershell
$PY = Get-Content "graphify-out/.graphify_python"
& $PY -m graphify query "<question>"     # or: path "A" "B" | explain "Symbol"
```

Check `graphify-out/GRAPH_REPORT.md`'s freshness hash against `git rev-parse HEAD` first — it
drifted 330 files behind in five days once. Then read the specific functions, not whole files.

**A docstring is a claim with a date on it.** So is a rule-file entry. `recurring-bugs.md`'s
`incremental_update()` entry sat stale for 3 days and cost a later session real time when its
prose was repeated instead of the live file being read.

## 2. Reproduce against live data — safely

⚠ **A client-side `timeout` does NOT cancel a server-side query — it ORPHANS it.** A
`timeout 20 node -e "...NOT IN (SELECT ...)..."` returned to the shell looking harmless while the
backend executed for **2h15m**, holding a relation lock that 30 platform queries queued behind
(some waiting ~56 min). That contention was then misdiagnosed as TimescaleDB decompression cost
and used to abandon a measurement as "not feasible." After `pg_cancel_backend`, the identical
`count(*)` returned in **0.7s**.

- Always `SET LOCAL statement_timeout = '30s';` on an investigative query.
- Prefer `EXPLAIN` or a bounded `LIMIT` over an unbounded anti-join on a multi-million-row table.
- **Any query that hangs on ONE table while others respond normally is lock contention until
  proven otherwise** — never a storage-engine theory. Diagnose first:

```sql
SELECT pid, wait_event_type, wait_event, now()-query_start,
       pg_blocking_pids(pid), query
FROM pg_stat_activity WHERE state <> 'idle';
```

`wait_event_type = 'Lock'` across many rows plus one long root with
`cardinality(pg_blocking_pids(pid)) = 0` is the whole answer in one query.

## 3. Check the known recurring causes before inventing a new one

Each of these has bitten this repo **more than once**. Full signatures in
`.claude/rules/recurring-bugs.md`.

| Symptom | Check this first |
|---|---|
| Error names a table/column that demonstrably EXISTS | An **earlier swallowed statement** on the same connection. Postgres aborts the whole transaction; `except Exception: pass` does not contain it. `unified_ranker.py` has 33 such handlers — one missing table made it classify the **entire universe as Hold**, print 10 "unavailable" lines, and **exit 0**. Only the FIRST line names a real cause. |
| One query fails, but many unrelated columns are NULL | A multi-column `SELECT` **aborts entirely** on one bad column. `_log_recommendations` nulled `entry_price`/`target_1-3`/`stop_loss`/`quant_score` for 100% of rows because of one bogus `ORDER BY qs.date`. |
| A column is NULL platform-wide, but its table looks fresh | Is the writer's step **after a kill point**? `extra_endpoints_fetcher` took 21,461 fresh rows a night while all 14 `ext_*` columns stayed ~0% populated. **A fresh table is not a delivered feature.** |
| Job reports success but wrote nothing | Skip path falling through to the same `completed` handler as a real run. **6 recurrences**, including the shared `jobs/registerJob.ts` handler that hid failures on `confluence-compute` (marked `critical`). |
| A monitor never fires, or ALWAYS fires | Both carry zero information. `SELECT status, count(*) FROM <results> GROUP BY 1` — one row is the signature. `drift_detector` fired `EMERGENCY_RETRAIN` **16/16 across 14 months** while haircutting every calibrated probability. A `jobHeartbeat` lateness branch could **never** fire for any input — a heartbeat seeded 7 months stale still read `late=false`. |
| A freshness check has NEVER passed | More likely watching an **abandoned table** than reporting a real outage. `grep -rn "<table>" src/ --include=*.py --include=*.ts` — if the only hits are the writer and the check, the table is orphaned and the check is the bug. |
| Two things that must be distinguishable aren't | Case collision (`technical` vs `TECHNICAL`); a provider id without the provider in the PK (**4 recurrences**); a wall-clock timestamp used as a uniqueness key at 15.6 ms resolution. |
| NaN / null weirdness | `float(x or 0)` — **NaN is truthy**. `x != x` matches nothing in Postgres (`NaN = NaN` is TRUE). `ORDER BY col DESC` sorts NaN **HIGHEST**. `dict.get(k, {})` returns the default only when the key is MISSING, not when it's present-and-null. |
| A number is right but unusable downstream | A value formatted for a display consumer (`"₹1239.39"`) stored in a column another reader casts to numeric. |
| `.iloc[-N:]` / `.tail(N)` "last N days" | On a `(symbol, date)` panel that's the last N **ROWS** — one date's symbols, not N dates. |

## 4. Separate three questions

A failing external call is **my code broke** / **their code broke** / **their server is down**.
Say which. The 2026-08-17 live-suite run had 3 failures and only 1 was an upstream blip.

## 5. Deliver

1. **Code functionality breakdown** — what the path actually does, per stage.
2. **Root cause** — the specific line/query/config, with the live evidence proving it. Name the
   query and show the counts. A plausible story is not a root cause.
3. **Failure explanation** — why THIS symptom, and why nothing caught it.
4. **Edge cases** — grep the signature repo-wide. A manual pass is not complete: reviewing the
   skip-path class by eye found 3 instances; the static check then found 5.
5. **The fix**, plus all four of:
   - a **negative-controlled** test (revert fix → confirm test fails → restore). A suite that
     never failed against the bug protects nothing; three suites here were green while
     protecting nothing.
   - whether this belongs in `scripts/check_recurring_bugs.py` rather than prose. If you add a
     check, **state in its own comment what file layout would make the class invisible to it** —
     otherwise "the checker is clean" gets read as "the class is extinct."
   - **what rows the bug already wrote that the fix does NOT repair.** Fixing the source never
     cleans history — 13,505 poisoned rows survived a source fix for weeks.
   - whether `verify-gate.mjs` requires backtest evidence (any diff to `unified_ranker.py`,
     `scoring_engine.py`, `factor_backtest.py`, `multi_factor_scorer.py`,
     `institutional_quant_engine.py`, `quantScoringService.ts`). If the diff touches no score,
     weight, threshold or classification, say so explicitly and give the applicable measurement
     instead — running `factor_backtest.py` on an unrelated diff produces an evidence-shaped
     artifact, which is worse than no evidence.
6. **Verification** — the exact commands run and their output. If you could not run one, say
   which and why. A silent omission reads as a pass.
