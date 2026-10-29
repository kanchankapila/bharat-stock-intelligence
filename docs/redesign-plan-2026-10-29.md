# Quant redesign plan (2026-10-29)

A phased plan to turn this platform from a many-engine Buy/Sell ranking into a measured,
cost-aware portfolio process. It is a design, not a work queue: every action lives as a row in
`docs/audit-findings.md`, linked below by id. The umbrella row is AF-20261008-27.

Facts are cited to `.claude/rules/measurement.md` (dated there). Statements marked
**[judgement]** are design choices, not measurements.

## 1. Why change the design

What the platform's own measurements say, as of 2026-10-27:

- **The published ranking has no demonstrated forward edge after costs.** Rank IC is real but
  small (`unified_score` about +0.017 to +0.05 depending on horizon and entry) and hit-AUC stalls
  near 0.51, below the 0.55 bar. The frozen forward test has no closed window yet.
- **No label clears costs as a one-session trade.** Only "Buy" at a 5-session hold clears its
  estimated cost (+39.6 bps net), and mostly in less-liquid names; at Rs 10 cr+ turnover it falls
  below cost. "Strong Buy" earns nothing over "Buy".
- **Short-horizon signals do not survive Indian costs.** Futures carry is real (IC +0.022, t 5.7,
  every year 2021-24) and untradeable at retail cost; the capitulation triple was a 2021 small-cap
  effect; every trading-desk source graded on 2026-10-26 lost as a mechanical trade.
- **Slow factors are the only candidates.** Monthly `momentum_12_1` (+0.96%/period vs NIFTY500,
  t 1.29) and `value_book_to_price` (+1.19%/period vs NIFTY500, t 1.77) are positive after costs
  and unproven. The frozen `paper_book.py` forward gate decides; its earliest verdict is
  about 2027-01-22.
- **Most of the system does not reach the number.** 89 fetchers, about 284 tables and 39 GB feed
  eight engines plus overlays, vetoes and labels, while the published score has about 60% of the
  rank IC of the plain blend of its own engines (AF-20261008-16), and the feature matrix carries
  about 16 independent signals out of 196 columns.

The repeated defect classes (aliases ranked as stocks, look-ahead joins, labels that are not what
they say, monitors that cannot fire) come from that size and from having no single point-in-time
layer, not from carelessness.

## 2. Target design

```
security master (point in time)  ->  universe(as_of)
        |                                   |
   factor library  ---- one research harness (purged, cost-aware, forward-gated)
        |
   alpha (few slow factors)  ->  risk model (sector, beta, size)  ->  optimizer (turnover + cost)
        |
   target weights  ->  paper book (frozen protocol)  ->  live book
        |
   UI: weights, expected return with its uncertainty, as-of time, track record
```

**[judgement]** The product becomes a monthly-rebalanced, long-only (optionally F&O-hedged)
factor portfolio. Daily Buy/Sell labels, conviction tiers and calibrated "win probabilities" are
retired from user-facing pages unless they pass the forward gate.

Kept as they are, because they work: the measurement discipline, the frozen forward gates
(`forward_test_report.py`, `paper_book.py`), the findings ledger, and the rule that one canonical
output exists (today `unified_recommendations`; after Phase 3, the target-weight table).

## 3. Phases

Each phase has an exit test. A phase does not start its user-visible changes until the previous
phase's exit test holds.

### Phase 0 — Stabilise operations (now to about 2026-11-15)

Make the platform's state trustworthy before redesigning it.

- One live checkout, integrated with `origin/main`: AF-20261028-03.
- Pending migrations, log rotation and statistics: AF-20261028-16, AF-20261028-20, AF-20261028-22.
- Dependency advisories: AF-20261025-33, AF-20261028-04.
- Host availability and recovery: AF-20260917-14, AF-20260928-03, AF-20261017-11.

**Exit test:** a week with no downtime gap over 90 minutes in `job_run_history`, the live tree equal
to a commit on `main`, an off-host backup restored once, and zero open FIX rows in this group.

**[judgement]** The single largest lever here is moving Postgres, Redis and the job runner to an
always-on Linux host with off-host backups. It removes the downtime, memory-contention and
backup-locality rows at once.

### Phase 1 — Point-in-time security master and `universe(as_of)`

One table answers "which listings existed, under which symbol, and what was knowable on date D".
Every reader takes its universe from one function instead of its own `nse_stocks` query.

- Alias and duplicate-entity defects this removes by construction: AF-20261029-01,
  AF-20261028-18, AF-20261021-14, and the AF-20261015-12 class.
- Corporate actions with no clean ratio and price seams: the AF-20261015-07 class.
- Facts carry a knowable-at timestamp, so look-ahead joins and late-fitted backfills (for example
  the regime history in AF-20261008-21) cannot enter a backtest.

**Exit test:** no Python or TypeScript reader queries `nse_stocks` for a universe directly (a
source-derived test enforces it), and replaying any past date returns only listings that existed
on it.

### Phase 2 — One research harness as the only path to production

`factor_edge.py` and `factor_backtest.py` already contain most of this. The change is making them
the only route by which a score, weight or label reaches users.

- Grading dated by generation time, at every horizon: AF-20261026-46.
- Calibration per horizon, judged forward: AF-20261008-17, AF-20261001-48 (shadow running since
  2026-10-29).
- Feature integrity: AF-20261021-03 (warm-up zeros), AF-20261024-02 (retrain gate).
- Degenerate inputs graded in shadow before any weight moves: AF-20261025-01.

**Exit test:** every number shown to a user names the harness run that produced it, and the CI
gate that already requires backtest evidence for scoring diffs (`verify-gate.mjs`) covers label
and threshold changes too.

### Phase 3 — Portfolio construction replaces the blend

Alpha from the few factors that survive Phase 2, a simple risk model, and an optimizer with
explicit turnover and cost penalties produce target weights. The forward gate, not a backtest,
decides each step.

- Decision point: the `paper_book.py` forward verdict, earliest about 2027-01-22
  (AF-20261026-73).
- Retires, once the replacement is live: conviction tiers, the cockpit desk score and its sizing
  rules (AF-20261028-06, AF-20261028-07, AF-20261028-08), and the intraday ranker unless its
  shadow arm passes.

**Exit test:** the target-weight book beats its frozen null (200 random books with identical
mechanics) over at least 60 forward sessions with both halves positive, as the `paper_book.py`
protocol defines. If it does not, see section 4.

### Phase 4 — Cut the data surface

Keep the sources that feed a factor that passed Phase 2 (prices, delivery, futures basis,
point-in-time fundamentals, results filings) and archive the rest.

- Usage audit of never-read tables: AF-20261023-01. Vendor onboarding stays frozen until a named
  hypothesis exists (`data-sources.md`).

**Exit test:** every remaining fetcher feeds a graded factor or a monitored operational need, and
the count of tables and fetchers is re-derived by `scripts/docNumbers.mjs`, not quoted here.

### Phase 5 — Orchestration and monitoring

**[judgement]** Run the data and research pipeline as one Python dependency graph (asset-based,
Dagster or Prefect style), keep TypeScript for the API and UI only, and monitor freshness from the
graph's own asset state.

- This replaces cron offsets used as dependencies and the hand-written `MAX()` freshness probes
  that were the largest database load (AF-20261028-16).

**Exit test:** no job depends on another by clock time, and a missed upstream asset blocks its
dependants visibly instead of letting them run on stale inputs.

## 4. Pre-registered decision rules

Written now so later results cannot move the goalposts.

- If the `paper_book.py` forward verdict fails at its first eligible date, the product is
  repositioned as research and monitoring only (no published Buy/Sell or weights) until a new
  frozen protocol passes.
- If momentum and value fail forward but the portfolio process passes on another factor set, keep
  the process and replace the factors; do not reopen short-horizon signals, which are already
  measured below cost.
- A factor enters the alpha only after the Phase 2 harness grades it cost-aware with at least
  20 independent periods; a CV or AUC number a model reports about itself is never evidence.

## 5. What not to do

- Do not add a fifth signal table, a second canonical score, or another UI surface.
- Do not reweight the current blend to chase a better-looking backtest on the same 41-date panel.
- Do not build Phase 3 before Phase 1: a portfolio on an aliased universe repeats the
  duplicate-entity bugs with real money.
- Do not onboard a new vendor without the named hypothesis the onboarding freeze requires.

## 6. Risks

- The forward gate needs calendar time; the earliest verdict is about 2027-01. Phases 0-2 are
  useful regardless of that verdict.
- The host move in Phase 0 is the only step with downtime risk; plan it outside market hours with
  a restore rehearsal first.
- Retiring labels users rely on (Phase 3) is a product change; it needs the owner's decision at the
  time, with the forward record in hand.
