# Stock lifecycle and recommendation audit — 2026-10-24

## Executive verdict

The production pipeline is operational and unusually well instrumented, but the published output
is not yet a validated stock-prediction product. It is best described as an experimental,
cross-sectional prioritisation system with honest monitoring around several known weak models.

- The latest canonical run covers 2,354 stocks and 1,514 of 1,518 liquid names (99.7%). The
  10-stock lifecycle trace passed all 27 plumbing stages.
- Market, fundamentals, options, filings and signal datasets are broadly fresh: 204/209 live data
  quality checks passed before this audit added one new ratio-delivery check; there were no
  pre-existing critical failures.
- The frozen forward test has only 1.4 effective independent 5-day windows. Its published calls
  currently trail the equal-weight liquid universe after 50 bps round-trip costs. Every horizon is
  correctly labelled `LOW-DATA`.
- The larger retrospective scorecard is directionally encouraging but still underpowered:
  published 5-day rank IC is +0.035 over 45 dates, only 9.0 effective windows, and net excess is
  -0.237% after 50 bps. No ranker weight or threshold should be promoted from this sample.
- `calibrated_win_probability` is overconfident: mean prediction 0.518 versus a 0.318 decisive-win
  rate at five days; Brier 0.2560 versus 0.2168 for the hindsight base rate. Against a purged
  trailing base rate, its Brier disadvantage is +0.0269 with a 95% interval of +0.0012 to +0.0482.
  The current ranker correctly drops ML from the blend when the live edge gate shrinks it flat.
- A newly confirmed wiring gap removes the slow financial-ratio family from the latest daily
  `technical_signals` grid. On 2026-10-23, FCF yield, interest coverage and ROCE were NULL for all
  2,151 rows; on 2026-10-22 they covered about 1,589–1,624 of 2,133 rows. The ML builder silently
  substitutes defaults, so output remains superficially healthy. A live DQ check was added; the
  repair itself needs a retrain/replay because it changes model inputs.

This audit does **not** find evidence that the system can honestly promise profitable Buy/Sell
recommendations today. It does find a sound substrate on which such evidence can be accumulated.

## Scope and evidence

The review used repository graph traversal, source tracing, live Postgres queries, process/job
history, the canonical 10-stock lifecycle harness, the frozen forward report, the retrospective
accuracy scorecard, factor-edge replays, data-quality and integrity sweeps, TypeScript/Python tests,
schema drift, build and critical-procedure smoke checks.

Inventory reviewed:

- 262 checked-in/live Postgres tables (schema drift clean).
- 209 pre-existing data-quality checks, plus the new financial-ratio delivery check.
- 70 external-fetch-shaped call-site files from a source-derived scan.
- 104 opt-in live-datasource test artifacts (93 Python, 11 TypeScript).
- Canonical and secondary rankers, feature builders, model training/promotion, outcome resolution,
  user-facing recommendation routes and the default stock-detail surfaces.

The 104 vendor tests were inventoried but not all fired as a single batch: doing so would generate a
large burst against rate-limited third parties. Live production freshness, recent job outcomes and
the existing per-source contracts were used as the whole-universe evidence; anomalies were traced
individually. The endpoint discovery registry itself is 40 days past its last validation, so its
`is_working` flags are discovery history, not proof of current provider health.

## End-to-end lifecycle

```text
Exchange/vendor endpoints
  -> fetcher parsing, provider-ID mapping, provenance and freshness
  -> raw/history tables (PIT where available)
  -> daily technical_signals / feature_store / specialised feature tables
  -> technical, confluence, breakout and ML engines
  -> percentile normalisation + regime blend + quality/veto/coverage gates
  -> unified_recommendations (canonical publication)
  -> API/UI/Telegram + immutable ranker-input snapshots
  -> next-open, horizon-aware outcome resolution
  -> forward report, accuracy scorecard, calibration/edge gates
```

### Collection and identity

The strongest part of the system is the market-data substrate:

- NSE bhavcopy is the primary price/universe authority. Latest coverage was 2,424 symbols, with
  zero malformed bars in the inspected 9,633-row window; 20 suspect rows were quarantined.
- The point-in-time NSE universe exists, which avoids the usual survivorship-only backtest error.
- Corporate-action and ghost-session guards exist. Two fresh split/bonus-shaped gaps remain for
  BANSALWIRE and JSWDULUX and need manual ratio review before any repair.
- Canonical NSE symbol plus explicit provider identifiers is the right identity design. Opaque IDs
  are not guessed across MoneyControl, Trendlyne, ET, MarketsMojo, BSE and other vendors.
- Provider provenance, fetch timestamps, live contracts, freshness checks and schema invariants are
  much stronger than in a typical retail research stack.

Main collection risks:

1. The endpoint registry has not been revalidated for 40 days.
2. `trendlyne-daily-fetch` has recorded five failed aggregate runs in seven days even though each
   run delivered 478–499 of 500 symbols. This is honest failure accounting, but the health report
   does not distinguish a 0.2% miss from a total outage.
3. `company-profiles-sync` has failed daily because the AI provider is unavailable. Only 388
   profiles exist, 359 with analysis, and the newest analysis is 2026-10-05. The UI renders the
   score without an as-of label.
4. The wide daily signal table remains vulnerable to producer-ordering gaps: slow facts written on
   one day do not automatically appear in rows created later.

### Feature construction

Good design choices:

- Point-in-time/as-of helpers exist and are used by core model joins.
- Next-session OPEN is the evaluation entry; suspect bars, minimum liquidity, per-date averaging,
  winsorisation, costs and effective independent windows are explicitly handled.
- Missing ranker-engine scores persist as NULL, not fabricated zeroes.
- Zero/near-zero dispersion engines are excluded rather than percentile-expanded into noise.
- Source snapshots and immutable decision evidence make a recommendation reproducible.

Material weaknesses:

- Many ML features still use neutral numeric defaults for missing inputs. This keeps inference alive
  but makes a stopped writer look like a real neutral market state unless every family has its own
  delivery monitor.
- `feature_store` still has a separate open finding for zero-filled warm-up indicators; this can
  contaminate training and factor studies while passing non-null coverage checks.
- Financial ratio data is fresh in `tl_financial_quality`, but its daily consumer grid can be empty.
  This is a schema-design smell: slow facts should be joined as-of from their source history, not
  copied opportunistically into a daily wide row.
- `target_ret_1d` is naturally NULL on unresolved recent rows and Nifty return columns are
  cross-sectionally constant by design; an integrity sweep must evaluate fields on their declared
  entity/date scope rather than treating every frozen cross-section as broken.

### Engines and canonical ranking

`unified_recommendations` is the canonical surface. Although eight engine columns remain for
diagnostics/history, only confluence, technical, breakout and ML have non-zero configured weights;
the live calibration gate currently makes ML unusable, so the latest actionable recommendations are
effectively a three-engine blend. The latest snapshot contains:

| Classification | Rows | Mean score | Mean contributing engines | Mean R:R |
|---|---:|---:|---:|---:|
| Strong Buy | 59 | 86.39 | 3.00 | 1.38 |
| Buy | 219 | 75.74 | 3.00 | 1.28 |
| Hold | 1,696 | 51.39 | 2.76 | — |
| Sell | 176 | 25.20 | 3.00 | — |
| Strong Sell | 204 | 14.67 | 3.00 | — |

What is correct:

- Per-engine percentile ranking is robust to outliers.
- Missing engines are renormalised rather than treated as zero.
- One-engine directional rows are demoted to Hold; every current Buy has three contributing
  engines and a complete trade plan.
- Fundamental-quality, plan-validity, liquidity/cost, sector and correlation controls reduce risk.
- Engines that repeatedly proved harmful or inert were zeroed rather than kept for cosmetic breadth.

What is not yet justified:

- Regime weights and category tilts are partly hand-set priors. The code openly says BULL/CRASH
  samples are insufficient; shrinkage reduces, but does not validate, that opinion.
- Per-symbol weight renormalisation means scores from different coverage sets are not strictly
  comparable. The actionable coverage gate mitigates the worst case, but Hold rankings still mix
  one-, two- and three-engine geometries.
- Absolute Buy/Sell thresholds operate on a percentile blend whose distribution changes whenever an
  engine is gated. They should be treated as publication policy, not calibrated probabilities.
- “Conviction” is a score tier, not a measured likelihood. The UI and messaging should consistently
  say so.
- Mean Buy risk/reward of 1.28 and repeated formulaic geometry are not demonstrated sources of edge.

Recent open-entry factor replay over 53 ranker dates:

| Score | 5d rank IC | 10d | 21d | Effective 5d windows | Verdict |
|---|---:|---:|---:|---:|---|
| Unified | +0.036 | +0.057 | +0.074 | 8.8 | LOW-DATA |
| Confluence | +0.034 | +0.068 | +0.115 | 8.8 | LOW-DATA |
| Technical | +0.019 | +0.019 | +0.022 | 8.8 | LOW-DATA; top 50 loses |
| Breakout | -0.009 | +0.017 | +0.075 | 8.8 | LOW-DATA |
| ML score | +0.036 | +0.020 | +0.026 | 8.8 | LOW-DATA |

This is not enough independent history to reweight the blend. Confluence is the best research lead,
not a production-proof conclusion.

### Publication and outcome measurement

The lifecycle harness passed for SSWL, LINC, J&KBANK, SWIGGY, ANTELOPUS, KSOLVES, AVONMORE,
INNOVISION, MUTHOOTCAP and TRANSWORLD. It verified 27 stages and showed that sparse symbols are kept
visible rather than silently dropped. AVONMORE lacked several engine/volatility fields, and 164
universe symbols had at most three of eight diagnostic engine fields.

The measurement stack is conceptually correct: immutable publication time, next-open entry, trading
session horizons, costs, equal-weight benchmark, both distribution tails and effective-window
counts. Its conclusion must be respected: the latest frozen forward cohort is too young, and its
early results are negative. The recommendation product should therefore expose:

- “experimental / insufficient forward history” at the product level;
- the number of contributing trusted engines;
- score tier separately from estimated probability;
- as-of time and valid-until time;
- expected transaction cost and liquidity class;
- the exact evidence and vetoes behind each call;
- rolling forward performance by horizon, with `LOW-DATA` visible rather than hidden.

## Data-source value and better uses

| Data family | Current state | Better, honest use |
|---|---|---|
| NSE OHLCV, universe, delivery | Fresh and broad; strongest authority | Keep as label/eligibility authority. Use delivery acceleration as a slow confirmation/risk filter, not a standalone directional signal; its current 5d result is promising but underpowered. |
| Fundamentals and XBRL filings | Broad PIT snapshots; 0/240 recent eligible filings unparsed | Build filing-time surprise and revision features from first-reported values. Neutralise by sector and size. Never backdate a restated figure to fiscal period-end. |
| Earnings forecasts / hit-miss | Fresh, but `mc_earnings_forecast` overwrites `(symbol,date,metric)` and is not consumed | Archive every fetch as a PIT snapshot. Model estimate revision breadth, dispersion, EPS/revenue surprise and post-result drift. Do not use hindsight “hit/miss” before announcement time. |
| Analyst targets/ratings | `analyst_estimates_history` covers 1,060 symbols; `mc_price_forecast` 928 and unconsumed | Prefer target/estimate **revision**, analyst-count change and dispersion over raw target upside. Raw upside often proxies price drawdown. Require timestamped history and broker breadth. |
| Screener memberships | 2.39m PIT rows; directional consensus measured weak/inverted | Use novelty, persistence, exit, crowding and cross-provider disagreement. Do not count every named bullish/bearish screener as an independent vote. |
| Options/OI/IV | Fresh; stock IV coverage 99.8% across 859 rows | Use IV–realised-vol gap, skew change, term structure, OI change and gamma regime as risk/timing/expected-move features. Avoid treating option data as universal: eligibility is a selection bias and many equities have no liquid chain. |
| Pre-open imbalance | 2,187/2,479 bulk coverage and consumed by early-hours research | Use only for intraday/open strategies, with timestamp and executable entry after the snapshot. Measure slippage at open; never leak it into a prior-close recommendation. |
| Insider, block/bulk, institutional | Fresh but sparse; smart-money engine has zero ranker weight | Use event surprise scaled by free float, role, trade type and recency. Separate promoter purchase from option exercise/inter-se transfer. Keep as event/risk evidence until forward edge exists. |
| News and announcements | Fresh, broad, mixed latency; generic sentiment is weak | Classify event type and economic surprise (results, order win, rating action, capital raise, governance) and measure source-to-market latency. Generic tone should be explanatory, not a primary alpha score. |
| Corporate actions / surveillance | Fresh | Use as hard adjustment and tradability controls. ASM/GSM, splits, suspensions and ex-dates belong in eligibility/cost logic, not alpha. |
| Macro, breadth, FII/DII, sectors | Fresh | Use for exposure sizing and regime/risk constraints. Regime conditioning needs persistent episodes; do not fit many regime-specific weights on a handful of BULL/CRASH observations. |
| Company-profile AI | Stale and incomplete; provider unavailable | Remove from any confidence impression. Show as-of/provider status; use vendor text as explanation only, never a factual growth score without source citations and outcome validation. |

Point-in-time factor replay on existing fields also argues for restraint. Interest coverage has
rank IC +0.034/+0.038/+0.051 at 5/10/21 days, but the top 50 loses to the universe and the 5-day
effective count is only 17.4. Delivery trend has +0.026 5-day IC and +0.856% top-50 excess but only
8.8 effective windows. EPS surprise is positive but underpowered; target revision is negative in the
short available sample. These belong in shadow arms, not new production weights.

## Additional data worth collecting

Priority is not “more vendor columns.” The current model already contains many correlated features;
adding another vendor composite is more likely to add duplication than information. Add data only
where timestamp, economic meaning and evaluation protocol are clear.

1. **True estimate revision history.** Persist each broker/consensus EPS, revenue and target snapshot
   with `observed_at`, forecast period, analyst count and dispersion. This is the largest obvious
   gap because current forecast rows overwrite revisions.
2. **First-report filing ledger.** For every XBRL fact preserve filing timestamp, original value,
   revision/restatement timestamp and prior consensus. Derive standardized PAT/revenue/margin
   surprise and acceleration using only information available at decision time.
3. **Execution and capacity data.** Bid/ask spread, auction/pre-open executable price, impact proxy,
   participation rate, circuit proximity, free float and securities-lending/borrow availability.
   Better costs can improve honesty more than another alpha feature.
4. **Ownership-flow deltas.** Quarterly promoter/FII/MF/insurance changes adjusted for corporate
   actions, plus pledge creation/release. Use change and breadth, not ownership level alone.
5. **Event clocks.** Exact announcement receipt time, exchange dissemination time and first tradable
   bar. This permits honest event studies and separates information edge from latency fiction.
6. **Risk-factor exposures.** Rolling market/sector/style beta, residual momentum, residual
   volatility and covariance. Rank on residual expected return and size on covariance, rather than
   stacking highly correlated names with similar raw scores.
7. **Short-side feasibility.** F&O eligibility, borrow/SLB availability, futures basis, roll cost and
   circuit constraints. A `Sell` label without a feasible instrument is analysis, not a trade.

## Recommended prediction architecture

1. Separate **expected return**, **probability of beating the benchmark**, **expected drawdown** and
   **tradability/cost**. Do not compress all four into one “confidence” number.
2. Train horizon-specific cross-sectional models against next-open residual returns, not a generic
   WIN/LOSS label. Use sector/date groups and embargoed walk-forward splits.
3. Calibrate probabilities only when out-of-sample Brier/log loss beats a purged trailing base rate;
   otherwise publish rank percentile without a probability.
4. Keep candidate factors in shadow arms. Promotion requires at least 20 effective windows, stable
   sign across liquidity floors/regimes, both-tail separation, and positive net excess after realistic
   costs and turnover.
5. Build a small orthogonal ensemble: event surprise, quality/revision, price/volume residual
   momentum, and risk/liquidity. Weight families by validated incremental contribution, not vendor
   count or intuition.
6. Make abstention first-class. If calibration, coverage, liquidity or engine agreement fails,
   publish “insufficient evidence” rather than forcing Hold/Buy/Sell into a complete universe.
7. Evaluate the actual portfolio: sector/factor exposure, turnover, capacity, drawdown, hit rate,
   payoff and benchmark-relative return. Per-stock classification accuracy is not enough.

## Prioritised action plan

### P0 — honesty and measurement

1. Keep ML excluded until its purged Brier score beats the trailing base rate and its rank edge
   clears the promotion gate.
2. Label canonical calls experimental/LOW-DATA and expose trusted-engine coverage and as-of time.
3. Fix the financial-ratio propagation path, retrain from the corrected population boundary, and
   replay all promotion gates before activating the model.
4. Review BANSALWIRE and JSWDULUX corporate-action gaps before applying any OHLCV repair.

### P1 — highest expected research value

1. Turn `mc_earnings_forecast`, `mc_estimates_hits_misses`, NSE XBRL and analyst histories into a
   timestamped earnings-revision/surprise shadow arm.
2. Test confluence’s incremental value against a no-confluence baseline; it is the strongest current
   lead but remains low-data.
3. Test delivery acceleration and screener novelty/tenure as independent residual factors, not as
   directional votes.
4. Replace raw target upside with revision, dispersion and analyst-breadth features.

### P2 — reliability and product clarity

1. Revalidate the endpoint registry and distinguish partial-batch degradation from outage.
2. Restore or explicitly disable company-profile AI; show `last_updated` wherever it is rendered.
3. Optimise `getModelRocDiagnostics`, which exceeded the 15-second critical-procedure budget; its
   current plan scans roughly 214k technical rows and joins about 142k resolved outcomes.
4. Split the overloaded `model_registry.cv_roc_auc`/`cv_accuracy` columns into typed metrics. The
   exit-policy row stores regression MAE in the AUC field, which is documented in code but misleading
   to generic readers and dashboards.

## Changes made during this audit

- Removed the remaining host-calendar fallback from
  `financial_ratios_fetcher.update_technical_signals`; direct/manual calls now resolve the last
  completed trading session and fail loudly if none exists. A negative-control regression failed
  on the old code and passes on the fix.
- Added `technical-signals-financial-ratio-delivery`, a data-quality check that detects the exact
  fresh-table/dead-feature failure now present in production. Its threshold is calibrated against
  the measured 74.5–76.1% healthy-session coverage, not an assumed 100% ideal.

No weights, thresholds, model artifacts or classifications were changed.

## Remediation follow-up — 2026-10-24

See `audit-remediation-plan-2026-10-24.md` and the findings ledger for deployment and remaining gates.
Financial delivery was bounded, replayed and applied; immutable observations were installed with true
installation-time baselines; a research-only estimate consumer now accumulates prospective history.
These changes do not establish a profitable prediction model.

The historical warm-up defect (AF-20261021-03) is now reproduced from actual RELIANCE OHLCV, not
inferred from column coverage. The real feature function produces:

| Session | Full-history ADX / ATR / above-SMA200 | Read window starting 2025-04-28 |
|---|---|---|
| 2025-05-02 | 26.8288 / 32.4455 / 1 | 0 / 0 / 0 |
| 2025-05-09 | 30.2453 / 29.7012 / 1 | 0 / 0 / 0 |
| 2025-06-02 | 24.0507 / 24.8733 / 1 | 0 / 25.4066 / 0 |

Underlying prices are healthy. The stored April25 row was computed September13 and is valid;
April28 was computed September14 and is zero, matching the 504-calendar-day read cutoff. Both
serial and worker full-backfill paths persist their own warm-up region over older observations.
The repair must separate the preceding-bar read/warm-up window from the write window, preserve
per-feature missingness, rebuild bounded history and compare retrained candidates before promotion.
No feature-store overwrite was made during this diagnostic. DL training already derives binary
labels from non-NULL raw returns; its legacy direction columns are not its active target.

ROC SQL is much faster and exactly equivalent, but one cold-start smoke still timed out under
host load despite subsequent sub-second/one-second cache-miss calls. AF-20261024-03 stays open
for tail-latency validation. A separate redundant heartbeat ALTER blocked monitoring behind the
nightly backup; the matched waiting DDL was cancelled without stopping the backup, and a catalog-
first/bounded-bootstrap repair is being verified (AF-20261024-07).
