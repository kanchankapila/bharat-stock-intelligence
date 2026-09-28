# bharat_alpha — architecture

## What it is for

bharat_alpha ranks the tradeable NSE cash-equity universe by expected forward excess return over
5 and 21 sessions. Every ranking is written to an immutable ledger, graded against what the
market actually did, and fed back into the model. It also says, in every output, whether the
ranking has earned trust.

"High accuracy" in a cross-section of Indian equities means something specific, and the legacy
platform measured it. Its canonical ranker read rank IC ≈ +0.05. Most published factors died
once costs were applied, and a factor with a well-powered, out-of-sample positive IC still lost
0.5–0.9% per period net. So the realistic ceiling is a small, persistent edge. The system is
built to do three things:

1. Find that edge if it exists, using the full breadth of point-in-time data.
2. Prove it with an evaluation that cannot flatter it: out of fold, overlap-corrected,
   cost-aware, and benchmarked against the mean.
3. Keep it honest while it runs. The system grades itself daily, adapts, and demotes itself
   when reality disagrees.

If no model clears the gate, the system still publishes, but every row is marked
`edge_status = 'unvalidated'`.

## Shape

```
          exchange files / vendor APIs
                     │  ingest.* connectors (fetch → parse → write, ledgered in ingest_run)
                     ▼
   Postgres schema `alpha`  ── the only store ──────────────────────────────────────────┐
   instrument / symbol_history / provider_id        (identity: instruments, not symbols) │
   daily_bar (raw) + adjustment (from NSE prev_close) + trading_day (exchange calendar)  │
   fo_daily · index_daily · market_flow · corporate_event · deal · fundamental           │
                     │  marketdata.load_panel  (adjusted, suspect-masked, PIT)           │
                     ▼                                                                   │
   features.build_features   per-date rank→Gaussian; knowable_at-gated joins             │
   labels.forward_returns    next-open entry, stopped-trading exits, inward winsorising  │
                     ▼                                                                   │
   modeling: purged walk-forward (by date) → LightGBM regressor + LambdaRank + ridge     │
             → out-of-fold report (evaluation.metrics + evaluation.backtest)             │
             → gate → registry (candidate / champion / rejected / retired)               │
                     ▼                                                                   │
   daily DAG: ingest → quality → resolve+adapt → monitor/retrain → predict → publish → DQ │
             prediction (append-only) → outcome → realized_eval                          │
             ensemble_weight (Hedge) · conformal_state (ACI) · realised recalibration    │
                     ▼                                                                   │
   alpha.recommendation  — THE canonical output (one writer) ◄───────────────────────────┘
                     ▼
   FastAPI (read-only): /recommendations /stock/{symbol} /models /health
```

The production footprint is two processes (`bqa scheduler`, `bqa serve`) and one Postgres. The
legacy system ran five services, eleven dormant jobs, two languages and a second SQL dialect.

## Design decisions and the legacy failure each one closes

| # | Decision | Legacy failure it prevents (from `.claude/rules/*`) | Enforced by |
|---|---|---|---|
| 1 | Python + Postgres only; all SQL schema-qualified (`alpha.`) | TS/Python split, SQLite↔Postgres dialect bugs, unqualified names resolving to the wrong schema | single codebase; tests on a real, **empty** Postgres DB |
| 2 | Universe from the exchange bhavcopy; instruments ≠ symbols | 2,436 of 2,450 symbols in history were still trading (survivorship); renames split histories (TATAMOTORS→TMPV) | `test_sim_ingest_split_rename_badprint_delist` |
| 3 | Corporate-action factors from NSE's own adjusted `PREV_CLOSE` | vendor corporate-action feeds that drift; unadjusted splits read as −50% days | same test (split → factor 0.5, no −50% return) |
| 4 | Suspect bars flagged (never deleted) and excluded; an adjustment is inferred only when the adjacent bar is trustworthy | a +127,900% RELIANCE bar → 850%/yr phantom edge | same test (bad print is not read as a 1000:1 action — this bug was caught in development) |
| 5 | `knowable_at` on every external fact; joins use the date a fact became usable to the live run (cut-off 19:00 IST) | vendor restatements, event-date joins, train/serve skew | `_known_date`; `test_features_have_train_serve_parity` |
| 6 | NULL means unknown; NaN coerced to NULL at the DB boundary (`db.to_db`, `db.jsonable`) | 0.0 sentinels hiding "engine never ran"; pandas turning `None` into NaN past an `is None` guard | `upsert` coercion; JSONB sanitiser (caught a NaN in development) |
| 7 | Provider in the PK wherever two sources can write one natural key | 4 recurrences of provider-id collisions | schema (`market_flow`, `corporate_event`, `deal`, `fundamental`) |
| 8 | Connectors declare health; freshness and per-field fill-rate checks are generated from the registry; "empty" and "not_published" are run statuses | ~115 of ~140 fetchers unmonitored; ROE fill fell from 86% to 6% while the table stayed "fresh"; success stamped on runs that wrote nothing | `quality.checks`, `ingest.base.run_connector`, `test_run_ledger_records_success_empty_and_not_published` |
| 9 | Features are normalised cross-sectionally per date (rank→Gaussian), never per symbol | per-symbol RobustScaler reordered the cross-section; every feature-store IC was wrong (AF-20260910-18) | `features.cs_rank_gauss` |
| 10 | Labels: next-session open entry, delisting exits kept, **inward** winsorising | close-entry ICs 2× inflated at h=1; linear-interpolation winsorising left outliers in place | `test_winsorize_actually_clips_a_lone_outlier` (negative-controlled; it caught a reversed interpolation in this codebase) |
| 11 | CV = walk-forward grouped **by date**, purged by the label horizon, with inner time-split early stopping | DL "walk-forward" sliced by row: 100% test-date overlap, AUC 0.65 of pure leakage; `cv=int` shuffles time | `test_walk_forward_folds_purge_label_overlap` (negative-controlled) |
| 12 | One harness: per-date IC, effective dates = dates/h, Newey–West t, both-tail AUC, top-k vs **mean** and median | pooled numbers flipped conclusions 3×; overlap counted as independence (24 "USABLE" readings → 1 survived); low-vol was a median-beater | `test_metrics.py` |
| 13 | Cost-aware, turnover-aware, disjoint-period backtest is the arbiter; benchmark `mom_12_1` on the **same** rebalance calendar | positive IC, negative money; flat per-rebalance costs reorder factors by turnover | `evaluation.backtest`; a calendar-alignment bug (zero shared periods) was caught in development |
| 14 | The promotion gate uses OOF cost-aware evidence and never compares CV across labels. It also runs leak checks: implausible IC, and scores that track the same-day return | CV-margin gates that froze when the label changed, defended overfits, and ran inside seed noise | `test_gate_*`; e2e **planted-signal passes / pure-noise fails** |
| 15 | Seed bagging (3 seeds per LightGBM member) | champion/challenger gap narrower than run-to-run seed noise | `members.py` |
| 16 | Append-only prediction ledger with feature snapshots; grading only from realised returns | accuracy quoted from job success or self-reported CV | FK `outcome → prediction`; `test_live_loop_*` |
| 17 | One canonical output table (`recommendation`) with a single writer. It is fully recomputed per (date, horizon), so rows the run did not produce are purged | 3 parallel "final" scores; stale rows surviving a gate change | `pipeline.daily.step_predict_and_publish` |
| 18 | Each DAG step is its own ledgered, idempotent job | tail-of-script steps silently never ran under a timeout; skip paths stamped as success | `run_step`; the re-run in the e2e test skips |
| 19 | Past trading calendar = bhavcopy existence; lookbacks in sessions | `date.today()` write anchors and calendar-day lookbacks (~35 date bugs) | `trading_day`; no `date.today()` in write paths |
| 20 | A single schedule lives in code, with bounded catch-up | cron patterns mirrored into two registries drifted 6×; restart-orphaned runs | `pipeline.scheduler` |
| 21 | Adaptive state and the track record follow the model **lineage** (same configuration), so a scheduled refresh keeps what was learned | (design gap found while testing this system) | `lineage_ids`; e2e API assertion |

## Learning from mistakes: the loops

| Loop | Cadence | Mechanism | What "a mistake" means |
|---|---|---|---|
| Grade | daily | `learning.resolver` joins each ledger prediction to realised open→open returns, then writes `outcome` and a per-date `realized_eval` for the ensemble and each member | the realised rank of each name vs its predicted rank |
| Reweight | daily | Hedge on each member's realised IC. The step is divided by the horizon because overlapping windows are not independent, and the weights shrink toward uniform | a member that keeps ranking wrongly loses weight |
| Re-interval | daily | adaptive conformal inference (Gibbs & Candès 2021) on realised coverage | intervals that miss (or over-cover) the realised excess |
| Recalibrate | daily, once there are ≥20 graded dates | the rank→expected-excess and rank→P(outperform) isotonic maps are refit on **realised** outcomes | the training-time OOF calibration disagrees with reality |
| Diagnose | daily | a depth-3 tree on the prediction-time feature snapshot vs the signed rank error; its leaves are stored in `system_status` | segments the model systematically ranks too high or too low |
| Retrain | every ~21 sessions, or on a degraded edge, or on a feature-coverage drop | walk-forward retrain on all labels now realised (including the recent errors), with recency-weighted samples (half-life `recency_halflife_days`, regressor and ridge members), then the gate | stale model, broken input, or a live edge that went negative |
| Demote | daily | a significantly negative realised IC (Newey–West t ≤ −2 on ≥10 effective dates) marks the output `degraded` | reality disagrees with the backtest |

All state rows for date D use only outcomes whose exit date is ≤ D. The loops never see the
future, so a replay of the live loop is itself a valid backtest.

## Models

- **Target**: per-date rank→Gaussian of the winsorised open→open forward return. It is
  scale-free across regimes and matches the decision being made (which names to hold).
- **Members**:
  - LightGBM regressor (3-seed bag, early-stopped on an inner purged time split, then refit on
    the full window at the chosen size)
  - LightGBM LambdaRank on per-date quintile grades
  - Ridge on rank-Gaussian features, as a linear anchor
- **Ensemble**: per-date rank→Gaussian of each member, weighted by the Hedge weights.
- **Outputs per name**: score, rank percentile, calibrated expected excess vs the equal-weight
  universe, P(outperform), and a conformal interval.

Why not deep sequence models? The legacy BiLSTM's only strong number was leakage. Its honest
walk-forward result was 0.52 AUC, the same ceiling every engine hit, and it cost 38–52 GB of
memory. Tree ensembles on well-built cross-sectional features are the right place to spend
the complexity budget. A new member can be added by implementing `fit/predict` in
`modeling/members.py`, and it only reaches production through the same gate.

## Features (fs1)

- **Price and volatility**: 5/21/63/126-day returns, 12-1 and 6-1 momentum, 21/63 vol and their
  ratio, downside vol, max 21-day return, ATR%, distance to the 52-week high/low and to
  SMA50/200, RSI, Bollinger %B, gap mean, close location, VWAP distance.
- **Liquidity**: log ADT, turnover ratio, Amihud.
- **Delivery %** (level, 5-day mean, 60-day z-score): the exchange's own flow proxy, with full
  history.
- **F&O**: annualised basis, 5-day OI change, F&O-listed flag.
- **Events**: days to the announced results date, insider net buying over 63 days relative to
  ADT.
- **Fundamentals** (point in time, forward-collected): ROE, D/E, earnings yield, book yield,
  Piotroski score, revenue growth.
- **Market context** (same for every name, so trees can condition on it): 21-day market return
  and volatility, breadth above SMA50, cross-sectional dispersion, INDIA VIX level and change,
  NIFTY 500 63-day return, FII/DII 5- and 21-day net flows.

## Options analytics (`options.py`)

Vendor IV feeds only have forward history. The NSE F&O bhavcopy, which `nse_fo_bhavcopy`
already downloads for futures, also lists every stock option's close, OI and volume, so IV is
computed from it per (stock, date, expiry) into `alpha.option_daily`:

- **Black-76 on the same-expiry future's settle.** The future is the market's forward, so no
  dividend or borrow assumption is needed.
- **Only options that traded that day, on the out-of-the-money side.** An untraded strike's
  close is stale, and an ITM close is mostly intrinsic value. ATM IV is interpolated in strike
  to the forward.
- **Features** (`opt_*`) use the first expiry at least 7 days out, because expiry-week IV is
  pin and gamma noise: ATM IV, IV minus 21-day realised vol, term slope, 5-day IV change, skew,
  and log put/call OI and volume ratios. Like every feature, they earn weight only through the
  gate.

Tests price chains from a known smile, with poisoned ITM closes and a stale untraded strike.
Each filter (volume, OTM, the expiry roll, the futures forward) is negative-controlled.

## Ownership (`ingest/sources/ownership.py`)

The legacy platform already collects each stock's quarterly shareholding pattern: promoter,
FII, MF, insurance and other DII holding %, plus promoter pledge %. `bqa import-shareholding`
imports it into `alpha.fundamental` (source `legacy_shareholding`).

- **Dating.** The legacy table has no filing date. SEBI requires the pattern within 21 days of
  quarter end, so a quarter is dated to EOD of that deadline, or to its fetch date if that was
  earlier.
- **Known risk.** A company that files late is dated before its data was public. This is
  stated in the module, not hidden.
- **Re-imports.** The first import of a (stock, field, quarter) wins, so later fetches never
  restamp history.
- **Features.** Each category's level, plus its change from the immediately preceding quarter
  (a gap of 80–100 days; a skipped quarter gives no change). Values go stale after 130 sessions.

## Earnings reactions (`earnings_features`)

The engine stores no quarterly reported EPS, so a standardised surprise (SUE) can't be
computed. The price-based measure can: the **earnings-announcement return** (EAR), which
research links to the drift that follows a results surprise.

- **Reaction window.** Day 0 is the first session on or after the results date from NSE
  board-meeting intimations. Day +1 follows it. The window covers results released during
  the session and after it.
- **EAR.** The stock's return over days 0 and +1, minus the cross-sectional median return.
- **Volume shock.** Log of the day 0/+1 volume over the volume in sessions −25 to −6.
- **When usable.** Both values become usable at the close of day +1, never on day 0, and are
  carried for 63 sessions. `earn_age` counts sessions since the reaction.
- **Rescheduled meetings.** If two intimations for one stock fall within 30 days of each
  other, the later-announced one is taken as the meeting that happened.

**Prior evidence.** The legacy harness measured post-earnings drift as underpowered (3 periods,
t = −1.79), and its `pead_score` showed no edge over 37 dates. These features are therefore
candidates, not assumptions, and they earn weight only if the gate finds evidence on this
engine's larger point-in-time panel.

## Participant positioning (`nse_participant_oi`)

NSE's dated daily file `content/nsccl/fao_participant_oi_DDMMYYYY.csv` gives long and short
open interest for each participant type: FII, DII, proprietary traders (Pro) and retail
clients. It's split by index/stock futures and calls/puts, and stored in `alpha.participant_oi`.

- **Timing.** The file is published in the evening, so rows are stamped knowable at 20:00 IST,
  after the 19:00 same-day cutoff. A session's positioning is first used at the next session.
- **Parsing.** The header row is found by name after the title line, and columns are matched on
  normalised names. A file missing a column is rejected rather than half-parsed.
- **Market-context features:**
  - net index-futures positioning, `(long − short) / (long + short)`, for FIIs, Pro and Clients;
  - the FII figure's 5-day change;
  - FII index-option bias: net calls minus net puts, over gross.

## Reported results (`nse_results`)

A per-stock sweep of NSE's `api/results-comparision` (NIFTY 500 names, in the vendor stage)
stores reported quarterly EPS, total income and net profit in `alpha.fundamental` under source
`nse_results`.

- **Strict parsing.** No field name could be verified from the build container (AF-20260928-10),
  so a payload without `resCmpData`, or a row missing its period end, income, profit or a known
  EPS key, fails the run instead of writing something half-understood.
- **Dating.** A quarter is knowable at this engine's own board-meeting results date for that
  quarter, stamped 23:00 IST because results often come out after hours, so they're used the next
  session. If there's no such event, it's the SEBI deadline (45 days after quarter end, 60 for
  March) or the fetch time if earlier.
- **Re-imports.** The first import of a quarter wins, so later fetches never restamp history.
- **Features:**
  - `res_eps_yoy_px`: EPS minus the same quarter a year earlier, over price. This is the
    seasonal-random-walk surprise.
  - `res_revenue_yoy`: year-on-year revenue growth.

  A neighbouring quarter is never used as the base.

## Global overnight cues (`fred_macro`)

FRED's keyless `fredgraph.csv` supplies seven daily series, stored in `alpha.macro_series`: the
S&P 500, the Nasdaq Composite, VIX, the US 10-year yield, the broad dollar index, Brent, and
USD/INR.

- **Timing.** An observation dated D is the US close of D (16:00 New York), so it's knowable at
  01:30–02:30 IST on D+1. An NSE session therefore uses the previous US session, and a Friday
  US move reaches Monday's session.
- **How features are built.** Returns and changes are computed on each series' own calendar
  first, then placed on NSE sessions.
- **Market-context features:**
  - `us_spx_ret_1` / `_5` and `us_ndx_ret_1` / `_5`: US equity returns over 1 and 5 sessions;
  - `us_vix` and `us_vix_chg_5`: US volatility level and its 5-day change;
  - `us_10y_chg_5`: the 10-year yield's 5-day change;
  - `usd_broad_ret_5`, `brent_ret_5`, `usdinr_ret_5`: 5-day moves in the dollar, oil and the rupee.

## F&O ban list (`nse_fo_secban`)

NSE publishes a dated daily file, `content/fo/fo_secban_DDMMYYYY.csv`, listing stocks whose
open interest exceeds 95% of the market-wide position limit. For those stocks only
position-reducing trades are allowed.

- **Parsing.** The trade date comes from the file's own header ("Securities in Ban For Trade
  Date …"), not the URL. A file without that header is rejected.
- **Storage.** Every processed day gets an `alpha.fo_ban_day` row, so a day with no bans is data
  rather than an empty run, and a day never processed stays unknown. A re-published list
  replaces that day's names in `alpha.fo_ban`.
- **Timing.** A ban for trade date T is stamped knowable at 09:00 IST on T.
- **Features:**
  - `fo_ban`: the stock is in the ban period;
  - `fo_ban_days`: consecutive sessions in ban;
  - `fo_ban_exit`: the first session after the ban ends.

  These are NaN on days no file was processed.

## Next-session engine (`session/`)

This is a second decision clock. The decision is made at day d's close, and optionally refined
by day d+1's 09:08 pre-open auction. The trade is d+1's open to d+1's close. It lives beside
the multi-day engine and shares its ensemble, CV and gate, and it has its own ledger
(`session_pick` → `session_outcome`).

| Piece | What it does |
|---|---|
| `day_flags` + `capitulation` | The legacy's only validated edge, re-implemented on this system's data. On day d: gap down ≥ 2%, open within 0.1% of the day's low with a range of at least 0.5%, and in the bottom 5% of the day within the tradeable universe (≥ ₹5 cr ADT, price ≥ ₹20). |
| `day_level` | One row per session: basket open→close, minus a 0.135% round-trip intraday cost (assumption, see `costs.py`), minus that session's equal-weight universe. Returns are winsorised per session (inward cutoffs); t-stats are across sessions, never pooled rows. Capacity (2% of ADT) is reported beside every return. |
| `session.model` | The same LightGBM + LambdaRank + ridge ensemble. Inputs are day-d state (gap, open/close location, range, turnover shock, delivery, trend), the flags as 0/1, and the pre-open auction's gap and imbalance for d+1 when a capture exists before 09:15. |
| Gate | The model's top-10 book must beat the rule **as a book** on every out-of-fold session: the rule's net spread when it fires, cash when it doesn't. A diluted model that only matches the rule on its days fails. |
| `nse_preopen` | Captured once per session between 09:08 and 09:14 by the scheduler, with browser TLS impersonation. The first capture of the morning is kept, and anything seen after 09:15 is never used as a pre-open input. |
| `measure_rule` | Re-measures the rule on a trailing window every 21 sessions. Rule picks are published as `validated` only while this system's own measurement says so (t ≥ 2 over ≥ 20 signal-days). |

Checked on the synthetic market, where a capitulation effect is planted or absent:

- flags recover more than 80% of the planted events;
- the day-level rule is significant when the effect exists and not when it doesn't;
- the model learns the capitulation features;
- a published pick is graded exactly against the raw bar.

A test also caught a fat-finger print dominating a day's universe mean before winsorising was
added.

## Portfolio construction (`portfolio/`)

This turns the canonical ranking into sized positions. It is off until
`BQA_PORTFOLIO_CAPITAL_INR` is set, and then it runs in the daily job graph after publishing.
Output goes to `portfolio_run` (the audit trail) and `portfolio_target`, and is served at
`/portfolio`.

| Piece | What it does |
|---|---|
| Objective | Maximise the calibrated expected excess (the ledger's `pred_excess`), minus a risk penalty, minus the actual cost of every trade. Solved with SLSQP over the top 3×k names plus current holdings. |
| Risk model | Ledoit–Wolf shrunk covariance of 126 sessions of daily returns, scaled to the horizon. Names with less than 60 days of history get the median variance rather than being dropped. Beta is measured against the equal-weight universe. |
| Limits | A per-stock weight cap; a sector cap, where NIFTY 500 industry labels come from `nse_constituents` and an unknown sector is its own capped bucket; a liquidity cap of 2% of ADT relative to capital; gross exposure ≤ 1. Then the book is scaled down to the volatility target, with the rest held as cash. |
| Turnover | The cost term is the real per-side cost from `costs.py`, so a change of view smaller than the round trip does not trade. Tested: a 0.2% view change gives 0.15% turnover with real costs and 7.2% with zero costs. |
| Honesty | Every run records which constraints bound and the ex-ante volatility, beta, turnover and estimated cost. `edge_status` passes through from the recommendations, so an unvalidated ranking yields a book marked unvalidated. |

On the synthetic market (planted edge, heterogeneous volatility, same scores and rebalance
dates):

| | Equal-weight top-15 | Optimised |
|---|---|---|
| Annual volatility | 20.5% | 12.5% |
| Sharpe | 3.29 | 3.91 |
| t of excess return | 6.4 | 8.4 |
| Turnover per rebalance | 31% | 7.8% |

Absolute levels reflect the planted edge; only the comparison is evidence.

## Legacy data bridge (`legacy/`)

The legacy platform collects far more than this engine ingests first-hand (fundamentals
history, F&O rollover, MF holdings, ~20 indicator columns in `technical_signals`, and more).
It also already has the semantic map needed to reuse it: `src/server/ontology/` binds 729
(table, column) pairs to properties that say whether a column is a feature, a label, a
probability, a vendor opinion or a leak, and gives each of its 65 tables a card (grain,
freshness column, publication lag, training verdict). The legacy models don't use any of it:
`ml_ensemble.py` hand-lists its columns.

The bridge makes that ontology the source of truth, in three steps.

| Step | What it does |
|---|---|
| `bqa legacy-map generate` | Writes `config/legacy_feature_map.yaml` from the ontology. It takes only columns the ontology calls trainable (never a label, a probability, text, or a high/target leak), and only from tables whose verdict is `allowed` or `caution`. Each entry says how it becomes point in time: the capture timestamp if the table has one, the row's own timestamp for event tables, or close + the card's publication lag. Tables that aren't one row per (symbol, date) are marked `needs_spec` rather than flattened silently. Legacy model outputs and tables this engine already sources first-hand are listed but disabled. The current map has 197 entries, 38 of them enabled: `technical_signals` 22, `fundamentals_history` 8, `fno_rollover` 7, `stock_mf_holdings` 1. |
| `bqa legacy-map import <dsn>` | Copies enabled columns into `alpha.external_fact` point in time and change-only, resolving symbols through `symbol_history`. Tables with no capture time are **forward-only** by default: legacy fetchers UPDATE past dates in place, so their history can't prove what was known when. `--allow-history` overrides this, and every fact imported that way is optimistic. |
| `bqa legacy-map screen <start>` | Grades each imported field with the standard harness: rank IC against forward returns, overlap-corrected, using only labels realised by the cutoff. The cutoff defaults to the start of the first walk-forward test fold, so feature selection never sees the evaluation period. A field is admitted only with coverage of at least 30%, enough effective dates, and a Newey–West |t| at or above the promotion bar. Verdicts go to `alpha.external_screen`. |

`build_features` adds only admitted fields, as `x_<table>__<column>`. A field with no evidence
never reaches a model, whatever the ontology calls it.

## What was deliberately left out


- **Screener-membership features** (1,331 of the URLs in `urls.txt`). The legacy platform
  measured all 1,563 screeners: none survive FDR, and concept tags lift winners and losers
  equally. They detect volatility, not direction.
- **Vendor composite scores** (MarketsMojo, MoneyControl insights, Tickertape scorecards): no
  edge was measured.
- **A frontend.** The API is the product surface. The legacy React app can read it, and a
  dashboard should be built only once a validated edge exists to display.
