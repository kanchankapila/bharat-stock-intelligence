---
description: Sweep every date anchor, staleness calculation, cron mirror and row-vs-date window in the repo against the "Dates & scheduling" bug cluster — the single largest recurrence group in recurring-bugs.md (~35 recorded instances), only 2 of whose 6 signatures are statically enforced
---

# Temporal Correctness Audit

`.claude/rules/recurring-bugs.md`'s "Dates & scheduling" table carries more recorded recurrences
than any other section: 11 files with a `date.today()` write anchor, 10 with a `CASE WHEN date >= x
ELSE NULL` guard that nulls a column's whole history on a holiday, 4 raw `daysStale()` calls that
read Friday data as 3 days stale on Monday, 6 cron patterns mirrored into a second registry, 2
hand-rolled weekday steppers. `scripts/check_recurring_bugs.py` automates only the first two
signatures, and only on **changed** files in CI — nothing ever looks at a file nobody touched.
That is what this audit is for. Read the "Dates & scheduling" and "Monitoring blind spots"
sections of `recurring-bugs.md` first.

Run the static checker over the **whole tree** before anything else — it is faster than you and
catches the two automated signatures everywhere, not just in the diff:

```bash
backend-python/venv/Scripts/python.exe scripts/check_recurring_bugs.py
```

Everything below is what that script cannot see.

## 1. Write anchors (`date.today()` / `datetime.now()` as an exact-match target)

```bash
grep -rnE "date\.today\(\)|datetime\.now\(\)" src/server/*.py scripts/*.py | grep -vE "as_of\.|logical_"
```

~124 files match the bare call; most are legitimate logging/filenames. The finding is only where
the value **reaches a WHERE clause, an UPDATE target, or a CASE guard**. For each hit, read the
surrounding 10 lines and classify:

- `WHERE date = <today>` on a write → **finding.** Post-close jobs finish after midnight IST, so
  "today" resolves to a day with no grid row and the UPDATE matches 0 rows, silently. Fix:
  `as_of.logical_trading_date()`.
- `CASE WHEN date >= <today> ... ELSE NULL` → **finding, and the worst variant** — on any
  weekend/holiday the anchor matches nothing and the `ELSE` nulls the column's entire history.
  Fix: anchor to `MAX(date) FROM stock_ohlcv`.
- Read-only filter, log line, filename → not a finding. Say so and move on; don't pad the report.

## 2. Staleness arithmetic

```bash
grep -rn "daysStale(" src/server/*.ts | grep -v tradingDaysStale
```

Each hit on a table that only updates on NSE trading days is a false-positive generator every
Monday. Also check `TABLE_FRESHNESS_CHECKS` entries for `tradingDayAware: false` — that is correct
only for genuinely 24/7-cadence tables (`confluence_signals` and similar); anywhere else it is the
same bug expressed as config.

## 3. Windows that include today

Different shape from staleness, same root cause. A **coverage or completeness ratio** computed over
"the last N days" including today reads as a false collapse every weekday whenever the rows are
written by a morning job and enriched by an evening one.
`technical-signals-freshness-coverage` had exactly this after its staleness half was already
fixed. Grep `dataQualityChecks.ts` for any ratio/percentage check and confirm its denominator is
the most recently **completed** day (`date = MAX(date) WHERE date < today`), not a window ending
now.

## 4. Row-position windows on a long panel

```bash
grep -rnE "\.iloc\[-[0-9]+:\]|\.tail\([0-9]+\)|\.head\([0-9]+\)" src/server/*.py
```

~18 hits. For each, answer one question: **is the dataframe one row per date?** If it is a
`(symbol, date)` panel, `.iloc[-30:]` slices 30 *symbols of a single date*, not 30 days.
`drift_detector.py` did this against `feature_store` (~2,400 rows per date), which pinned a
permanent false `EMERGENCY_RETRAIN` and a real 0.85× `win_probability` haircut for weeks. The fix
is to slice on `df["date"].isin(sorted_distinct_dates[-N:])`. Check the source table's actual
shape (`information_schema` or `df['date'].value_counts()`), never the comment above the line.

## 5. Cron mirror drift

A `cronPattern` written in `queues.ts` and mirrored into `jobRegistry.ts` / `monitorScripts.ts`
drifts and produces phantom "late"/"stale" alerts forever. Five mirror-consistency test suites
guard this — confirm they still pass and still cover every registry:

```bash
npx vitest run --reporter=dot -t "mirror"
```

A guard test built on a hand-enumerated allowlist only guards what someone remembered to list.
Verify each suite derives its list by scanning the source, not from a literal array.

## 6. Hand-rolled weekday stepping

```bash
grep -rnE "weekday\(\)\s*[<>=]|timedelta\(days=1\).*while|business_day" src/server/*.py scripts/*.py
```

Anything stepping back N weekdays by hand skips no holidays — `--days 90` silently covers 87
sessions. Fix: `as_of.trading_days_back()`.

## 7. Report

One table: file:line, which of the six signatures, whether it is a real finding or a
read-only/logging false positive, and the named replacement helper. Then state explicitly which
signatures you checked **repo-wide** versus which you only spot-checked — this audit's value is
completeness, and a partial pass reported as complete is the exact failure mode
`recurring-bugs.md` warns about ("a code-review pass that finds N instances of a class should not
be trusted as complete").

If you find a *new* temporal signature not in the six above, the durable move is a check in
`scripts/check_recurring_bugs.py`, not another paragraph in the rules file — the recurrence counts
there were all recorded **after** the class was documented in prose.
