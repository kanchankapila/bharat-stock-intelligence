# Strategy research: data feasibility and first study

Research snapshot, 2026-11-08. This is not a trading recommendation or a complete inventory of
every source. Existing work and forward evidence are tracked in AF-20261026-73,
AF-20261008-27, AF-20261028-15, AF-20261103-08 and AF-20261016-03 in
`docs/audit-findings.md`. Do not change the frozen paper-book protocol to fit this study.

## Production coverage snapshot

Read-only `scripts/sql.py` queries on 2026-11-08 counted distinct dates and symbols in each
named table, with date filters stated below. These are union counts, not per-date coverage,
clean-history counts, point-in-time proof, or guarantees of tradeability.

| Dataset and filter | First through last observed | Distinct dates | Distinct symbols |
|---|---|---:|---:|
| `stock_ohlcv`, from 2024-01-01 | 2024-01-01 to 2026-11-06 | 714 | 2,467 |
| `feature_store`, from 2024-01-01 | 2024-01-01 to 2026-11-06 | 710 | 2,431 |
| `intraday_ohlcv`, from 2026-01-01 | 2026-01-01 to 2026-11-06 (UTC timestamps) | 216 | 2,435 |
| `nse_filing_financials`, broadcasts from 2024-01-01 | 2025-10-08 to 2026-11-06 (UTC) | 243 | 2,260 |

On 2026-11-06, daily `feature_store` contained 2,362 rows; non-null counts were 2,362 for
`ret_21d`, 2,351 for `volume_ratio_20d`, 2,147 for `delivery_pct`, 2,153 for `roe`,
1,862 for `pcr_oi`, and 2,073 for `news_sentiment_score`. Non-null does not mean correct,
fresh, historically available or non-default. Filings in other tables may have longer history;
the financials table's first broadcast does not establish the first result filing in the system.

For `unified_recommendations_history` generated from 2026-08-01, the same read-only check
found 63 distinct IST capture dates and 2,426 distinct symbols, from 2026-08-10 18:23:51 UTC
to 2026-11-06 17:00:01 UTC. This is not 63 independent observations at a multi-session horizon.
Use `generated_at`, not the intended session label, to establish when a ranking was available.

## Research candidates and decision clocks

* Next session: previous close features, prior liquidity, pre-open auction data captured before
  the entry decision, and then separately completed intraday bars and volume. Test gap/imbalance
  and VWAP/volume interactions separately. Pre-open gap is already known at that clock. Evaluate
  long and short separately, with only post-signal entry and realistic same-day exit constraints.
* Five and 21 sessions: 12-minus-1 momentum alone as a simple baseline; compare a fixed,
  predeclared price-plus-delivery candidate with its price-only and delivery-only components.
  Prior studies, including the 2026-10-09 cost-aware price/delivery study in `measurement.md`,
  did not establish an out-of-sample net edge. Do not present the combination as new or proven.
* Longer term: point-in-time valuation, profitability, leverage and growth with momentum and
  sector exposure; check announcement and vendor observation timestamps and restatement history
  before any test. `factor_backtest.py` explicitly calls several valuation inputs provisional.

Decision timestamps, historical membership, adjustments, observation and publication times,
and missingness must be verified per source. Exclude or separately label histories whose
point-in-time lineage cannot be established. Today's suspect flags have no historical observation
timestamp (AF-20261028-15); historical replay is exploratory, not prospective proof.

## Evaluation contract

Freeze the hypotheses, sample dates, universe, feature definitions, experiment variants and
promotion criteria before examining the evaluation block. Use a common, date-specific liquid
universe; next available open after the data cutoff; turnover-based delivery costs with sensitivity
to spread and slippage; and an equal-weight eligible-universe benchmark plus a buyable index.
Evaluate the candidate and simple baselines on identical dates and eligible securities. Report
missing entries/exits, delistings, bad-bar clamps, point-in-time membership and corporate actions.
Dividends, impact and actual fill rates require separate treatment if unavailable in the harness.

For 5/21-session outcomes use chronological walk-forward training, purge overlapping labels,
and measure uncertainty by session blocks or disjoint holding periods. Reserve an untouched
final period; account for earlier searches and failed variants, not just the selected candidate.
Report rank correlation, top-N precision/recall for predeclared movers, net excess, turnover,
drawdown, coverage and regime/liquidity breakdowns. A daily high is diagnostic, not a fill.
Intraday target/stop ties in the same bar are ambiguous; use the existing resolver's conservative
stop-first rule and separately test more realistic fills. Score missing and neutral outcomes
explicitly, and never mix label definitions. Calibration claims require Brier or log loss versus
a contemporaneous base rate on matured outcomes.

For learning, retain frozen predictions and source versions, resolve every eligible matured
outcome, and train candidate models using only matured labels. Record missed movers as well as
selected names. Run candidate decisions in shadow against the incumbent, with the same universe,
clock and cost assumptions. Promote only after independent, prospective cost-aware evidence;
otherwise abstain. Existing intraday learning already writes candidate weights without promoting
them automatically. This research does not create a second final ranking or signal table.

## Exploratory baseline

The following existing-harness command starts a historical sensitivity run, not a pre-registered
test and not a promotion decision. The start date also sets the beginning of factor warm-up,
so 12-minus-1 momentum cannot be formed until sufficient prior bars have accumulated.

```powershell
$env:OPENBLAS_NUM_THREADS='2'
$env:OMP_NUM_THREADS='2'
backend-python/venv/Scripts/python.exe src/server/factor_backtest.py --factor momentum_12_1 --start 2024-01-01 --end 2026-11-06 --rebalance 5 --top-k 50 --min-adt 100000000 --cost-bps 25 --json
```

It uses the harness's next-open and turnover-cost conventions and a Rs 10 crore ADT floor;
the assumed 25 bps per side is not an observed fill. A price-only result does not validate a
combined strategy. Record failures and limitations along with results, and do not retrospectively
declare the selected dates or the run itself a previously frozen holdout.

Result, run 2026-11-08: 90 completed five-session periods after warm-up; mean net excess over
the eligible-universe benchmark +0.1287 percentage points per period, t=0.55. Against NIFTY 500
the corresponding excess was +0.0895 points, t=0.24. Mean one-way turnover was 0.166, with
eight missing exits and five clamped returns reported by the harness. The harness output is
`research/out/codex-momentum-5d-20261108.txt` in this working copy. These are exploratory,
statistically inconclusive results, not evidence of a profitable strategy; five-session
periods are disjoint but not necessarily independent. The code uses a next-*available*-bar
open, which can be delayed for a suspended or otherwise missing symbol; this is not proof of
an executable next-session fill. Future tests must also address the hindsight suspect flags
and adjust for all strategy searches.
