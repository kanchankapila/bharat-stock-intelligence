# Regime-Conditional Win-Probability Calibration (Option A)

_Design spec — 2026-06-21, branch `prod-readiness-phase1`. Quant/DS work on the ML feedback loop._

## Problem

Win rate on resolved signals varies enormously by market regime (live PG, WIN/LOSS only, joined
`signal_outcomes ⋈ technical_signals.nifty_regime`):

| regime | training samples | win rate |
|---|---|---|
| BEAR | 5,731 | 0.331 |
| SIDEWAYS | 2,079 | 0.610 |
| BULL | 1,523 | 0.583 |
| (null/unknown) | 1,000 | 0.497 |

Regime is the single biggest determinant of whether a signal wins. The shared ensemble averages
across these very different base rates, and its `win_probability` is calibrated **globally** — so
the same raw score maps to one win-probability regardless of regime. That dilutes sizing and the
0.40 gate, which both treat `win_probability` as a true probability.

A prior ablation (2026-06-21) showed that adding market-level VIX/breadth as **features** does not
help a per-stock cross-sectional classifier (it overfits the time axis). The right place for market
context is **conditioning**, not features. The lowest-risk, most data-efficient form of conditioning
that directly targets the measured effect (a base-rate shift) is **per-regime calibration**.

## Data-sufficiency finding (critical — drives the gating rule)

The row counts above are misleading. Each regime is, today, **one short contiguous episode** with
very few independent observations:

| regime | rows | **distinct trading days** | span |
|---|---|---|---|
| BEAR | 5,731 | **11** | 2026-05-26 → 06-14 |
| SIDEWAYS | 2,079 | **5** | 2026-05-22 → 05-26 |
| BULL | 1,523 | **4** | 2026-05-18 → 05-21 |
| (null) | 1,000 | 2 | 2026-05-16 → 05-17 |

`technical_signals` is a rolling ~5-week table, so we have lived through exactly **one** BULL→
SIDEWAYS→BEAR cycle. The thousands of rows per regime are pure cross-sectional fan-out (hundreds of
symbols on the same day, sharing the regime **and** highly correlated outcomes — market beta
dominates any single day), so the **effective independent sample size per regime is ~4–11, not
thousands** (the López-de-Prado concurrency problem, severe here). Fitting per-regime calibrators on
this would encode single-episode flukes (e.g. "what mid-May did") into sizing/gating and could make
them worse. We cannot yet separate a genuine regime effect from one month's path.

**Consequence:** we build the per-regime mechanism now, but gate each regime calibrator on a
**distinct-trading-days + episode-count floor**, not row count. With today's data every regime fails
the floor, so calibration falls back to the existing **global** behaviour everywhere — a safe no-op.
Each regime auto-activates only once it has accumulated enough *independent* history. A "regime data
readiness" report and the per-regime AUC diagnostic ship now so we can see exactly when each regime
becomes trustworthy.

## Decision (as quant, user-approved)

Build **Option A — per-regime isotonic calibration (dormant behind a days/episode floor) + regime-fair
gating + per-regime AUC & data-readiness diagnostics.** Do NOT build separate per-regime ensembles
(B) or a per-regime meta-learner (C) yet:

- The purged walk-forward embargo is ~1,351 samples; BULL (1,523) and SIDEWAYS (2,079) cannot
  support a per-regime meta-learner or ensemble after that embargo.
- Regime days interleave in time, so per-regime temporal CV is leakage-prone and awkward.
- The 0.33↔0.61 spread is consistent with a pure base-rate shift, which calibration fixes optimally
  using all 13.5k samples. We have not yet measured whether feature *relationships* differ by regime.
- The per-regime AUC diagnostic (below) is exactly the evidence that would justify escalating to
  C/B later — escalate only with proof, not on assumption.

## Implementation phases

The 5-week derived-data window is the binding constraint, but we hold **550 trading days (~2.2y)** of
`stock_ohlcv` + India VIX + global macro. The work is sequenced so the clean, high-value backfill
lands first and the leaky part is isolated and optional.

**Phase 1 — Historical regime + breadth + macro + FII/DII backfill (first; clean, leak-free).**
Run the *market-level* engines over the full 550-day OHLCV window:
- `global_macro_fetcher.py` (days≈800) → `macro_asset_prices` full history (US10Y/DXY/SP500/NSEBANK/
  INDIAVIX) — mostly already present.
- `market_breadth.py` (full backfill) → `market_breadth` over 550 days.
- **FII/DII history backfill (NEW source):** the TradeBrains portal serves daily FII/DII flow back to
  late-2023 — `…/fii-investments/` (596 records to 2023-12-21; field `equity_net_investment` → our
  `fii_net`, plus debt/gross/cumulative available) and `…/dii-investments/` (654 records to
  2023-11-01; field `net_value` → our `dii_net`). Both paginate (`per_page=100`, follow `next` until
  null) and use `DD-MM-YYYY` dates → parse to `YYYY-MM-DD`. A backfill routine pages both, maps the
  fields, and upserts `fii_dii_flow` over the whole window. It is published EOD data → point-in-time
  correct. This **removes FII flow from the neutral-feature caveat** for the historical regime labels.
- **Advance/decline repoint:** `regime_detector` currently reads its advance/decline feature from
  `market_sentiment_snapshots.overall_score` (a thin sentiment proxy, history only since ~Jun-2026).
  Repoint it to `market_breadth.adv_decline_ratio` — literal breadth computed from our own
  `stock_ohlcv`, fully backfilled in this same phase. (HMM standardizes features, so the 0–1 vs
  0–100 scale change is a non-issue.) This removes the **last** neutral-feature caveat.
- `regime_detector.py` over history → `market_regimes(date, regime)` for every trading day, using
  `as_of_date` for point-in-time labels (now with real FII **and** breadth over history).
- **No neutral features:** all 8 regime inputs (NIFTY return/vol, VIX, FII, advance/decline, US10Y,
  DXY, SP500) are backfilled over the full 550-day window. Validate that labels track known 2024–2026
  moves and report distinct-days/episodes per regime.
- Phase 1 improves **regime detection** and gives a **multi-episode regime history**, but does NOT by
  itself enlarge the *calibration* training set (that needs historical signals+outcomes → Phase 2).

**Phase 2 — Signal/outcome replay (second; CAVEATED, optional gate).**
Replay the derived signal pipeline over history to populate the calibration training data:
- Replay `feature_engineering` + technical scanners over `stock_ohlcv` → historical
  `technical_signals` (OHLCV-derived features only; IV/delivery/PCR/point-in-time-fundamentals/FII
  enter neutral — vendor/forward-only, not backfillable).
- Bar-replay `outcome_resolver` over `stock_ohlcv` → historical `signal_outcomes` (clean).
- Score historical signals with the current model → historical `win_probability`.
- **Caveats:** (a) the historical feature set is partial → `win_probability` distribution differs from
  live; (b) scoring old signals with a model trained on all data is mild look-ahead for calibration.
  Treat any per-regime calibration it activates as **provisional**, validated against live behaviour.
- This is the stage that supplies historical `(regime, win_probability, outcome)` tuples and lets the
  per-regime calibrators clear the days/episode floor.

**Phase 3 — The calibration mechanism (below).** Ships independent of the backfills: per-regime
calibration gated on the days/episode floor (global fallback until met), diagnostics, and the gate
switch. It is dormant today and auto-activates per regime once Phase 2 data clears the floor.

## Components & data flow

### 1. `ml_calibration.py` — per-regime calibration (modified)

`recalibrate_win_probabilities(conn, min_samples=200, min_regime_days=20, min_regime_episodes=2)`:

- Training query gains `ts.nifty_regime` **and `ts.date`** (date needed for the days/episode floor):
  ```sql
  SELECT ts.nifty_regime AS regime, ts.date AS d,
         ts.win_probability AS p,
         CASE WHEN so.outcome = 'WIN' THEN 1 ELSE 0 END AS y
  FROM signal_outcomes so
  JOIN technical_signals ts ON ts.symbol = so.symbol AND ts.date = so.signal_date
  WHERE so.outcome IN ('WIN','LOSS') AND ts.win_probability IS NOT NULL
  ```
- Fit **one global** `IsotonicRegression` on all rows (existing behaviour, the fallback).
- A regime qualifies for **its own** calibrator only if it clears the **independent-observation
  floor**: `distinct_days(regime) ≥ min_regime_days` **AND** `episode_count(regime) ≥
  min_regime_episodes` **AND** `≥ 2` outcome classes. An **episode** = a maximal run of the regime's
  distinct trading days with no internal gap `> EPISODE_GAP_DAYS` (default 5 calendar days); the
  episode floor ensures we never fit a calibrator to a single continuous block. Regimes failing any
  condition have **no** regime calibrator (→ global).
- Build the write set from
  `SELECT symbol, date, nifty_regime, win_probability FROM technical_signals WHERE win_probability IS NOT NULL`.
  For each row pick `regime_calibrators.get(regime, global_calibrator)` (null/thin/unknown/dormant
  regime → global) and write `calibrated_win_probability`. Idempotent (overwrites every run).
- Return `{fit, n, updated, regimes: {regime: {n, distinct_days, episodes, used: 'regime'|'global'}}}`
  and print a one-line-per-regime summary including why each regime used global vs its own calibrator.

Helpers `fit_calibrator(pred_probs, outcomes)` and `calibrate(ir, p)` are reused unchanged. A small
pure helper `count_episodes(days, gap=EPISODE_GAP_DAYS)` (sorted distinct dates → episode count) is
added and unit-tested.

**Today's behaviour:** BEAR(11d)/SIDEWAYS(5d)/BULL(4d) all fail `min_regime_days=20`, so every row
uses the global calibrator — identical to current production. The mechanism activates per regime only
as real history accumulates.

### 2. `ml_calibration.py` — `per_regime_auc(conn)` (new)

- Reads the same `regime, p (raw win_probability), y (WIN=1/LOSS=0)` rows.
- For each regime with `≥ 2` outcome classes and `≥ 50` rows, computes
  `sklearn.metrics.roc_auc_score(y, p)` on the **raw** `win_probability` (we want the shared model's
  *ranking* quality within the regime, independent of calibration). Reported for **all** such regimes
  — including ones still below the calibration floor — so we can watch ranking quality accrue.
- Returns `{regime: {n, auc}}`, prints one line per regime.
- Called at the end of `run()` after recalibration; result is logged (no new table in v1).
- **Interpretation (documented in the function docstring):** regime AUC well above 0.5 → the shared
  model ranks fine there, calibration is sufficient. Regime AUC ≈ 0.5 → the shared model cannot
  rank there; that regime is the candidate for a future per-regime model (escalation to C/B).
- **Caveat (logged alongside the AUC):** until a regime clears the days/episode floor its AUC is
  computed on a single autocorrelated episode and is itself provisional — read it together with the
  readiness report, not in isolation.

### 2b. `ml_calibration.py` — `regime_readiness(conn)` (new)

- For each regime: `n_rows`, `distinct_days`, `episode_count`, `first_day`, `last_day`, and a boolean
  `ready` (clears `min_regime_days` + `min_regime_episodes`). Returns a dict, prints one line per
  regime. This is the at-a-glance "when does per-regime calibration turn on" report; it runs every
  calibration cycle so the activation is observable in the cron logs.

### 3. `scoring_engine.py` — regime-fair gate (modified)

The ML win-probability load (around line 490) currently selects raw `win_probability` and gates
`wp < 0.40`. Change the SELECT to
`MAX(COALESCE(calibrated_win_probability, win_probability)) AS wp` so the gate consumes the
per-regime-calibrated probability. The numeric 0.40 threshold is unchanged — once the probability is
honest per regime, a single threshold is already regime-fair (it naturally passes fewer BEAR
signals). `COALESCE` keeps rows that have not been calibrated yet working on the raw value.

### 4. Sizing — no change

`unified_ranker._get_win_probabilities` already reads
`AVG(COALESCE(calibrated_win_probability, win_probability))`, so per-regime calibration flows into
López-de-Prado position sizing automatically.

### 5. Cron — no change

`ml_calibration.py` already runs in `processMlDailyOps` after `scorePending`. Per-regime calibration
is a drop-in upgrade of that step.

## Explicitly out of scope (v1, YAGNI)

- **Per-regime threshold numbers** (a risk overlay that demands, e.g., 0.45 in BEAR beyond what
  calibration says). Calibration already makes a single threshold regime-fair; add per-regime
  thresholds only if a later drawdown/tail-risk analysis justifies extra BEAR conservatism.
- **Separate per-regime ensembles / meta-learner (C/B).** Gated behind the per-regime AUC evidence.
- **Persisting per-regime AUC to a table / model_registry.** Logged only in v1.

## Testing (TDD)

Pure-function and DB-backed tests in `src/server/tests/test_ml_calibration.py` (extend existing):

1. **`count_episodes`** (pure) — `[d, d+1, d+2]` → 1 episode; `[d, d+1, d+20, d+21]` → 2 episodes
   (gap > 5); empty → 0. Locks the episode definition.
2. **Per-regime calibrators differ when both qualify** — two synthetic regimes that each clear the
   days/episode floor (≥20 distinct days across ≥2 episodes) with different score→win maps; assert
   the same raw score calibrates to different values under each regime's calibrator.
3. **Below days-floor → global fallback** — a regime with many rows but few distinct days (the
   current real-world case) uses the global calibrator, not its own.
4. **Single-episode (continuous block) → global fallback** — a regime with ≥20 distinct days but all
   contiguous (1 episode) fails `min_regime_episodes` and uses global.
5. **One-class regime → global fallback** — resolved outcomes all WIN (or all LOSS) → global.
6. **Null/unknown regime → global fallback** — rows with `nifty_regime IS NULL` are calibrated via global.
7. **`per_regime_auc` distinguishes rankable vs random** — synthetic where regime A is rankable
   (AUC > 0.6) and regime B is random (AUC ≈ 0.5); assert the returned dict reflects the difference.
8. **`regime_readiness` flags ready/not-ready** — synthetic regimes on either side of the floor;
   assert `ready` booleans and the reported distinct_days/episode counts.
9. **Gate reads calibrated** — unit/integration check that the scoring gate consumes
   `calibrated_win_probability` (a row whose raw `win_probability` is 0.6 but calibrated is 0.30 is
   gated out at the 0.40 threshold).

All DB-backed tests use an in-memory SQLite fixture mirroring the existing calibration/test pattern.

## Verification

- **Phase 1:** after the backfill, `market_regimes` covers ~550 days; print distinct-days +
  episode-count per regime and confirm multiple regimes now clear the 20-day/2-episode floor.
  Sanity-check labels against known moves (e.g. drawdowns show BEAR/HIGH_VOL); confirm FII/AD were
  neutral pre-mid-2026 but return/vol/VIX produced sensible labels.
- **Phase 2 (when run):** historical `technical_signals`/`signal_outcomes` row counts over the 550-day
  window; confirm the calibration training join now spans many regime days; flag the partial-feature
  caveat in the run log.
- `npx vitest run` + full `pytest src/server/tests/` green.
- Live-PG run of `ml_calibration.py` (USE_POSTGRES=true): readiness report shows BEAR/SIDEWAYS/BULL
  all **not ready** (below the 20-day/2-episode floor), so every regime uses the **global**
  calibrator — `calibrated_win_probability` values must be **identical to the pre-change global run**
  (the safety check: the *per-regime* layer is dormant today). Per-regime AUC + readiness printed.
- **One active change today:** the `scoring_engine` gate switches from raw `win_probability` to
  `COALESCE(calibrated_win_probability, win_probability)`. Since global calibration is real, this
  shifts which signals pass the 0.40 gate (intended improvement — gate on honest probability, the
  same value sizing already uses). Verify: compare the count of gated-in signals before/after and
  spot-check that rows whose calibrated value crosses 0.40 flip as expected.
- The first real **per-regime** activation is verified later, when a regime crosses the floor (or via
  a synthetic-data integration test that forces a regime over the floor and asserts its rows get its
  own calibrator).

## Risks / notes

- `nifty_regime` is produced by `technical_signals` (3-class) — the same column already used as a
  model feature; no dependency on the 5-state HMM `regime_detector` here.
- BEAR has the most data and the lowest win rate, so its calibrator is the most reliable and the one
  that most changes sizing/gating — the highest-value part of this change.
- If a future regime shows AUC ≈ 0.5 in the diagnostic, the escalation is C (per-regime meta-learner)
  for that regime only, designed in a separate spec.
