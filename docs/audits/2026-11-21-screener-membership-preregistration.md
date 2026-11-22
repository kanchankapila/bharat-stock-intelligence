# Screener membership replay: pre-registration (AF-20261106-04)

Written and committed before any return was read. Changing a definition below after the first result
makes it a new version, not this one.

## Question

`screener_features_fetcher.load_today_appearances` keeps only episodes that appeared in the last 3 calendar
days, so long-running memberships never reach `screener_momentum_score` and its siblings, although the
function's docstring says "active". Does building the features from every open episode (with dead syncs
removed) change how well they rank next-session returns?

## Instrument (validated before this document, no returns used)

Both arms are rebuilt from `screener_appearances` episodes by `scripts/screener_membership_replay.py`.
Check against production on the 14 dates with a stored capture (2026-10-30..2026-11-20): the rebuilt old arm
equals the captured membership set exactly on 13 dates (Jaccard 1.0000) and 0.9937 on 2026-11-05; its
`screener_momentum_score` correlates 0.9997-1.0000 with the stored column (exact match 67-90 percent, 100
percent on the latest date; the difference is screener labels revised after the date). Tests pin the arms,
including that the old arm equals `load_today_appearances` on the same table
(`src/server/tests/test_screener_membership_replay.py`).

## Arms

- **old:** production's rule. Episode appeared in the last 3 days and `exited_date IS NULL OR exited_date >= D`.
- **new:** every episode open on D (`appeared_date <= D AND (exited_date IS NULL OR exited_date >= D)`).
  An episode still open today must have its `*_screener_stocks.last_seen` within **3 calendar days** of D;
  an exited episode is a member until its exit. A sync refreshes `last_seen` on every current member, so a
  stale value is a dead sync (measured 2026-11-21: all 88,527 open episodes have their row; stale open
  episodes: ETnow 32, ET Marketstats 300, MoneyControl 0, Trendlyne 0).
- The 20 screener ids shared by ETnow and MoneyControl (40 source-id pairs) are removed from **both** arms on
  every date: an exit by one provider could close the other's episode until AF-20261120-06's migration.
- Features come from production `load_screener_meta(con, as_of=D)` (point-in-time Bayesian weights) and
  production `compute_features`. A symbol with no membership under an arm scores 0 on every feature, as the
  consumers (`ml_ensemble.num(..., 0)`) treat the stored NULL.

## Sample

Every session D from 2026-09-01 through 2026-11-19 with a next session in `stock_ohlcv`. Return = next
session's open to close, in percent. Universe per date: 20-day average traded value >= Rs 1 crore as of D,
`is_suspect = 0`, valid open and close, |return| <= 40; a date is graded only with at least 50 names.

## Metrics

Per date, Spearman rank correlation of each feature with the return (IC), for each arm.

**Primary:** the paired difference `IC(new) - IC(old)` on `screener_momentum_score`, mean over dates and its t
statistic (dates are non-overlapping, one next-session return each), plus t for the first and second half of
the dates and the count of dates where new is better.

**Reported, not deciding:** the same paired difference for `screener_bull_count`, `screener_bear_count`,
`screener_tier1_count`, `screener_cat_breadth`, `screener_alpha_score`; each arm's own IC against zero; top-50
net excess (mean return of the 50 highest scores minus the date's universe mean minus 0.32 percentage points
cost, ties broken by symbol); coverage (share of the universe with at least one membership, memberships per
name). Sensitivity: grace of 1 and 7 days, and no liveness gate.

## Decision rule

The repo's ship rule (AF-20261026-71): the new definition is **not harmful** unless the primary paired
difference has t <= -2 in either half. Fewer than 20 graded dates is reported as LOW-DATA. A not-harmful result
does not add edge; it says the defect fix does not break the feature.

## What each outcome allows

- The capture fix (record the gated open episodes in `screener_membership_snapshot`) changes no score and is
  independent of this result; it ships.
- `screener_momentum_score` has the largest engine weight in most REGIME_WEIGHTS and `ml_ensemble` and
  `exit_policy` train on these columns, so even a not-harmful result does not let the live feature window change
  by itself: history would have to be rebuilt and the models retrained, which is the owner's decision
  (train/serve skew, `ml-model-bugs.md`).
- Nothing here relabels a screener or removes a veto (AF-20260829-11/12, AF-20261106-01 stand).

## Known limits

Screener sentiment labels, categories and names are the current ones (hindsight, small: the stored-value
correlation above is 0.9997+); the Bayesian weight is point-in-time. A closed episode that sat through a dead
sync before its exit cannot be detected historically, only open ones. One falling tape, about 55 sessions, one
sample: a check of the definition, not evidence of an edge.
