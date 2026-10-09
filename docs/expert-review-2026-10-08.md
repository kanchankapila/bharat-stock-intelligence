# End-to-end expert review, 2026-10-08

Trader + quant + data-science review of data, scores, signals, UI and measured accuracy. Findings are filed as
AF-20261008-11..27 in `docs/audit-findings.md` (the only tracker); numbers are recorded in `.claude/rules/measurement.md`
(2026-10-08 entry). Every figure here was queried live in this session; ratings are [Certain] / [Likely] / [Guessing].
Nothing was committed, deployed, restarted or written to production. Re-derive any figure with the scripts named in
the ledger rows (review scratchpad) before quoting it.

## 1. The answer first

**What accuracy is realistically achievable on this data? A small, regime-dependent ranking edge, not a "highly accurate" predictor.**

- Published equity factors run rank IC 0.02-0.05 and hit rates of 52-55% against a benchmark. This platform's published
  score reads **IC +0.052 (5d) / +0.069 (10d) at Rs10cr, +0.043 / +0.051 at Rs50cr** over 40 sessions. That is inside the
  normal band, *not above it*, and it comes from **one falling-tape window** (Nifty -8%), with a **low-beta tilt**
  (corr with beta -0.16; IC after beta-residualising +0.043 / +0.054). [Certain on the numbers, Likely on the interpretation]
- Top-decile calls beat a random pick's hit rate by about 5 percentage points (45.7% vs 40.4%; chance is 40%, not 50%,
  because Indian cross-sectional returns are right-skewed). Net excess is **+0.15% per 5 days at 0.30% round trip, and
  -0.05% at the frozen 0.50%**. That is the range of "no edge" to "a thin edge that costs eat".
- **Where it fails is the trade plan, not the ranking.** Closed BUY plans: June +1.7% net (n=3,908), July +0.3%, August -0.5%,
  **September -2.4% net with 68% stopped out** (n=18,848, 15-session); intraday about -0.5 to -0.9% per signal with a ~23% win
  rate over 47 sessions, both directions. Stops sit 5-6% away with targets at 2-4R on windows where the median favourable
  excursion is under 1 ATR at 5 sessions. The geometry is a null lever (measured earlier); the plan is a way of *expressing* a weak
  ranking that turns a +0.1% relative edge into an absolute loss in a falling market.
- **Nothing here can be called proven until the frozen forward test has 20 independent windows: 5d about 2027-02-26, 10d about
  mid-2027, 21d 2028.** Statistical power is not the constraint (the IC's window-to-window sd is only ~0.05); *regime coverage*
  is. There is no bull-tape sample, no sample longer than 40 sessions, and no closed forward window.

**Design for the honest case:** treat the product as a ranked watch-list with disclosed uncertainty, publish "no call"
when the ranking has no usable spread, and let the forward test, not a model's own score, decide promotion.

## 2. What is wrong and should be corrected (expert view)

Ordered by what most changes a trader's decisions. IDs are ledger rows; "fixed" means in the working tree, deploy pending.

1. **The product speaks with more confidence than the evidence allows.** Green "Canonical model" badge, "most accurate only" tiers
   (`conviction_level` is the rating relabelled, AF-20261008-05), "confidence" that is a rank, "Win P" 51% against a realised 32%
   (AF-20261008-17), "HIGH-strength intraday" on a filter that never matched. *Fixed for the routed canonical page and tiles
   (AF-20261008-18).* Remaining: Stock Intelligence "Composite Score / % confidence", Decision-Matrix wording sweep (-19).
2. **Honesty fixes landed where no user could see them.** The previous session patched an unrouted component. The process fix is
   in CLAUDE.md (confirm a route renders a component before editing it). Add a CI check that fails if a component with
   `planStatus`/disclosure props is imported by nothing. (-18, -26)
3. **Features that were not what their names said:** `days_to_next_results` 92% fictional (-12, fixed); `earnings_shocker_flag` 89% constant (-14, fixed);
   earnings dates joined to the wrong company on 58 ambiguous ids (-14, fixed); "sector strength" is the stock's own momentum, double-counted
   in confluence (-24, label fixed, score open); `basis` stored in rupees; `pcr_vol == pcr_oi` earlier; ML features that are date-constants (-22).
   Pattern: **a feature registered, fetched and monitored as "fresh" while its meaning had decayed**. The monitoring sees rows, not meaning.
4. **The score is shaped by layers nobody measured.** The published rank has IC +0.052 vs +0.085 for the plain blend of its own engines (-16):
   `ml` (IC +0.016) gets a full influence share via percentile normalisation of a 5-point-wide engine; the red-flag veto halves the score of
   17% of liquid names with no recorded grade (-25); the high-vol veto helps over 4.5 years but costs IC in this window. None of these is a
   reweighting I recommend now; all are EVIDENCE rows with shadow arms.
5. **Regime detection lags the market and its history is in-sample** (-21): 7 months below the 200-day mean labelled SIDEWAYS at p~1. Anything
   "by regime" in this repo is partly an artifact of that. Use an objective, point-in-time regime (index vs 200DMA, breadth, vol term) as the
   conditioner until the HMM beats it on a replay.
6. **The research panel is not survivorship-free, but the bias turned out small.** `stock_ohlcv` has only 23 symbols that stopped trading since
   2025; `nse_universe_history` has 973 EQ-series symbols it lacks, but most "ended" names are *renames* (TWL->TITAGARH, LSIL->LLOYDSENGG), not
   delistings. Re-running the three closest-to-survivor factors on a survivorship-reduced panel changed no verdict (section 7).
7. **Five graders, five definitions of "win".** `signal_outcomes` (path barrier, rewards volatility), `unified_signal_outcomes` (111,665 short
   rows graded with a long-only simulation, AF-20261008-10), `intraday_*_outcomes`, `live_screener_outcomes`, `market_decision_outcome`, and the
   frozen `forward_test_report`. A dashboard "Win Rate" of 13.5% and a LONG 35.86% are both "correct" for different definitions. One arbiter.
8. **News sentiment is post-hoc, and still wired in** (-20): the 3 sessions before entry already moved +0.95% / -0.79%; open-entry spread is
   negative; 70 job-hours a month. Keep for display.
9. **Operational weight exceeds product value** (-27): ~480 job-hours a month, 97 write-only tables (5.7 GB), 4 of 8 engines at weight 0 still
   scheduled, 6 recommendation surfaces, 2 frontends (v1 + TALA), 2 feature stores (`technical_signals` with 63 writer files, `feature_store`).

## 3. Is it over-engineered, and what is the right architecture?

**Yes.** Detail and evidence: table below (from the architecture audit, counts re-derived live 2026-10-08).

| Counted | Value |
|---|---|
| Python modules (non-test / all) | 298 / 723 |
| Fetchers | 82 |
| tRPC routers / procedures | 29 / 324 |
| JOB_REGISTRY entries / critical | 73 / 19 (88 distinct job names ran in 30 days: 478.9 job-hours, 33,736 ok / 144 failed) |
| pm2 apps | 8 (6 online; two cron apps idle) |
| Public tables / hypertables / DB size | 259 / 6 / 31 GB |
| Tables with 0 rows / no writer in code / no reader but their writer or monitors | 13 / 6 / 97 (5.7 GB) |
| Routed frontends / routes | v1 72 + TALA 10 |
| Ranker engines / weighted | 8 / 4 (ml, confluence, technical, breakout) |

**Measured marginal value (Rs10cr, 35/31 dates):** confluence IC +0.094/+0.135 and is the ranking (drop it: +0.049/+0.065). ml +0.016 (drop it: the blend *rises*).
technical +0.032/+0.022 yet it decides 32 of the top 50 on a tail effect. breakout +0.056/+0.091 (on the generic grid earlier readings were ~0).
dl, cs, smart_money, screener are weight 0.0 and cost compute without changing a score (dl alone ~42 job-hours a month).

**Recommended architecture (the simplest that could earn the goal):**
point-in-time feature store (one table, raw as-of values) -> ~10-16 factors that survive cost-aware tests (delivery %, confluence, a
beta/vol-aware low-risk tilt, industry RS, earnings-window as a *risk* flag) -> one calibrated model per horizon (label = forward excess
rank, purged CV) -> plan generator (ATR rule unless a model beats it) -> lifecycle closer (`signal_lifecycle.py`) -> the frozen grader.
**`bharat_alpha` already implements this** (own DB, 5 models, self-grading, 6 prediction dates, 0 graded). Do not build a third system:
grade it under the same frozen rules.

**Migration order (nothing deleted without your approval; every drop preceded by `pg_dump -t`):**

| # | Step | Risk | Acceptance criterion |
|---|---|---|---|
| 0 | Freeze: no new engine, table, job or model until step 6 | none | no new `model_registry` names, no new tables in `schema:drift` |
| 1 | Grade `bharat_alpha` with the frozen rules (sibling read-only script, shuffled-score negative control) | low | both systems on one tier table; shuffled control with a t-statistic under 1 |
| 2 | Pause zero-weight compute (`dl-trainer`, `dl-feature-refresh`, `dl-engine-infer`, movement-predictor train, `engine_composite`) | low | ~45 job-hours/month saved; next `unified_score` ranks identical to a pre-pause dry run |
| 3 | Shadow arms for overlays and `ml` (needs a migration for per-row veto flags) | low | decided at 20 independent 5d windows (~2027-02-26) |
| 4 | Retire dead code (ontology layer, `cs_ranker`, `online_learner`, `flyer_classifier`, `pead_model`, `movement_predictor`, `engine_composite`) | medium | tsc, vitest, pytest, `schema:drift` green; ~12k LOC removed |
| 5 | Write-only vendor tables: stop the fetch or label as archive (start with 4.2 GB NiftyTrader snapshots, 1 GB `mc_general_metrics`) | medium | 5.7 GB freed or labelled; DQ entries removed together |
| 6 | Decision gate: `bharat_alpha` 5d top-10% hit lift > 0, t >= 2, 20 windows, and beats legacy net of 25 bps/side -> switch UI/Telegram behind an `app_settings` flag | high | both reports for 20 sessions after cutover |
| 7 | Retire the legacy engines and the intraday stack | high | job-hours down >= 50% with unchanged forward lift |

If step 6 never passes, the honest conclusion is that no system here has edge, and the product should show the frozen report and stop
publishing Buy calls. That is your decision, flagged now (AF-20261008-27).

## 4. Accuracy against reality: day / week / month

Retrospective on the published ranking (`unified_recommendations_history`, 2026-08-10..10-07, 40 sessions, next-session open, winsorised, per-date).
**Not the forward test; LOW-DATA at every horizon.** Sources: `retro_scorecard.py`, `beta_check.py`, `engine_ablation.py` (review scratchpad).

| Horizon | Entry/exit | Universe | Independent windows | Rank IC | Top-10% net excess (0.30% RT) | Verdict |
|---|---|---|---|---|---|---|
| Day (intraday product) | picks vs next-session path, 47 sessions | `intraday_recommendation_outcomes` | 47 sessions | n/a | LONG -0.47..-0.86% per signal by month, SHORT -0.64..-0.70%, win ~21-25% | **No edge; negative.** The emission gate exists and is honest on `/intraday` |
| Week (5 sessions) | open t+1 -> open t+6 | Rs10cr / Rs50cr | 7 | +0.052 / +0.043 | +0.15% / +0.0..+0.2% | thin, positive, one regime, LOW-DATA |
| 2 weeks (10) | open t+1 -> open t+11 | Rs10cr / Rs50cr | 4 | +0.069 / +0.051 | +0.58% (0.30%) | LOW-DATA |
| Month (15-21) | open t+1 -> open t+22 | Rs10cr / Rs50cr | 1 | +0.061 / +0.010 | n/a | **cannot be assessed**; no months-scale model exists (the label is a heuristic, AF-20261008-04) |

**Plan layer (absolute returns, closed BUY, 15-session):** Jun +1.69% net, Jul +0.32%, Aug -0.50%, Sep -2.38% (68% stopped), Oct (n=695) -3.80%.
These move with the tape (Nifty -8% since Aug 7); they cannot be read as ranking skill in either direction.

**Calibration:** `calibrated_win_probability` 0.51 predicted vs 0.32 realised, Brier 0.252 vs 0.219 for the base rate. It is a rank. Show it as such.

**Recurring scorecard design (proposal, not built; registering a job needs your approval):**
1. Weekly: read `app_settings['forward_test_report']` (frozen, nightly) and add the shadow arms (re-blend, re-blend + vol veto, re-blend without ml,
   published, random-matched control) per tier, per horizon, per liquidity bucket, per regime (objective regime, not HMM). Publish a one-screen
   Telegram + UI scorecard with n, independent windows, hit rate and lift with CI, net expectancy, payoff ratio, max drawdown, turnover,
   calibration (reliability bins + Brier vs base rate).
2. Monthly: the same at 21d plus a cost-capacity table (ADT buckets, 2% participation).
3. Alerts: (a) published-tier lift CI includes zero or turns negative for 3 consecutive weekly runs after the eff-window floor is cleared;
   (b) Brier worse than the base rate; (c) top-decile coverage falls below N names/day or dispersion collapses; (d) an engine's rolling IC changes
   sign on 20+ windows; (e) any feature's non-null share or distinct-value count collapses (the A-01 class). All are read-only on existing tables.
4. Say "no call" in the product when the tier shows no usable spread.

**What more evidence unlocks, and when:** 5d verdict 2027-02-26; regime split (needs a bull sample): when the tape turns and ~40 sessions accumulate;
macro-feature ablation ~2026-11-20; regime replay ~2026-11-10; 10d mid-2027; 21d 2028.

## 5. Per-factor verdict table

| Family | Fetched correctly? | Stored correctly? | Point-in-time safe? | Used correctly? | Measured information | Contribution to score | Verdict |
|---|---|---|---|---|---|---|---|
| Fundamentals | Yahoo daily 2,474 syms; ROE only 5.9% in `stock_fundamentals` (quant path) though 86% in history | quant_scores ROE 11% (-15) | daily snapshot OK; Trendlyne histories restatement risk | quality gate only (x0.85 on 43%); `_fund_mult` dead | growth +0.07..+0.11 5d IC, Piotroski +0.04..+0.06, value negative - all one results season, LOW-DATA | gate +0.003 IC | FIX coverage + MEASURE-MORE |
| Technicals | yes | wide table with 63 writers | mostly | `technical` engine IC ~0 yet decides the top of the book | known nulls/negatives (mean reversion, momentum_21/63, gaps) | weight .24-.51 | KEEP on probation; drop at 20 windows if null |
| Earnings | dates 99.6% exact vs reported; 58 ambiguous ids (fixed) | countdown smeared (fixed); stale reschedules (fixed) | `fetched_at` is last-seen | feeds ML only; no direct term | reaction H-L +4.4% (t 8.9, [0,+1]); pre-event drift +2.1% (t 2.7); post-event drift from t+2 open nil | ML features | FIX done; use as RISK flag; drop PEAD as direction |
| Analyst/consensus | ~1,056 syms daily since 09-01 | buy/hold/sell are percentages under count names | 06-21/22 rows backfilled 08-15 (look-ahead) | trio in ML only | trio has 4 independent windows; ungradeable until ~late Dec | ML only | FIX PIT + MEASURE-MORE |
| Company/market/global news | running; 118,874 de-duplicated links | impact = |score| | `GREATEST(published_at, fetched_at)` only | display + stock_scores + ML | **none**: spread -0.11%/day (t -1.29), hit 45.6% vs 46.8% null | indirect | RETIRE as alpha; keep display (-20) |
| Macro / global / pulse | 22-day hole in one series (check added) | duplicate VIX, ADRs in a macro table | stamp times unverified | ML date-constants | not measured | via ml_score | MEASURE-MORE ~2026-11-20 (-22) |
| Indices | yes | `INDIA_VIX` vs `INDIAVIX` | yes | HMM input | n/a | via regime | KEEP, unify names after ablation |
| Regime (HMM) | daily since 08-10 | 681 rows in-sample | **no before 2026-08-10** | weights; 3 of 5 sets never used | lags the 200DMA by weeks | ~7/50 top names on a flip | EVIDENCE (-21) |
| F&O OI/basis/PCR/rollover | 230-235/day vs 223 F&O names | basis in rupees; phantom non-trading rows (guards added) | calendar-date stamps (fixed) | graded only | basis 1d IC +0.077 (26 windows) but net negative, futures leg inverted; OI/PCR/rollover ~0; own build-up classes = 1-day reversal | 0 | RETIRE as a ranker factor (-AF-20261003-05 closed) |
| Sector / breadth | sector 100% | OK | OK | "sector" slot = own momentum (-24) | industry RS +0.024 5d beyond momentum (t 4.7), loses after cost | via confluence | FIX label done; EVIDENCE on the slot |
| Screeners | fresh | OK | membership snapshot point-in-time | weight 0; red-flag veto live | 98% of liquid names conflicted; 0 survive FDR; movement not direction | veto x0.5 on 17% | MEASURE-MORE (-25) |
| Pre-market IEP/gap | 68 dates | 26 written outside the window | no | `early_hours_predictor` only | capitulation combo is the one validated small-capacity edge | 0 | FIX window guard (open), MEASURE-MORE |
| Delivery/block/bulk | delivery 71 dates; `bulk_deals` dead since May | OK | EOD, safe for next-open entry | ML features | real spread; long-only -1.04%/period | 0 | KEEP feature; retire `bulk_deals` |
| Insider/promoter/pledge | `insider_transactions` dead 05-02 | OK | 7-day lag in history | smart_money (weight 0) | insider_net t=1.73 NS | 0 | ACCEPT; retire dead schedule |
| FII/DII/MF | daily fresh | OK | safe for D+1 open | market-wide ML | not graded (conditioner) | 0 | MEASURE-MORE (calendar) |

## 6. Frontend: what a trader still lacks

Fixed this session (deploy pending): plan status, classification and horizon chips, honest dates, disclosure strip, honest win-rate tiles,
no heuristic dressed as ML, no invented regime, dead sections removed. **Still missing / weak** (all additive; none changes a score), with the
data that already exists:

| # | Build | Data source | Reuse | Effort |
|---|---|---|---|---|
| 1 | "What changed since yesterday": new buys, drops, class flips, expired plans | `unified_recommendations` last two `computed_at` | `v1-card` | S-M |
| 2 | Reliability curve + score-decile realised return, net of cost, with n of independent dates | `signal_outcomes` / `unified_signal_outcomes` (after the short re-grade) | recharts | M |
| 3 | Forward-test view (frozen report per coverage tier, with hash and "calendar-blocked" note) | `app_settings['forward_test_report']` | SignalReportCard slot | M |
| 4 | Plan lifecycle timeline per stock (generated -> entry -> valid_until -> T1/SL/expiry, realised net) | history + outcomes | `V2LightweightChart` price lines | M |
| 5 | Signed score decomposition (weight x (engine - 50)), all 8 engines, missing engines greyed | ranker columns + weights | replace ScoreBar | M |
| 6 | Market pulse strip (A/D, % above DMAs, new highs/lows, VIX, FII/DII, objective regime) with as-of | existing procedures | MarketMoodGauge | S |
| 7 | Sector rotation (RS line / RRG) | **unused** `getSectorRotationHistory` | recharts | M |
| 8 | Stock-level F&O build-up table (price vs OI quadrant, delta OI, PCR history) | `getFuturesBuildupMatrix`, rollover | FnOHeatmap | M |
| 9 | Earnings chips (days to results, last surprise, beat streak) on pick cards | already in `getBuyRecommendations` payload | `StockTagRow` | S |
| 10 | Mobile/a11y pass on Dashboard and Alpha (fixed inline grids overflow; cards need role/keyboard) | - | `src/lib/a11y.tsx` | M |
| 11 | Retire dead components (`AlphaCockpit`, `BuyRecommendationsPage`, `DLDashboard`, `TrendlyneSectorDashboard`, `navGroups.ts`); merge 5 duplicate nav entries | - | - | S-M, needs your OK |

Product decisions: default Alpha to Buy/Strong Buy only; keep or drop the cockpit TRADE / NO TRADE verdict (it now cannot be driven by a
heuristic, but its threshold is arbitrary); relabel or drop the swing/intraday split (the horizon is a heuristic).

## 7. Survivorship-free re-test of the closest-to-survivor price factors

Identical settings on both panels (21-session non-overlapping, next-open entry, Rs10cr floor, 25 bps/side, 55-66 periods, 2021-2026; the harness
check reproduced the recorded momentum_12_1 +0.7892%, t 1.61):

| Factor (top-K) | Existing panel | Survivorship-reduced panel |
|---|---|---|
| momentum_12_1 top-10 | +0.62%/period, t 1.38 | +0.74%, t 1.60 |
| momentum_12_1 top-50 | +0.50%, t 1.19 | +0.59%, t 1.41 |
| low_vol top-10 / top-50 | -0.73% (t -1.94) / -0.46% (t -1.41) | -0.64% (t -1.53) / -0.44% (t -1.32) |
| reversal_21d top-10 / top-50 | -0.65% (t -2.20) / -0.60% (t -2.47) | -0.75% (t -2.44) / -0.59% (t -2.43) |

No verdict changes. [Likely] - the agent's written report was cut off by a rate limit; figures are from its logs, and rename continuity was only
spot-checked (10 of 12 sampled "gone" names are renames). A fuller treatment would use ISINs for continuity.

## 8. Missing gaps (what a professional desk would have that this platform does not)

1. **A portfolio-level backtest of the *published book*.** Everything is per-signal or per-factor. There is no replay of "hold the top-N of the
   published ranking with this turnover rule, sizing, sector caps and ADT-capped capacity", which is the thing a user actually experiences.
2. **A market-neutral expression.** A ranking with beta tilt and +0.1% relative edge needs a hedge (Nifty futures) or a beta-neutral basket to be
   judged; absolute plan returns are mostly the tape.
3. **Execution and cost realism by liquidity bucket.** A flat 0.30% round trip is fine at Rs50cr+ and optimistic at Rs1-10cr. Missing: slippage vs
   participation of ADT, gap risk at the open (the "flagged in advance" signal is 100% overnight gap), and a capacity table.
4. **A bull-regime and a drawdown-regime sample.** Everything measured since 2026-08-10 is one falling tape. Use the 2021-2026 price panel to test
   the *factors* by objective regime; the ranker itself cannot be tested earlier (it starts 2026-08-10) - state this wherever it is shown.
5. **A survivorship-free, corporate-action-checked price panel** (the universe history exists; wire it into the research harness, with the
   split/bonus handling that bhavcopy needs).
6. **Pre-registration and a multiple-testing register.** Hundreds of factor tests exist; the ledger records outcomes, not the count of looks. Keep
   a registry of hypotheses tested and apply FDR across them, as the screener study already did.
7. **A paper-trading ledger with real fills.** A forward test grades open-to-open; a trader needs entries/exits at realistic prices (opening
   auction, VWAP), with the plan's actual stop/target, written daily.
8. **A "no call" state and an abstention model.** The product always publishes. A ranking whose edge appears only in some regimes or only in the top
   1-5% should say "no call" otherwise (the forward test already reports coverage tiers).
9. **Options-derived signals are ungraded** (IV vs HV, skew, term structure, max-pain behaviour). Index PCR history starts 2026-06-30. Do not invest
   until 12 months exist.
10. **Short-side tooling.** Sell/Strong Sell means "avoid" (cash settlement), which is right, but F&O names have no short plan and the platform never
    grades the short leg as an *excess* (a possibly better use of the same ranking than the long leg).
11. **Point-in-time fundamentals with reporting lags** (use filing date, not period end) and long analyst-revision history; today's revision trio has
    4 independent windows and the ROE history was nearly lost to a vendor change without any alarm.
12. **Event risk handling.** The earnings clock was corrupt for months. A correct "reports within N sessions" flag is useful as a *risk* control
    (position-size down, avoid new entries), not as a direction signal.
13. **One feature store with as-of semantics.** `technical_signals` (63 writers) and `feature_store` overlap with different point-in-time rules; that
    is the root of repeated leak and train/serve skew bugs.
14. **A monitor for meaning, not rows.** The best new checks this session (non-null share per series, distinct-value count, computed-vs-stored
    recomputation for the earnings countdown) catch a feature that is "fresh" but wrong. Add a handful of them for each ranker input.

## 9. Roadmap

**Do now (needs your approval for deploy):** build the frontend; `pm2 restart bharat-server`; run `npm run schema:drift` (no migration was written).
Both tested paths are in the ledger rows' Immunized cells.

**Do next (low risk, no score change, needs approval where noted):**
1. Grade `bharat_alpha` under the frozen rules with a shuffled-score negative control (read-only script).
2. Run the history-repair proposal in AF-20261008-13 behind `pg_dump -t` (production writes, your approval).
3. Pause zero-weight compute (step 2 above).
4. Build UI items 1, 3, 6, 9 (S effort, data already present).
5. Add the pre-open window guard, the `basis_pct` writer column only if a future factor needs it.

**After more data (with dates):** regime replay ~2026-11-10; macro-feature ablation ~2026-11-20; analyst-revision trio ~late 2026-12; frozen 5d forward
test, shadow arms (overlays, `ml`, red-flag veto, confluence double-count, quality gate, ROE restoration), the calibrator refit: **2027-02-26**.

**Needs your decision:** the production writes in AF-20261008-13; news-sentiment cadence and wiring (-20); UI scope and component deletions (-19);
the ordered architecture plan and any pause/retire (-27); whether to stop publishing Buy calls if step 6 fails.

## 10. Caveats on this review

- The retrospective is one falling tape of 40 sessions; its positive IC is not evidence of edge and its negative plan returns are not evidence of no edge.
- Overlay effects (-16) use an approximation of the ranker's inputs (rank-normalised stored engine columns; stand-in Piotroski/ROE; a 20d-vol veto proxy); the
  reconstruction correlates only about 0.5-0.64 with the stored score. The direction is [Likely], the magnitudes are [Guessing].
- Agents ran the data-family, frontend and architecture audits; their reports sit in the review scratchpad. Their conclusions were spot-checked against
  live SQL where they changed a decision (calibration, engine ablation, survivorship counts, partial-day join), not re-derived in full.

## 11. Update 2026-10-09: the regime question, answered for the rebuildable part

A multi-regime replay (2021-2026, survivorship-reduced, next-open, non-overlapping windows; ledger AF-20261008-29, `measurement.md` 2026-10-09)
changes three statements above:
- **Section 1/4:** the published IC of ~+0.05 is mostly a property of its falling-tape window. The price-only proxy reads +0.073 in that window
  and +0.003..+0.014 at 5d over 2022-2026. Treat the edge as "unproven, regime-dependent".
- **Section 1 (beta tilt):** low beta is a bet on the market falling (IC +0.072 when it fell, -0.050 when it rose), not an edge.
- **Section 2 item 4 (overlays):** the high-vol overlay is a small consistent plus over 5 years (IC +0.008, t 3.9). The -0.013 seen in the
  40-session window was the falling-tape exception. Keep it; the red-flag and crowding overlays remain unmeasured.
- Delivery trend (5d minus 20d) is the only rebuildable input positive in every regime and year, but it is too weak to survive costs alone.
