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

## What was deliberately left out


- **Screener-membership features** (1,331 of the URLs in `urls.txt`). The legacy platform
  measured all 1,563 screeners: none survive FDR, and concept tags lift winners and losers
  equally. They detect volatility, not direction.
- **Vendor composite scores** (MarketsMojo, MoneyControl insights, Tickertape scorecards): no
  edge was measured.
- **A frontend.** The API is the product surface. The legacy React app can read it, and a
  dashboard should be built only once a validated edge exists to display.
