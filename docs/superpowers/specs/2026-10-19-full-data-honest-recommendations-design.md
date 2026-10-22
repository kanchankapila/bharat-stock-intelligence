# Redesign: full data utilisation, honest daily recommendations across three horizons

Date 2026-10-19. Status: **awaiting approval — nothing in here is built yet.**
Reviewed once by a fresh builder-check pass; the calls that review forced are listed in §12.
Supersedes nothing; **extends** `2026-10-08-accuracy-and-honesty-program-design.md` (still awaiting
review), and unblocks that document's section F, which was deliberately written as NEEDS-APPROVAL
proposals.

Every number below was re-derived from live production on 2026-10-19 by the query named beside it.
Numbers are dated snapshots; re-derive before quoting them later.

---

## 1. Intent

One artifact, every trading morning, before the open, that a trader can act on without second-guessing:
a ranked set of calls across **intraday**, **short-term** and **long-term**, each labelled with the
tradability tier it is valid for, each carrying its measured track record, and each allowed to be empty.

Three decisions taken by the user on 2026-10-19 shape everything below.

1. **Trading reality:** paper today, but the intended universe is *all* of F&O (index and stock
   options/futures), cash equity at ₹1–10L per name, and cash equity under ₹1L. Measurement must
   therefore be **stratified by liquidity tier**, not run once over the whole universe.
2. **Blast radius: aggressive.** Engines, fetchers, models and signal paths with no measured
   contribution get removed, not kept "just in case". Some dashboard panels will go dark.
3. **Empty days are a feature.** When nothing clears the gate, the brief says "no trade today".

### What is actually wrong today, in one paragraph

The platform is not short of data and not short of engineering. It collects more than it uses, computes
more than it weights, and grades itself on a window too short to prove anything. Half the ranker's
engines carry weight zero; 39 populated tables holding ~12.9M rows are written and never read; and the
canonical score has **42 distinct dates** of evidence while the database holds **1,439 dates** of
point-in-time features going back to 2021. The redesign is therefore mostly subtraction plus one large
addition: grade the thing on the history that already exists.

---

## 2. Measured baseline, 2026-10-19

| # | Finding | Evidence |
|---|---|---|
| B1 | **No usable edge reading exists, in either direction.** Every row of the latest `factor_edge_history` run on `unified_recommendations` reads `LOW-DATA`: effective dates 0.2–8.2 against the harness's own `MIN_DATES_RELIABLE = 20`. **(Count corrected 2026-10-21: the original "41 of 41" was wrong — the latest run (2026-10-17) carries 97 rows, every one below the floor. 41 was the number of rows visible in a `tail`-truncated query output, read as the total. The range and the conclusion are unaffected.)** `unified_score` shows rank IC +0.027..+0.090 at h5/h10/h21 and AUC 0.49–0.54 — all unusable. | `factor_edge_history`, latest `run_at` 2026-10-17, 41 rows |
| B2 | **The reason is panel length, not model quality.** `unified_recommendations`: 42 distinct dates, 2026-08-10 → 2026-10-16. `feature_store`: 1,439 dates, 2021-01-01 → 2026-10-19, ~2,000 symbols/day. `stock_ohlcv`: 1,443 dates. `trendlyne_pe_history`: 3,078 dates to 2013. | `count(DISTINCT date)` per table |
| B3 | **Honest graded outcomes are negative.** `unified_signal_outcomes`, 180 days, after the 2026-10-08 short-side re-grade: h1 **40.66% win, −0.257% avg**; h5 **43.60%, −0.045%**; h15 **39.71%, +0.180%**. Gross, before costs. | `GROUP BY horizon_days` |
| B4 | **Intraday has already been measured and has no edge after costs.** `intraday_ranker.py`'s own header: across 256 configurations (8 signal families × 4 decision times × 4 exit rules × 2 basket sizes) on the liquid universe, the best net return at 15bps round-trip was **−0.004%**. The mean-reversion effect is real in sign but ~0.08–0.22% gross, below the cost floor. `intraday_recommendation_outcomes`: 26.7% win over 12,715 decided. | `src/server/intraday_ranker.py:40-95`, AF-20261001-04 |
| B5 | **Half the engines carry weight zero and are still computed, stored, monitored and displayed.** `REGIME_WEIGHTS`, every regime: `screener` 0.0, `cs` 0.0, `dl` 0.0, `smart_money` 0.0. Only `ml`, `confluence`, `technical`, `breakout` are live. | `unified_ranker.py:410-422` |
| B6 | **39 populated tables, ~12.9M rows, are written and never read by any non-test code** — 7 with no code reference at all (1.1M rows), 32 referenced only by their own fetcher, a `dataQualityChecks.ts` freshness entry and a `queues.ts` registration (11.8M rows). The largest table in the database is one of them: `niftytrader_live_screener_snapshots`, 11.3M rows, **5,477 MB**. | read/write reference map over 1,336 non-test source files |
| B7 | **The product's main output fails silently.** `morning-brief` has existed since 2026-10-09: 7 trading days, 8 runs, **5 delivered**. Failures: 2026-10-12 "newest ranking is 58h old"; 2026-10-14 "ranking session does not match the latest completed NSE session"; **2026-10-19 — today — "market open has passed; pre-open brief cannot be sent after 09:15 IST"** (it ran at 11:24 IST). | `job_run_history WHERE job_name='morning-brief'` |
| B8 | ~~**Long-term recommendations stopped three weeks ago.**~~ **WITHDRAWN 2026-10-20 — this finding was wrong, twice over.** The date was wrong (last `LONG_TERM` row is 2026-09-30, not 2026-09-28; the original figure read a `date_trunc('week')` bucket label as a date), and more importantly the *conclusion* was wrong: `LONG_TERM` stopped because it was **deliberately folded onto `POSITIONAL`** on 2026-10-03 (`unified_ranker.py:192-215`, `CANONICAL_TIMEFRAMES = ('INTRADAY','SWING','POSITIONAL')`, `_TIMEFRAME_ALIASES['LONG_TERM'] = 'POSITIONAL'`, commit `8645d47c`, ledger AF-20261001-06). The platform carried five mutually unmapped timeframe vocabularies and collapsed them onto three; `long_term` and `POSITIONAL` had always meant the same thing and were splitting one bucket across two labels. **No horizon is dead, and nothing failed to notice.** The user's three-horizon ask maps onto the canonical three: intraday → `INTRADAY`, short-term → `SWING`, long-term → `POSITIONAL`. | `unified_ranker.py:192-215`; `git show 8645d47c` |
| B9 | **87% of recent recommendation rows carry no horizon at all.** Last 30 days: 32,939 of 37,772 rows have `timeframe IS NULL` (every `Hold`, `Sell` and `Strong Sell` row). `conviction_level` is direction-agnostic, so `S_ELITE` means both "Strong Buy, avg score 85.9" (1,369 rows) and "Strong Sell, avg score 13.5" (4,353 rows). | `GROUP BY classification, conviction_level, timeframe IS NULL` |
| B10 | **Option-structure data is effectively absent, and the user intends to trade options.** `feature_store` coverage since 2026-09: `iv_rank` 8.4%, `max_pain` 5.5%, `iv_skew` 5.5%, `call_wall_dist_pct` 5.3%, `put_wall_dist_pct` 5.3%, `block_deal_value_cr` 1.0%, `days_to_next_earnings` 1.5%. | per-column non-null share, 104 numeric columns |
| B11 | **Job reliability is genuinely good** — 6,462 success / 19 failed over 7 days (0.29%). The failures that matter are not about volume: `morning-brief` (above) and `company-profiles-sync` ("0/15 profiles synced (15 failed)", four days running, including today). | `job_run_history`, 7 days |
| B12 | **The data-quality layer has become noise.** 30 hours: 16,811 pass / 342 warn / 32 fail. `confluence-signals-freshness` **fails on a 0.5-day-old row on every single run** — a cadence mismatch, not a defect — **(WITHDRAWN 2026-10-23: wrong. It failed only on the 2026-10-17 and 2026-10-19 host-sleep outages, where it was correctly firing, and passed 94-97 times on every other day since 10-15; my 30-hour sample contained an outage and I generalised from it. The real constant noise is four always-warn checks, see AF-20261021-05.)** and the file's own `dq-uninformative-checks` already reports a check stuck on the same non-pass verdict for 10+ consecutive runs. `dataQualityChecks.ts` is 4,057 lines. | `data_quality_history`, last 30h |
| B13 | **`.claude/worktrees/` holds 5 stale full copies of the repository**, which is why a naive repo-wide grep reports every table as having 6 writers. | `find` by directory |

### 2.1 The keystone: the deep panel already exists

The 2026-10-08 design states that "the ranker's engine inputs do not [exist] before 2026-08-10". That is
true of the 8-engine blend, and as written it closed off the only path to a conclusive answer. Measured
today, per column, across the 104 numeric `feature_store` columns:

- **59 columns are ≥60% populated back to 2021**, including every forward-return label
  (`target_ret_1d/5d/15d`, `target_dir_1d/5d/15d`) and: the full technical set (`rsi_14`, `macd`, `adx`,
  `atr_pct`, `bb_*`, `stoch_*`, `cci`, `williams_r`, `obv`, `vwap_dist_pct`, `hist_vol_21d/63d`,
  `volume_ratio_5d/20d`, `mtf_alignment_score`), returns at 1/5/15/21/63d, `delivery_pct`,
  `fii_3d_net`/`fii_10d_net`, `trailing_pe`, `price_to_book`, `earnings_yield`, `rev_growth`,
  `eps_growth`, `sector_ret_5d/21d`, `nifty_pe`, `nifty_ret_5d/21d`, `advance_decline_ratio`,
  `insider_buy_pct_90d`.
- 25 columns are recent-only (`pcr_oi`, `roe`, `piotroski_f`, `nifty_vix`, `dxy`,
  `news_sentiment_score`, `delivery_z_20d`, `ret_252d`, …) — usable going forward, not for the
  historical test.
- 21 are thin even now, which is B10.

Coverage by year: 2021 248 dates / 1,698 symbols; 2022 248 / 1,791; 2023 246 / 1,902; 2024 249 / 2,047;
2025 249 / 2,239; 2026 199 / 2,431. **2.73M rows.**

**Consequence.** A cross-sectional ranker built only on those 59 deep columns can be backfilled and
graded over 1,439 dates spanning the 2021 bull, the 2022 bear, 2023–24, 2025 and 2026 — roughly
**287 independent windows at h=5 and 68 at h=21**, against the ≥20 bar that the current ranker cannot
reach before **2027-02-26**. The labels are already in the table, so grading requires no waiting.

This is the single highest-value change in the plan, and it is a measurement change, not a model change.

---

## 3. Goals, non-goals, anti-goals

**Goals**

1. One pre-open artifact per trading day, delivered by 08:45 IST, with a delivery rate that is itself
   monitored — including an explicit "no trade today".
2. Three separately-measured horizon products: **intraday** (same session), **short-term** (5–15
   sessions), **long-term** (3–12 months). Each publishes only while its own realised net expectancy
   clears its own gate.
3. Every call labelled with the **tradability tier** it is valid for: F&O-eligible, ₹1–10L cash,
   sub-₹1L cash. Measurement stratified the same way.
4. Every displayed number traceable to a measurement with its date, independent-window count and cost
   assumption. No number without its `n`.
5. A conclusive answer — positive or negative — on the deep panel, in weeks rather than in 2027.

**Non-goals**

- Raising accuracy by reweighting the existing blend. `measurement.md` says this is usually the wrong
  fix, and the current weights are already the output of five separate measured removals.
- A fifth signal table, a parallel final score, or a third route tree (TALA and v1 already exist).
- New data sources before the 12.9M unread rows are either used or deleted.
- Rewriting the system. The Express/tRPC + React + Postgres/BullMQ + pm2 shape stays.

**Anti-goals — these would make the project a failure even if it shipped**

- A dashboard that looks confident. If the honest output is one call a week, that is the product.
- A hit rate computed on a window too short to distinguish from noise, displayed without its `n`.
- Deleting an engine or a table whose only sin is being *unmeasured* rather than measured-useless.
- "Highly accurate predictions" asserted rather than tested. The realistic target remains a cost-aware
  cross-sectional rank IC of roughly 0.05–0.10, honestly measured.

---

## 4. Constraints the builder must preserve

From `CLAUDE.md`, `CONTEXT.md` and `.claude/rules/`, unchanged by this design:

- Postgres/TimescaleDB on :5433 is the only database; no SQLite path. Compressed hypertables
  (`feature_store`, `stock_ohlcv`, `confluence_signals`, `intraday_ohlcv`) reject a predicate-wide
  `UPDATE`.
- NSE symbol is the only canonical identifier; provider ids map from it, never the reverse, and are
  never constructed by convention.
- `unified_recommendations` stays the one canonical ranking surface; new scoring work feeds it.
- Four signal tables is the ceiling.
- `as_of.logical_trading_date()`, never `date.today()`. Crons in `queues.ts` are UTC.
- The frozen forward-test protocol (hash `13210b4e2c3ae688`) is never edited.
- Every fix ships a regression test written first and shown failing on the unfixed code.
- Commit by explicit path; `git add -A` is forbidden (concurrent sessions edit this repo).
- The EVIDENCE rule: no score, weight, threshold or classification change without a cost-aware
  measurement first.

---

## 5. CORRECT — wrong logic, with the evidence

Ordered by consequence. Each is a defect in reasoning or in a contract, not a style preference.

| ID | Where | What is wrong | Why it matters |
|---|---|---|---|
| C1 | `morningBrief.ts` + `jobs/digests.jobs.ts` | The brief is gated on the ranker having completed for the latest **completed NSE session**, and when the gate fails it **fails the job and sends nothing**. Two of seven trading days produced silence; today's 11:24 IST run refused correctly, but nothing had gone out at 08:45 either. | The only daily deliverable has no guaranteed-delivery path. Silence is indistinguishable from "no trade today" — the one message the user explicitly asked for. |
| C2 | `unified_ranker.py` timeframe assignment | `timeframe` is written only for `Buy`/`Strong Buy`, so **87% of rows are NULL** — every `Hold`, `Sell` and `Strong Sell` row carries no horizon. (The "LONG_TERM is dead" half of this finding is **withdrawn** — see B8; that label was deliberately aliased to `POSITIONAL`.) | A ranking surface where 87% of rows cannot be filtered by horizon, while the product's whole promise is per-horizon calls. Still worth a check — on the **canonical three** (`INTRADAY`/`SWING`/`POSITIONAL`), not on whatever labels happen to appear. |
| C3 | `unified_recommendations.conviction_level` | Direction-agnostic: `S_ELITE` is both "Strong Buy, avg score 85.9" and "Strong Sell, avg score 13.5". Any consumer ordering by conviction and calling the result "top picks" surfaces Strong Sells. | A ranking surface whose headline label means opposite things from row to row. Needs a signed conviction, or a mandatory direction filter at every read. |
| C4 | `unified_signals.signal_type` | Two vocabularies in one column, by writer: `technical` writes `Bullish`/`Bearish`/`Neutral` (94k rows), `screener` and `technical_scan` write `BUY`/`SELL` (24k). `routers/misc.router.ts:453` filters `signal_type = 'BUY'` only — it structurally cannot see any technical signal. Five other call sites defensively write `IN ('BUY','Bullish')`. | A live API returns a systematically incomplete set. The defensive `IN (...)` elsewhere is the tell that this has bitten before and was patched per-caller instead of at the source. |
| C5 | `intraday_ranker.py:60` | `W_BREAKOUT, W_SCREENER, W_REVERSAL = 0.20, 0.40, 0.40`. `W_SCREENER` calls `compute_screener_stock_scores` — the *same function* whose output measured rank IC **−0.0326 @5d** and was zeroed in `unified_ranker`'s `REGIME_WEIGHTS` after four independent ablations. `W_BREAKOUT` is momentum, which the file's own header documents as the **wrong sign** intraday. | 60% of the intraday score is one measured-negative component plus one documented-wrong-sign component, diluting the 40% that measured the right way round. The file's reasoning is sound and its constants contradict it. |
| C6 | `dataQualityChecks.ts` | `confluence-signals-freshness` fails on a 0.5-day-old row on every run **(withdrawn 2026-10-23, see B12 and AF-20261021-05)**; 342 warns + 32 fails per 30h against 16,811 passes; `dq-uninformative-checks` already reports a check stuck on one verdict for 10+ runs. | A check that always fires carries no information and trains the operator to ignore the channel — the exact failure mode `ml-model-bugs.md` records for `drift_detector`'s `PSI_CRIT`. Thresholds must be calibrated against the writer's real cadence. |
| C7 | `_MF_FACTOR_WEIGHTS`, `unified_ranker.py:1595` | Deliberately duplicated from `multi_factor_scorer.py`'s `FACTOR_WEIGHTS` rather than imported, with a comment saying so. | Two declarations of one contract that nothing keeps in sync. This repo has already lost a subsystem to exactly this shape (a stale in-code `CREATE TABLE` against a migration). |
| C8 | `company-profiles-sync` | "0/15 profiles synced (15 failed)" every day for four days, including today. | A fetcher failing 100% of requests while the job merely reports a failed step. Per `bugs-data-layer.md`, making a provider failure loud is observability, not a fix: this needs the route-by-route minimum-header probe before anything else. |
| C9 | Measurement design | `factor_edge.py` samples daily and overlaps, so effective dates = dates/h, and the by-regime split divides the panel again — which is why 41 of 41 readings sit at 0.2–8.2 effective dates. Nothing is wrong with the correction; the **experiment design** cannot reach significance on a 42-date panel. | Measuring harder on the live panel will never produce an answer. §7.1's deep-panel replay is the fix, not a better estimator. |
| C10 | `.claude/worktrees/` | Five stale full repository copies. | Any repo-wide grep, count or audit silently multiplies by 6. It already corrupted this session's first usage map. |

---

## 6. REMOVE — with the evidence that it earns nothing

The user granted aggressive removal. Each item carries the measurement that justifies it. Anything
merely *unmeasured* is **not** on this list — it goes to §7 to be measured first.

### 6.1 Zero-weight engines, and their compute

`screener`, `cs`, `smart_money` and `dl` all carry 0.0 in every regime, each after its own measured
removal: screener −0.0136 IC @5d across four independent ablations; `cs` live CV AUC 0.176, materially
worse than random; `smart_money` identical to baseline to four decimals in four ablations; `dl` paused
2026-09-13 by user decision at +0.007 IC with 40% of predictions saturated.

Remove the **computation, storage, monitoring and display** — not the dictionary keys, because
`_blend()` renormalises over present engines and the reporting columns, drift monitoring and
dispersion-collapse tracking all expect the keys to exist. The 2026-10-08 review sized this at
~45 job-hours per month. `dl` is a **pause, not a verdict**: it leaves the daily path but keeps its
retrain and its registry row.

### 6.2 The write-only tables, in two tranches

7 tables with no code reference at all (1.1M rows) and 32 referenced only by fetcher + freshness check +
job registration (11.8M rows). The single biggest win is `niftytrader_live_screener_snapshots`:
**11.3M rows, 5,477 MB, zero readers.**

- **Tranche 1:** stop the writer and retire the freshness check. Reversible, data retained.
- **Tranche 2:** `DROP` after a `pg_dump -t`, and only once tranche 1 has been live for two weeks with
  no consumer surfacing.

A per-table reader check precedes each step, because the map behind B6 is a regex over SQL text and
**cannot see dynamically-built table names**; three spot-checks confirmed the pattern, not all 39.

### 6.3 Over-built surfaces

- `dataQualityChecks.ts` at 4,057 lines producing 17,185 verdicts per 30 hours. Keep the checks that
  guard a decision input; delete the ones that guard a table nothing reads (those go with 6.2 by
  construction). Target: every remaining check can name the decision it protects.
- The five stale worktrees under `.claude/worktrees/`.
- Dead components and duplicate nav entries already listed in the 2026-10-08 review's section F.
- `src/components/BuyRecommendationsPage.tsx` if still unrouted — honesty fixes landed there on
  2026-10-08 that no user could see. Confirm the import before deleting, and before editing.

### 6.4 Not removed, deliberately

`bharat_alpha/` (the self-grading rewrite) stays until §7.1 grades it under the same frozen rules — it
is the only candidate that was built point-in-time from the start.

---

## 7. ADD — what is missing

### 7.1 The deep-panel replay (the keystone; do this first)

A point-in-time cross-sectional scorer over the 59 deep `feature_store` columns, backfilled across all
1,439 dates and graded with `factor_edge.py` / `factor_backtest.py` discipline:

- **Per liquidity tier** (F&O-eligible, ₹50cr+ ADT, ₹10cr+ ADT, below) — the 2026-10-15 audit found the
  apparent edge sitting in untradable names, so the tiers are the result, not a footnote.
- Per horizon (1/5/15/21d), with independent windows (= dates/h) printed on every row.
- Cost-aware at a stated bps/side, with turnover, plus a rank-buffer (hysteresis) variant.
- With a **shuffled-score negative control** (t under 1) and the standing leak check
  `abs(corr(selection_var, same_day_return)) < 0.2` asserted before any result is written.
- Reusing `purged_cv.make_purged_group_time_series_split` — the answer to "how do I split a
  (symbol, date) panel" already exists in this repo, and `dl_engine.py` once got it wrong by not using
  it.

This produces the project's first conclusive verdict. **It may well come back negative.** That is a
successful outcome of this step, and the plan treats it as one.

**Phase 1 writes no production rows.** The replay reads `feature_store` and `stock_ohlcv` and writes its
panel and its verdict tables as files (parquet/CSV) under the session scratchpad, graded from those
files. This keeps the keystone inside the authority the 2026-10-08 design was granted, and means Phase 1
can start before §11.4 is answered. The durable per-date score table that Phase 2 needs is a **Phase 2**
artifact, created by a migration at that point — not a prerequisite of the measurement.

**Point-in-time F&O eligibility is derived, never assumed.** `nse_stocks.fno_eligible` is a
current-state flag (209 symbols) and applying it backwards would inject survivorship into the one tier
the user cares most about, in the one phase whose purpose is a conclusive verdict. Build the dated
eligibility series from the F&O bhavcopy (the 2026-10-08 review records that the old-format bhavcopy
returns 2022 history at ~62k stock-option rows/day); `technical_signals.mc_fno_eligible` is dated but
starts late and is written with the `date >= floor` pattern, so treat it as corroboration only. If the
bhavcopy series cannot be built back to 2021, the F&O tier's verdict is **bounded to the dates the
series actually covers** and says so — today's list is never applied to history.

### 7.2 Guaranteed pre-open delivery

The brief always sends, by 08:45 IST, in one of three states: **calls**, **no trade today** (gate not
cleared), or **degraded** (naming what was stale and what it fell back to). Delivery becomes a monitored
contract: a missing brief is an incident, not a quiet failed step. This fixes C1 and makes the user's
"no trade today" decision real.

### 7.3 Three horizon products, each with its own gate

**The three horizons are the repo's canonical three**, not new labels: intraday → `INTRADAY`,
short-term → `SWING`, long-term → `POSITIONAL`. `unified_ranker.CANONICAL_TIMEFRAMES` already fixes
this vocabulary and `_TIMEFRAME_ALIASES` folds every legacy spelling onto it (see B8). Do not
reintroduce a `LONG_TERM` writer — that label was retired on purpose.

`intraday_ranker.py`'s `EMISSION_GATE` is the right pattern and should govern all three: publish
actionable calls only while that horizon's own realised trailing net PnL is positive over a minimum
trade count. Each horizon's card states horizon, tier, entry/stop/target, the reason, and its own
trailing record.

**Each gate needs a shadow path, or it latches shut forever.** B3 says all three horizons are currently
negative, so on day one all three gates are closed. If a gate keys on *published* calls, nothing
accumulates and it can never reopen — and the system would ship §11.1's "honest refusal engine" by
accident rather than by decision. Intraday escapes this only because
`intraday_recommendation_outcomes` grades its decisions whether or not they were published (12,715
decided). So each horizon gets the same shape: **decisions are always written and always graded;
publication is what the gate controls.** The gate is seeded by Phase 1's replay verdict for that
horizon and tier, and thereafter runs on realised shadow results. A gate that has never been open is
reported as "not yet qualified", distinct from "qualified and currently negative".

### 7.4 Tradability tiers as a first-class field

Median ADT and F&O eligibility resolved per symbol per date, and attached to every call. This is what
lets one system serve all three of the user's intended sizes instead of silently serving none.

**One taxonomy, not two.** The measurement axis is **median ADT** (F&O-eligible / ₹50cr+ / ₹10cr+ /
below ₹10cr); position size is a *label derived from it* via the repo's 2%-of-ADT convention, not a
second tier system. So a tier states both: "₹50cr+ ADT — supports up to ₹10L per name".

**The sub-₹1L tier is measured but not automatically published.** At 2% of ADT a ₹1L position clears
roughly ₹50L ADT, i.e. nearly the whole universe — and that cohort is exactly the one
`measurement.md`'s 2026-10-15 entry (AF-20261015-10) calls an artifact: the apparent 5d top-decile edge
halves above ₹10cr ADT, bullish `unified_signal_outcomes` lose in *every* ADT tier, and worst
(−0.85% gross) below ₹1cr. The rule is therefore uniform and needs no exception: **a tier publishes only
while its own gate is open.** If the small-cap tier's edge is real after costs and fillability it
publishes; if it is the known artifact, it stays a measured row and never becomes a call. That turns a
contested judgement into an outcome of §7.3's gate.

### 7.5 Option-structure data (the F&O gap)

B10 shows the option features at 5–8% populated. For an F&O product the minimum is IV rank, IV skew,
OI-weighted max pain, call/put wall distance and days-to-expiry, daily, for the F&O universe. Follow
`data-sources.md`'s mandatory sequence before writing any fetcher: `market_endpoint_registry` (3,408
endpoints), then `url_endpoints` (834 templates) via `--find-alternates`, then `unique_urls.txt`, then
sibling probes with **minimum** headers. `nt_index_oi_eod`, `index_max_pain` and
`trendlyne_fno_activity` already hold rows and are on the write-only list — check what they contain
before fetching anything new.

**Published F&O calls are restricted to futures until an option spread model exists.**
`indian_market_costs.py` carries real STT / exchange / stamp / GST rates including futures and options,
and `factor_backtest.py` and the frozen forward test both charge 25bps/side — but `estimate_slippage_bps`
is market-cap-tiered **equity** slippage, and nothing in the platform captures option quotes, so no
bid-ask estimate can be built from stored data. At the strikes a retail product would trade, option
spreads routinely run 1–5% of premium and dominate every other cost term. Publishing option calls under
an equity-style cost assumption is precisely the "number without its cost assumption" that §3's
anti-goals forbid. So Phase 5 ships **futures first** (where the existing cost model genuinely applies),
and options become a published product only after a quote-capture fetcher and a measured spread estimate
exist. That capture has weeks of lead time and is the reason §11.3 matters.

### 7.6 Per-timeframe and per-engine production checks

A check that fails when any published horizon produces zero rows on a trading day, and one that fails
when a zero-weight engine is still consuming compute. Both classes recurred silently in the evidence
above.

### 7.7 Honesty surface

Per-horizon trailing record with `n` and independent-window count; the "no call" state; score
decomposition (`weight × (engine − 50)`); the forward-test view with its hash and its calendar-blocked
note. Mostly already specified in the 2026-10-08 design's section D — this adds the per-horizon and
per-tier split.

---

## 8. DOCUMENTATION CORRECTIONS

Verified today. `npm run doc:numbers:check` currently passes, so these are reasoning errors, not count
drift.

| Document | Correction |
|---|---|
| `2026-10-08-accuracy-and-honesty-program-design.md`, §G | "the ranker's engine inputs do not [exist] before 2026-08-10" is true of the 8-engine blend but reads as "no deep panel is possible", and it closed off the only path to significance before 2027. Add the measured column-depth result (59 of 104 columns ≥60% populated to 2021, labels included) and the 287/68 independent-window counts. |
| `CONTEXT.md`, "Measured State Of The Edge" | "a small positive rank IC that is still LOW-DATA" understates it: **41 of 41 readings are LOW-DATA at 0.2–8.2 effective dates**, so there is no usable reading in either direction. State the effective-date range, not just the label. |
| `CONTEXT.md`, "Live System Shape" | The flow lists eight engines feeding `unified_ranker`. Four carry weight 0.0. Mark which are live. |
| `.claude/rules/scoring-authority.md` | Add that `conviction_level` is direction-agnostic (C3) and that `signal_type` carries two vocabularies by writer (C4). Both are contracts a new consumer will get wrong. |
| `.claude/rules/measurement.md` | Record the 2026-10-19 baseline: the LOW-DATA sweep, the B3 outcome table, and the deep-panel feasibility result — so the next session does not re-derive it. |
| `docs/master-build-prompt.md` (untracked) | "Screeners: use 1,500+ screeners" and "Engines feeding one `unified_ranker`: screener, ML, cross-sectional, confluence, technical, DL, breakout" describe the intended design, not the measured one: four of those engines measured to zero. Either date-stamp it as the original brief or reconcile it. |
| `src/server/intraday_ranker.py:40-95` | The header's reasoning and its weight constants disagree (C5). **Resolution: correct the comment, not the constants, in Phase 4** — a weight change needs a cost-aware measurement first (§4's EVIDENCE rule), and inheriting `unified_ranker`'s four screener ablations as that evidence would compare readings taken at a 5d horizon on a different score, the "metrics computed against different targets" trap `ml-model-bugs.md` records. The honest statement is that the blend carries a component measured negative on the *daily* ranker and one whose sign is wrong intraday, that the emission gate is what currently protects the output, and that re-running the 256-config sweep with `W_SCREENER = 0` is a queued measurement item, not a Phase 4 line. |
| `docs/audit-findings.md` | Open rows for C1–C10 with stable ids; re-verify the 12 currently-open rows and either close them or restate why they are blocked. |

---

## 9. Phases and gates

Each phase ends with a gate that can fail. No phase starts before its predecessor's gate passes.

**Phase 0 — Stop the bleeding (days).**
C1 (guaranteed delivery including "no trade today"), C8 (company-profiles root cause), C2's missing
per-timeframe check so LONG_TERM's absence becomes visible, C10 (worktrees).
*Gate:* five consecutive trading days with a brief delivered before 08:45 IST and its state recorded;
a per-timeframe check that fails on an injected empty horizon.

**Phase 1 — The deep-panel replay (1–2 weeks).**
§7.1 end to end: scorer, backfill, tiered grading, negative control, leak assertion.
*Gate:* a written verdict per tier and horizon with independent-window counts ≥20, a shuffled control
reading t<1, and the leak assertion passing. **A negative verdict passes this gate.**

**Phase 2 — Act on the verdict (1 week).**
If positive: the deep scorer becomes a **component input** to `unified_ranker` (never a parallel final
score), published behind an `app_settings` flag defaulting OFF, with a test proving OFF is bit-identical
to today.
If negative: the published tiers shrink to whatever survives, the honesty surface says so, and the
project's goal becomes "correctly refuse" rather than "rank".

**Phase 3 — Remove (1 week).**
6.1, then 6.2 tranche 1, then 6.3. Each removal: per-table / per-engine reader check, then a two-week
observation window before tranche 2's `DROP`.
*Gate:* `tsc`, full `vitest`, full `pytest`, `schema:drift`, `doc:numbers:check`, `findings:check` all
green; a measured reduction in nightly job-hours and WAL; no consumer surfaced during the window.

**Phase 4 — Three horizons, three gates (1–2 weeks).**
§7.3, §7.4, C3, C4, C5, C6.
*Gate:* each horizon publishes only under its own emission gate; a test proves a negative trailing
expectancy suppresses publication; C4's vocabulary fixed at the source with every consumer re-pointed.

**Phase 5 — F&O data and the F&O product (2+ weeks; needs Phase 1's verdict).**
§7.5, then an F&O-eligible-universe variant of whatever survived Phase 2.
*Gate:* every new fetcher ships a `live_datasource` test and a freshness check; option features ≥80%
populated for the F&O universe before any option-based call is published.

**Standing gate on every phase:** `npx tsc --noEmit`; `npx vitest run`;
`python -m pytest src/server/__tests__/ src/server/tests/ tests/chatbot/` on `backend-python/venv`;
`npm run schema:drift` for migrations; `npm run doc:numbers:check`; `npm run findings:check`.
Committed is not deployed — `.ts` needs `pm2 restart bharat-server`, a migration needs `migrate:up`
against the real `POSTGRES_URL`.

---

## 10. Left to the builder

- The exact functional form of the deep scorer. Recommendation: start with an equal-weight z-score
  composite of the 59 deep columns grouped into momentum / value / quality / flow / volatility, because
  it is the hardest thing to overfit and the easiest to explain; a fitted model is Phase 2, after the
  equal-weight baseline has a number. Do not hand-fit weights (Finding #31).
- Module layout for the scorer, and whether the backfill runs as a one-shot script or a dated job.
- Which of `nt_index_oi_eod` / `index_max_pain` / `trendlyne_fno_activity` already satisfy part of §7.5.
- Telegram message format for the three delivery states.
- Whether C3 is fixed by a signed conviction field or by mandatory direction filtering at every read.

## 11. Open decisions for the user

1. **If Phase 1 comes back negative on every tier and horizon** — does the product become an honest
   refusal engine (watch-list, no calls), or does the scope change? Recommendation: honest refusal,
   because that is the version that cannot lose money and it is what the evidence currently supports.
2. **Tranche 2 drops** of ~12.9M rows across 39 tables after the observation window: approve the
   pattern now, or row-by-row at the time?
3. **Phase 5 ordering.** F&O data collection is weeks of work and is only worth it if the deep panel
   shows something. Start it in parallel with Phase 1 anyway (data collection has long lead times), or
   hold it until Phase 2? Note that option *quote* capture (§7.5) has the longest lead time of anything
   here and nothing can be published on options without it.
4. **Authority.** The 2026-10-08 design records: *"Not granted: production data writes or deletes,
   migrations, DROPs, file or table deletions, pausing jobs."* Phase 1 is now designed to need none of
   those. Phases 2–5 do: Phase 2 needs a migration for the score table, Phase 3 tranche 1 pauses
   writers, tranche 2 drops tables, Phase 4's signed-conviction option is a migration. Does "aggressive
   blast radius" extend that grant, and to which of the four?
5. **The uncommitted working tree.** 23 modified files plus untracked tests are in flight from another
   session, touching exactly the files Phase 0 edits — `jobs/digests.jobs.ts` (the morning-brief gate
   itself), `dataQualityChecks.ts`, `V1Routes.tsx`, `App.tsx` — and the 2026-10-08 program is still
   marked *awaiting review* with its sub-project A ("land what is done") unlanded. Does Phase 0 start by
   landing and verifying that work, or by setting it aside? The two give different diffs and different
   regression tests, and CLAUDE.md's concurrent-session rule means I must not revert another session's
   work without being told to.
6. **Which surface renders the horizon cards.** `src/v1/V1Routes.tsx` already imports an **untracked**
   `src/components/v7/` tree (V7Shell, V7Routes, five lazy pages at `/v7-dashboard`, `/v7-top-picks`, …)
   behind a `dashboardVersion` switch that CLAUDE.md calls stale. §3 forbids a third route *tree* but
   does not say where the cards land. Is v7 the intended destination (then it must be committed and
   routed first), or is it the thing §6.3 should remove? Guessing wrong ships Phase 4's product into a
   page nobody opens — the exact failure the design cites for `BuyRecommendationsPage.tsx`.

---

## 12. Calls made during the builder check (check these while reading)

A fresh builder read this document and returned nine places where a wrong guess would cost real work.
Three became §11.4–11.6 because only the user can answer them. The other six I settled, and each is my
call, not something the user agreed to:

1. **Phase 1 writes no production rows** — the keystone replay is file-based, so it needs no part of the
   withheld authority and can start immediately (§7.1).
2. **The score table is a Phase 2 artifact**, created by migration at that point, not a Phase 1
   prerequisite (§7.1).
3. **One tier taxonomy: median ADT**, with position size as a derived label via the 2%-of-ADT
   convention. The sub-₹1L tier is measured but publishes only if its own gate opens, which converts a
   contested judgement into a measured outcome (§7.4).
4. **Every horizon gets a shadow decision-and-grade path** — decisions always written and graded,
   publication alone gated — because a gate keyed on published calls latches shut forever and would ship
   §11.1's answer by accident (§7.3).
5. **F&O ships futures first.** Options wait for a quote-capture fetcher and a measured spread estimate;
   the existing slippage model is equity-only and option spreads dominate every other cost term (§7.5).
6. **C5 is resolved by correcting the comment, not the constants.** Changing a weight needs its own
   cost-aware measurement, and borrowing the daily screener ablations would compare different targets
   (§8).

Point-in-time F&O eligibility (§7.1) is also settled: derive a dated series from the F&O bhavcopy, bound
the F&O verdict to the dates that series covers, and never apply today's 209-symbol list to history.
