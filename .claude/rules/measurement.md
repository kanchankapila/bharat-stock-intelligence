---
paths:
  - "{src,scripts,migrations}/**/*{backtest,Backtest,factor_,accuracy,Accuracy,performance_tracker,calibrat,_edge}*"
  - "docs/measurement-history.md"
---
# Measurement Discipline

Read before quoting, comparing, or acting on any accuracy, win-rate, IC, or backtest number.

> ## ⚠ CORRECTION 2026-09-12 — read this before quoting ANY `factor_edge.py` reading below
>
> **`factor_edge.py` counted overlapping forward windows as independent observations, so the
> `dates` figure attached to every rank-IC/AUC reading in this file OVERSTATES its power by
> roughly the horizon.** A rank IC averaged over daily dates at horizon h carries ~`dates/h`
> independent observations. `MIN_DATES_RELIABLE = 20` was applied to the raw count, so readings
> cleared a reliability bar they missed by up to an order of magnitude (AF-20260912-15).
>
> Measured live across all 895 readings in `factor_edge_history`: **24 read `USABLE`, exactly 1
> survives the corrected count — and that one is `movement_probability`, already known to be a
> train/serve-skew artifact.** Only **46 of 895** readings carry 20+ independent periods.
>
> **Divide before you quote.** Recomputing `dates/h` for this file's own headline claims, from
> numbers already stated below:
>
> | claim as written below | dates | h | independent | status |
> |---|---|---|---|---|
> | `unified_score` +0.050 | 18 | 5 | **3.6** | not reliable |
> | `unified_score` +0.066 | 2 | 21 | **0.1** | anecdote |
> | `confluence_score` +0.168 / 0.583 | 2 | 21 | **0.1** | anecdote |
> | `win_probability` +0.056 / 0.506 | 64 | 5 | **12.8** | not reliable |
> | `ml_breakout_probability` +0.082 / 0.553 "clears USABLE" | 44 | 7 | **6.3** | **retracted** |
> | `breakout_probability` +0.153 / 0.583 | 19 | 10 | **1.9** | **retracted** |
> | `screener_momentum_score` +0.172 | 42 | 21 | **2.0** | not reliable |
> | `ccc_trend` -0.042 | 44 | 21 | **2.1** | not reliable |
> | `ext_t80_tech_score` +0.185 / 0.574 | 17 | 21 | **0.8** | anecdote |
>
> **Two things this correction does NOT touch, and conflating them would discard real evidence:**
>
> 1. **`factor_backtest.py` rows are unaffected.** It holds a portfolio to the next rebalance, so
>    its periods are DISJOINT — its `n periods` is already an independent count. Every
>    cost/turnover row in "Already tested" stands as written, including the capitulation triple
>    (t=+3.48, p=0.0005) and `momentum_12_1` (t=1.45).
> 2. **The `feature_store` mean-reversion finding stands, and is now the best-powered result
>    here.** Those readings run on **1,376–1,415 dates**, i.e. ~275 independent observations at
>    5d and ~66 at 21d. Both clear the bar comfortably. The platform's dominant 5d mean-reversion
>    result is untouched.
>
> **The net effect is not "everything is worse" — it is that the SHORT-PANEL readings this file
> has been treating as emerging leads were never evidence at all.** This also resolves a puzzle
> stated further down: that a promising LOW-DATA reading here "has, so far, never survived
> reaching full power." None of them ever reached power. The negative results, which rest on long
> panels and on `factor_backtest.py`, are unaffected and remain the reliable part of the record.
>
> `factor_edge.py` now emits `DEGENERATE-XS` (cross-section under 50 symbols — `pledge_*` read
> AUC 0.605 on **26**) and applies `MIN_DATES_RELIABLE` to `eff_dates`. New rows carry `eff_dates`
> and `symbols`; rows written before 2026-09-12 have NULL in both and are not comparable.

**Last refresh pass: 2026-09-26 — and unlike the two before it, this one RE-RAN BACKTESTS rather than only re-counting panels. Three cost-aware `factor_backtest.py` runs plus a fresh 18-column `feature_store` grading on the liquid universe. It flipped one verdict (`mean_reversion_14`, now significantly NEGATIVE), drifted `momentum_12_1`, and corrected this file's headline mean-reversion framing. See "2026-09-26 refresh" in the Snapshot.**

**Prior refresh pass: 2026-09-20 (freshness-only; DB re-probed live, evidence in `scratch_verify/md_reverify_out*.txt`).** It re-counted every panel, picked up the 2026-09-19 automated sweep's persisted gradings, and refreshed drifted numbers — it did NOT re-run backtests. Corrections are marked `WAS ->`. The 2026-09-10 pass below remains the last FULL re-verification.

**Last full re-verification pass: 2026-09-10.**
**Last full re-verification pass: 2026-09-10. Partial re-verification: 2026-09-20/21** (fresh
DB reads against live production; see the 2026-09-20 bullets in the Snapshot). Every claim in
the Snapshot, Standing
architecture facts, and Open/pending sections was re-measured against live production on that
date; 21 claims were refreshed and **11 were found materially stale or wrong** (the active
ensemble's CV, the dispersion-collapse verdict, the "never written" column list, `dl_score`
coverage, the `cs_ranker` metric, `smart_money`'s verdict, and five date counts). Each correction
is marked inline with `WAS ->` rather than silently overwritten, so you can see what drifted and
how fast. **Rows in "Already tested" that quote a `factor_backtest.py` cost/turnover number were
NOT re-run in that pass** — re-running the full backtest harness is the one thing here that costs
real time — so those carry their original dates and should be read as unrefreshed, not as
re-confirmed.

**How to read this file: every dated claim is a snapshot, not a verdict for all time.** A line
tagged `verified 2026-09-04` means exactly that — checked live on that date, not "true forever."
If you want to try something this file appears to discourage, that's fine: state what's different
this time (more history, a different horizon, a construction fix) and go. Re-testing most rows
here is a single SQL read or one script invocation — usually minutes, not the "days" an earlier
version of this file implied. What actually costs real time is a fresh multi-engine
`factor_edge.py`/`assembly_ablation.py` sweep across the whole platform; a single-factor or
single-column re-check almost never does. The only real ask is: don't silently re-derive a number
this file already has an answer for without checking here first, and don't quote a number from
here without checking its date.

Full incident narrative and investigation detail behind every claim below:
`docs/measurement-history.md` (append-only; every "verified again"/"what changed" passage that
used to sit at the top of this file was moved there on 2026-09-04, verbatim — nothing was deleted,
only relocated, so a fact missing here is one line away in history, not lost).

## Snapshot — every line below re-verified live on 2026-09-10

This section is a dated status board, not a verdict list. A claim carrying an older date elsewhere
in this file is not wrong, it is *unrefreshed* — check the date before quoting it, and re-run
rather than assume. Full narrative for anything here: `docs/measurement-history.md`.

### 2026-10-21 — Deep-panel tiered grading, 2021-01..2026-09 (phase 2026-10-19; `deep_panel*.py`) — do not re-run to "find" an edge

Panel: `feature_store`, 2,431 symbols, **34 of the 47 pinned columns scored**. The chain: 53 derived columns -> 6 warm-up-zero-filled
columns excluded upstream (`bugs-data-layer.md`) -> 47 pinned -> 13 excluded at grading (7 price-level columns at rank corr
+0.97..+1.00 with price, 6 market-wide columns with within-date std 0) -> 34 scored. Labels: stored-close entry (`close[t+1] -> close[t+1+N]`) at every horizon plus an open-entry arm at h=5.
ADT per the frozen protocol (`rolling(20, min_periods=15).mean()` of close*volume, Rs 1cr floor). Equal-weight composite,
same-day-leak guard on the label (limit 0.15), within-date shuffled control.

| h=5 tier | rank IC (close entry) | open-entry IC | verdict |
|---|---|---|---|
| **F&O-eligible** (dated series, bounded 2021-01-01..2024-07-05, 867 covered dates, eff 173) | +0.0077 | +0.0060 | no edge |
| ADT >= Rs 50cr | +0.0213 | +0.0181 | no edge |
| ADT >= Rs 10cr | +0.0257 | +0.0211 | no edge |
| ADT >= Rs 1cr | +0.0330 | +0.0252 | no edge |
| ADT < Rs 10cr | +0.0368 | +0.0260 | no edge |

- **No tier reaches AUC 0.55, so none is USABLE. The shuffled control reads no edge on all 25 rows.**
- **The F&O-eligible tier is new** (no earlier reading on this platform stratified by F&O eligibility), well powered (eff 173 against
  the floor of 20), and **the only tier whose IC is not distinguishable from zero.** F&O membership is resolved to the price panel
  by ISIN where the literal symbol has no bars (94.2% match: TATAMOTORS->TMPV, LTIM->LTM, GMRINFRA->GMRAIRPORT; 12 unresolved
  names reported, ~4.6% of eligible name-dates).
- **IC rises monotonically as liquidity falls** (+0.0077 -> +0.0213 -> +0.0257 -> +0.0368), independently reproducing "the edge
  sits in untradable names" (2026-10-15 tradability-floor measurement).
- **"No edge" here is real-but-economically-negligible, not indistinguishable from zero.** 20 of 25 cells have a positive IC that IS
  distinguishable from zero across 4 tiers; the largest is +0.0703 at AUC 0.533. The usable gate needs roughly IC 0.1.
- **The reusable lesson - clipping can manufacture significance.** The ADT<10cr 15-21d cells cleared a t 3.33 bar on WINSORISED
  returns (t 4.39 / 4.56) and read **t 1.62 / 1.64 raw**; ADT>=1cr likewise 3.93 / 3.90 clipped against 1.74 / 1.75 raw. The raw
  excess is LARGER (+3.5% at ADT<10cr 21d) and far too noisy to claim. Raw median-beater 0 of 25; the single winsorised flag
  (ADT>=10cr h=1) is itself a clipping artefact at raw +0.012. **Rule: report the raw t beside the winsorised one whenever a
  cost/excess claim rests on winsorised returns.**
- **`atr_pct` warm-up audit (the strongest single-column result on record, 2026-09-26 low-volatility):** zero-share 5.84% on 2024+
  (5.64% in 2021) and **99.5%** of those zeros still coincide with `sma20 IS NULL`, so the assumption that 2024+ warm-up touches only
  new listings is wrong. The 2026-09-26 reading is nonetheless NOT contaminated: dropping the zero rows, or the sma20-NULL rows,
  moves IC by <= 0.001 at every horizon. The liquid-tier replication reads -0.046 / -0.062 against the recorded -0.056 / -0.077
  (same sign, ~20% weaker, middle horizon 15d vs 10d).
- **Not like-for-like with AF-20261008-29** (2,431 symbols against 3,491 bhavcopy-unioned; a flat-haircut "net", not a turnover-aware
  backtest), so this neither overturns nor rescues it. Also: every reading in the latest `factor_edge_history` run on
  `unified_recommendations` (97 rows, 2026-10-17) sits below the eff-20 reliability floor, at eff 0.2-8.2 (see `CONTEXT.md`), so that panel cannot speak in either direction.

**Why the deep panel is gradeable at all (column-depth feasibility, measured 2026-10-19).** Of 104 numeric `feature_store` columns,
**59 are >=60% populated back to 2021** (including all six labels), 25 are recent-only and 21 are thin even now (`iv_rank` 8.4%,
`max_pain` 5.5%, `iv_skew` 5.5%, `block_deal_value_cr` 1.0%, `days_to_next_earnings` 1.5%). Coverage by year runs from 248 dates /
1,698 symbols in 2021 to 199 dates / 2,431 symbols in 2026; 2.73M rows. That supports ~287 independent windows at h=5 and ~68 at
h=21, against 0.2-8.2 on the ranker's own panel. Excluding the 6 labels and then the 6 zero-filled columns leaves the 47 pinned.

**B3 honest-outcome table (2026-10-19, `unified_signal_outcomes`, 180 days, after the 2026-10-08 short-side re-grade; gross of costs):**
h1 **40.66% win / -0.257% avg**, h5 **43.60% / -0.045%**, h15 **39.71% / +0.180%**.

### 2026-10-04 — Trendlyne technical-analysis snapshot (`trendlyne_adv_tech_daily`, AF-20261003-02)

Graded for the first time through `factor_edge.py --entry open` (read-only, not persisted): 49 daily
dates 2026-06-30..10-01, 2,261 symbols, 100% fresh. **`momentum_score`: 1d +0.007/0.505 (45 dates, no
edge), 5d +0.047/0.523 (eff 8.2, LOW-DATA, top-50 +1.30% vs universe, not a median-beater), 21d
+0.106/0.556 (eff 1.2, anecdote).** `ma_bull/ma_bear/osc_*/rsi/adx/mfi/roc_21` all no edge or LOW-DATA at
|IC|<0.07. **Rank persistence** (mean Spearman between sessions t and t+k): `momentum_score` 0.87@5,
0.69@21, 0.65@30; `ma_net` 0.64/0.38/0.32; `rsi` 0.71/0.28/0.17 — so a 30-day-old composite still carries
trend information but its oscillator/RSI parts are mostly gone. **Parity with the TS-written
`technical_composite_scores`** on 1,362 same-day symbols: `momentum_score` vs the Python one 0.90,
`trend_score` vs `ma_bull-ma_bear` 0.97, `composite_score` vs RSI 0.84 / ma_net 0.83 — related, not
interchangeable. The composite itself has one gradeable cohort (2026-07-16, 105 liquid names): 5d
+0.057, 21d +0.197 — an anecdote. **Verdict: no evidence for zeroing stale composites or substituting
the Python features, and no evidence against; the score path is unchanged, and staleness is now
visible via the `technical-composite-age` DQ check (warn at >=15% of rows 30+ days old, live 27.4%).**
Re-grade the Python history at ~20 effective 5d dates (~mid-December).

### 2026-09-26 refresh — backtests RE-RUN, not just panels re-counted

- **The ranker, re-graded live today** (`--entry open --persist`, panel 35 dates 2026-08-10..09-28,
  2,310 symbols; the 09-28 max is CORRECT — today is Saturday and `as_of.logical_session_date()`
  deliberately labels a weekend run with the session it is FOR, so those 1,920 rows are Monday's
  snapshot, not a future-dated bug):

      unified_score     5d +0.051/0.525   10d +0.069/0.536   21d +0.065/0.530
      confluence_score  5d +0.065/0.534   10d +0.093/0.551   21d +0.147/0.578
      technical_score   5d +0.028/0.511   10d +0.024/0.512   21d +0.010/0.503
      ml_score          5d +0.017/0.505   10d +0.022/0.505   21d +0.015/0.503
      dl_score          5d +0.010/0.506   10d +0.003/0.499   21d -0.002/0.498

  Every row LOW-DATA — **eff_dates 5.4 / 2.3 / 0.6**. The 21d column is 12 raw dates = 0.6
  independent windows and is not evidence of anything; do not quote confluence's +0.147 as a
  result. `dl_score` at ~0 is expected (weight PAUSED 2026-09-13). Verdict unchanged: the ranker
  reads positive, has no cost-aware evidence, and cannot yet distinguish a change from noise.

- **⚠ THE HEADLINE MEAN-REVERSION FRAMING IN THIS FILE IS PARTLY A MICROCAP EFFECT.** The
  `feature_store` readings the "Harness state" section quotes were taken on the FULL universe with
  no liquidity floor. Re-graded 2026-09-26 with the panel spec actually applied (open entry,
  >=Rs 1cr trailing-20d ADT computed with no look-ahead, forward returns winsorised 1/99 with
  `interpolation='lower'/'higher'`, 2024-01-01+, 1.00M rows, 654-675 dates, 2,189 symbols —
  eff 130 at h=5, 30 at h=21, i.e. FAR better powered than anything in the ranker sections).
  **Checked 2026-09-28 (AF-20260928-09): the numbers below do NOT depend on the winsorisation
  direction.** "`'lower'/'higher'`", read as low-cutoff/high-cutoff, is the REVERSED form that
  clips nothing (the correct form is `quantile(pct,'higher')` / `quantile(1-pct,'lower')`), and
  the script that produced these readings was never committed, so its direction can't be
  confirmed. It doesn't matter here: every reading below is a rank IC or rank AUC, and clipping
  the forward return is monotone, so it can only change ranks through ties at the cutoff.
  Measured on a 660-date x 1,500-name t(3) panel with a lone +1,279x bar and IC ~0.04: correct,
  inverted and un-winsorised all give IC 0.03999 / AUC 0.51952; the largest per-date IC gap is
  0.00005. No re-grade is owed. A MEAN-based statistic (e.g. `top50_exc`) WOULD be affected, so
  never reuse the reversed form there. The readings:

      column            h=5      h=10     h=21      | full-universe reading this file quotes @5d
      ret_5d          -0.040   -0.026   -0.012      | -0.051
      bb_pct          -0.028   -0.016   -0.005      | -0.042
      rsi_14          -0.022   -0.011   -0.002      | -0.038
      adx             +0.003   +0.005   -0.000      | -0.004

  **Every reversal column is ~30-45% WEAKER on names you can actually trade, and at h=21 they are
  gone entirely.** The mean-reversion result is real but concentrated in illiquid names and in the
  shortest horizon. This is the panel spec's own "without a liquidity floor you are measuring
  microcaps you cannot trade" rule biting this file's own headline claim.

- **The strongest, most horizon-persistent `feature_store` columns are VOLATILITY, not reversal** —
  a finding this file did not have. Same panel: `atr_pct` **-0.056 / -0.064 / -0.077** (AUC 0.475 /
  0.471 / 0.465) and `bb_width` -0.030 / -0.035 / -0.047, both STRENGTHENING with horizon, i.e.
  low-volatility names win and do so more at 21d. `vwap_dist_pct` is the mirror image: **+0.022 /
  +0.032 / +0.043**, positive and strengthening.

- **A 5-column composite, signs fitted on a TRAIN window only and evaluated out-of-sample, holds
  up on IC and then dies on costs. Both halves matter.** Train 2024-01-01..2025-06-30 (372 dates)
  selected `atr_pct`/`bb_width`/`di_plus` (negative) + `vwap_dist_pct`/`volume_ratio_20d`
  (positive) at |IC_h21| >= 0.02; held-out 2025-07-01..2026-09-25 (287-303 dates):

      composite_all       TEST  5d +0.049/0.526   10d +0.058/0.531   21d +0.076/0.538  (t=+10.71, 21% of dates negative)
      atr_pct_inv         TEST  5d +0.048/0.523   10d +0.050/0.525   21d +0.059/0.530  (t=+6.96)

  **The h=5 arm is WELL-POWERED (eff 60.6) and its +0.049 IC is comparable to the entire ranker's
  +0.051 — measured on ~11x more independent observations.** Leak-checked per
  `ml-model-bugs.md`'s standing rule: corr(selection variable, SAME-day return) = +0.131
  (composite), +0.070 (atr_pct_inv), both under the 0.2 bar. (`ret_5d` reads +0.446 and is
  contemporaneous by construction — it is NOT in the composite; a trailing 5d return legitimately
  contains day d's move, and entry is d+1 open, so the traded window does not overlap.)
  Train IC ~= test IC (+0.073 vs +0.076) is the documented leak tell and was checked rather than
  waved through; here it is explained — the "fit" is 5 signs and no parameters, and volatility is
  a persistent characteristic, so cross-period stability is expected.

  **Then the cost-aware arbiter kills all of it** (`factor_backtest.py`, 21d rebalance, top-50,
  25bps/side, disjoint periods so `periods` is already an independent count):

      mean_reversion_14  67 periods  net excess -0.9374%/period  t=-3.26  turnover 89.6%  0/6 years positive
      fs_atr_pct_inv     67 periods  net excess -0.7932%/period  t=-1.78  turnover 41.6%  2/6 years positive
      fs_bb_width_inv    65 periods  net excess -0.5361%/period  t=-1.55  turnover 83.5%  1/6 years positive

- **WHY positive IC and negative net return are both true here, and it is not a contradiction —
  this is a reusable trap.** `factor_edge.py` centres its excess return on the per-date **MEDIAN**
  (`xs_N = fwd - median`); `factor_backtest.py` benchmarks against the equal-weight universe
  **MEAN** (`universe_per_period_pct` = 1.4532%/period over 2021-2026). Indian equity cross-
  sectional returns are strongly right-skewed, so mean >> median, and low-volatility names
  systematically MISS the right tail. A low-vol factor therefore beats the median name (positive
  rank IC, honestly) while losing to the equal-weight universe (negative net excess, also
  honestly). **Before treating any rank IC as evidence of money, ask which centre it was measured
  against.** A factor can be a genuine median-beater and still be the wrong book to hold.

- **`factor_edge.py` now reports the mean benchmark alongside the median one, so this trap is
  visible without running a backtest (added 2026-09-26).** Two new output columns, `top50_exc` and
  `t_eff`: the per-date mean forward return of the top-50 by score MINUS the equal-weight universe
  mean, averaged over dates, with `t` divided by `sqrt(eff_dates)` (the same overlap correction as
  the reliability bar). **A positive `rank_IC` beside a negative `top50_exc` now prints
  `<-- median-beater: +IC but top-50 LOSES to universe mean` on the row.** It is a cheap early
  warning, NOT a replacement for `factor_backtest.py` — no costs, no turnover, no survivorship
  handling, and it holds to d+N instead of rebalancing. Verified to DISCRIMINATE rather than always
  fire (`ml-model-bugs.md`'s always-fires rule): silent on the ranker (`unified_score` top50_exc
  **+0.727%**, t_eff 1.90; `confluence_score` +0.813%) and on `dl_score` (+0.303%, t_eff 0.57 —
  correctly weak), firing on 5 of the 6 low-vol arms above. Existing columns were checked
  bit-identical after the change (`unified_score` 5d 0.051/0.525/n=55112/27 dates/eff 5.4/2291 syms
  before and after), so historical readings stay comparable. Immunized by
  `src/server/tests/test_factor_edge_mean_benchmark.py` (6 tests, negative-controlled by swapping
  the mean for the median, which breaks exactly the median-beater case).
- **New harness capability, added 2026-09-26:** `factor_backtest.py` now exposes `fs_<col>_inv`
  for every `FEATURE_STORE_FACTORS` column. Long-only top-k can only test the HIGH side of a
  column, so every column whose edge is on the low side — 14 of 23 — had been untestable by this
  repo's own arbiter except as the one hand-built 14-column blend. Bottom-50-of-x and top-50-of-(-x)
  are the same book, but its turnover and universe overlap are NOT the mirror of the high side,
  and turnover is what killed both `win_probability` and `mean_reversion_14`.

### 2026-09-20 refresh — what moved since 2026-09-10 (verified live; gradings from the 2026-09-19 close-entry sweep)

- **`factor_edge_history`: 3,022 rows across 12 tables, latest run 2026-09-19T12:17 IST**
  (WAS -> 1,571 rows / 11 tables / 2026-09-10T18:59). **The 2026-09-19 sweep persisted
  CLOSE-entry rows only** — no new open-entry rows for `unified_recommendations` /
  `confluence_signals` since 2026-09-10 (runs 19:11 / 18:59). Close-entry ICs are upper bounds
  per the entry-convention note in "Harness state".
- **`unified_score` (close-entry, 09-19 run): 5d +0.048/0.522 (n=49,339, 24 dates) · 10d
  +0.068/0.537 (39,461, 19) · 21d +0.049/0.522 (17,263, 8). All LOW-DATA.** Consistent with the
  2026-09-10 open-entry read below (+0.050/+0.064/+0.066 at 18/13/2 dates). The ranker still
  reads, is still LOW-DATA, and had no cost-aware backtest until 2026-09-27 (see below).
- **Engine grades, close-entry 09-19 (replaces the 09-10 table further down; same conclusion —
  `confluence` carries the ranker):**

      confluence_score   5d +0.068/0.535   10d +0.107/0.558   21d +0.156/0.580   (24/19/8 dates)
      technical_score    5d +0.027/0.513   10d +0.024/0.511   21d +0.013/0.504
      ml_score           5d +0.012/0.505   10d +0.024/0.508   21d -0.000/0.497
      dl_score           5d +0.007/0.504   10d +0.002/0.501   21d -0.011/0.494
      unified_score      5d +0.048/0.522   10d +0.068/0.537   21d +0.049/0.522

  Every row LOW-DATA (24/19/8 dates). Confluence remains both the strongest-reading engine and
  the highest-weighted — no reweighting conclusion. The 21d column is still 8 dates: anecdote only.
- **Populations that moved:** `confluence_signals` post-reclassification panel is now **23 dates**
  (2026-08-29..09-20, counted live) — **it has cleared the 20-date floor at 5d**; the next
  open-entry re-grade will be well-powered. `screener_momentum_score` post-reclass: **19 dates**
  (WAS -> 14; 14 -> 19 live 2026-09-27, counted 2026-08-31..09-25) — ONE session short of the
  floor, so it clears with the next session, **2026-09-28** (the old ~09-29/10-06 estimate is now
  pessimistic). `stock_futures_oi_history`:
  **21 dates** (WAS -> 14), 2026-08-21..09-18. `ext_t80_tech_score` since 2026-08-01: **34 dates**
  (WAS -> 17 total at its grading) — **the 20-date floor is now cleared**; an open-entry re-grade
  is warranted (the lead reading was 21d +0.185/0.574 on 17 dates). **Re-grade done 2026-09-11
  (open-entry): 21d +0.1764/0.5772 on 21 dates → USABLE; 10d +0.0977/0.5513 on 32 dates →
  USABLE; 5d +0.0620/0.5343 on 37 dates → no edge.** Still LOW-DATA at 21d (21 dates) — the
  platform's strongest vendor-column lead, not a result.
- **`movement_probability` is now GRADED — no edge.** Open-entry 2026-09-11 run on 33/28 dates
  (WAS -> "15 dates, neither gradeable yet"): 5d rank_IC **-0.0116** ("no edge"), 10d **-0.0109**
  ("no edge"), 21d -0.0149 (LOW-DATA, 17 dates). Closed; do not re-run as "highest-value".
- **`stock_futures_oi_history` graded 2026-09-19 (close-entry, LOW-DATA 13-17 dates), RE-GRADED
  2026-09-26:** `basis` 1d now reads **rank_IC +0.1355, AUC —, 22 dates, eff 22.0 → verdict
  `USABLE`** **[SUPERSEDED 2026-10-04: +0.064/0.532 on 25 dates = `no edge`; see the end of this file]** (`factor_edge_history`, run 2026-09-26T12:45; the panel is 26 dates, 2026-08-21..09-25).
  **WAS -> +0.139 / AUC 0.565 on 17 dates, labelled "a lead, not a result".** `basis` 5d +0.0596 (18
  dates, eff 3.6, LOW-DATA); `oi_change` 5d +0.078/0.532 (13); `oi_pcr` ~0; `rollover_pct` negative
  at both horizons. The 1d column is the platform's only non-capacity-constrained reading above
  0.10 with 20+ independent dates — quote it as `USABLE`, not as a lead. Every other column in this
  table remains LOW-DATA.
- **`win_probability` re-graded 2026-09-19: 1d +0.025 (73 dates, "no edge") · 5d +0.053 (69,
  LOW-DATA) · 21d +0.070 (53, LOW-DATA).** (WAS -> 0.053/0.056/0.071 on 64/59/48 dates,
  2026-09-13.) Same shape: real 5d/21d IC, verdict unchanged — still fails at 83.4% turnover.
- **The analyst-revision trio moved tables: `eps_revision_3m_pct` / `target_revision_3m_pct` /
  `analyst_count_chg` now live in `technical_signals`, NOT `feature_store`** (checked live
  2026-09-20; `feature_store` holds only `analyst_buy_pct` / `analyst_target_mean` /
  `analyst_target_upside_pct` / `analyst_n`). Current panel: 6,863 / 9,178 / 9,331 rows across
  **9 dates** (2026-09-07..09-18). Still ungraded and still must not be graded until ~20 dates
  (~mid-October).
- **Models:** active Stacking Ensemble retrained **2026-09-19** (version `20260919_115848`,
  cv_roc_auc **0.5313**; WAS -> 0.5277 / 2026-09-10). Active `confluence_ml`
  breakout_probability is 2026-09-18 (cv **0.6906**). **BiLSTM v6 trained 2026-09-20 (cv 0.5208)
  is registered but NOT active** — the honest post-fix chain is v5 active (cv 0.5177,
  2026-09-12) with v6 as challenger pending promotion criteria. DL trainer ran 2026-09-19 14:12
  IST. `model_registry` total: **343 registrations**.
- **`exit_policy` (GradientBoosting Regressor Pair; the label "`cs_ranker`/" that used to precede it was WRONG — see the CORRECTION on the `cs_ranker` bullet in "Open / pending"): three MORE challengers rejected
  since 09-10** — 2.0750 (09-11), 1.9907 (09-14), 2.0725 (09-19), all `is_active=0`; the champion
  remains 20260901_123532 (1.8021). All values > 1 — still not AUCs, still consistent rejections.
- **DQ as of 2026-09-20 18:46 IST:** `ur-engine-dispersion-collapse` **pass** (unchanged detail:
  ml 0%, dl 0%, technical 0% vs baseline). **`fundamentals-history-vendor-field-decay` FAIL
  again** — `return_on_equity 6.1%` on the latest 2,474-row snapshot; `data-quality-daily`
  failed 2026-09-20 03:00 IST citing it; `company-profiles-sync` failed 2026-09-19 21:00 (0/2
  profiles synced). All 14 other recent checks pass.
  **FIXED 2026-09-20 ~21:00 IST (root causes, not silences):** `fundamentals_snapshot.py` now
  COALESCEs `return_on_equity` per symbol from `investsights_fundamentals_history` (latest row
  with `fetched_date <= as_of`, point-in-time; Yahoo stays PRIMARY) — the snapshot-side twin of
  the AF-20260917-07 feature fallback (Pearson 0.9608, same fraction scale). The 2026-09-20
  snapshot was re-run: ROE coverage **6.1% -> 77.8%** (151 -> 1,924 / 2,474); live DQ sweep now
  reads the check **PASS** (`2474 rows; return_on_equity 77.8%, debt_to_equity 86.6%,
  operating_margins 97.3%, piotroski_f_score 97.3%`), so `data-quality-daily`'s
  throw-on-critical goes green at its next 03:00 IST run. The 09-18 snapshot was deliberately
  NOT rewritten (a point-in-time table keeps its honest 6.1% record; the check reads
  MAX(as_of_date)). The one remaining sweep FAIL is `bulk-endpoint-fetcher-coverage`
  (critical=false — does not fail the job; `so_option_chain` 16.9% coverage is the driver).
  `company-profiles-sync`'s 0/2 failures were the NULL-latest-description bug already fixed in
  source by AF-20260920-01: the 2 due stocks are AXISBANK + CHALET and both now resolve a
  non-null description, so the verdict returns success. **DEPLOYED 2026-09-20 21:36 IST:**
  `pm2 restart bharat-server` after a zero-active-BullMQ-jobs check (AF-20260910-04 protocol);
  HTTP 200 + `pm2 save` + `check_deploy_drift` OK (started after HEAD `da0b3581`). Today's
  scheduled 21:00 IST run (id 34189) and the post-restart make-up (id 34209, 7/0) both synced
  green. The production 15-min sweep (21:53 IST) stamped the check-id heartbeat rows itself
  (run_count 1 -> 2) — the heartbeat writer is live in production, not just probe-verified.
  **Found + fixed during deploy verification: Google RETIRED `gemini-2.0-flash`** — every AI
  analysis was 404ing while the job stayed green (defaults stored; AXISBANK/CHALET
  growth_score 0.0 was this, not the sync bug). `geminiService.ts` now defaults to
  `gemini-3.6-flash` (GEMINI_MODEL override) with maxOutputTokens 300 -> 2048 (the 3.x
  generation burns ~316 thinking tokens — 300 returned EMPTY text); live-verified a real
  analysis through the service path. Same default fixed in `agents/narrative_client.py` +
  `chatbot/llm.py` (chatbot restarted); already-stored default analyses refresh on each
  symbol's normal 7-day re-analysis cycle.
- **RESOLVED 2026-09-20 ~21:00 IST — `job_heartbeat` integration gap:** the 12 most-recent
  `job_heartbeat`
  rows all read `last_status=NULL, last_run_at=NULL, run_count=0, fail_count=0`
  (`screener-catalog-freshness`, `feature-engineering`, `dq-new-failures`,
  `technical-signals-range-bounds`, etc.) — checks are registered but their producers never
  write heartbeats. The standing advice "check `job_heartbeat` before trusting freshness" is
  now only half-usable: **a NULL row means unmonitored, not healthy.** Treat freshness claims
  as table-verified (query the data's own max date), not heartbeat-verified.
  **Fix:** `runDataQualityChecks` now stamps one `job_heartbeat` upsert per check
  (`persistCheckHeartbeat`, mirroring jobHeartbeat.ts's UPSERT convention; warn→success,
  fail/error→failed with detail as last_error; deliberately NO `job_run_history` append —
  that would be ~16k rows/day). Live verification sweep: **175/175 check-id rows populated,
  0 NULL**. `getStaleJobs()`'s dataQualityIds exclusion stays (a check's health signal is its
  verdict in `data_quality_results`, not heartbeat age).
- **Freshness counts:** `engine_composite_scores` 121,892 rows / **84 dates** (WAS -> 109,174 /
  79), 2026-05-23..09-18. `technical_signals` spans **93 dates** (2024-06-01..09-18).
  `unified_recommendations`: 61,160 rows, **30 distinct dates** (2026-08-10..09-21 — the 09-21
  max is a tz-boundary artifact of the latest `computed_at`). `deep_learning_predictions`: 55
  dates (2026-06-17..09-18).


**The 2026-09-10 re-verification pass corrected six claims that had gone stale.** Each is marked
inline with `WAS ->` so the drift stays visible instead of being silently overwritten. The
2026-09-20/21 partial pass re-read the same live series: **no verdict reversals — only panel
growth** (engine block dates 18→24 / 13→19 / 2→8; OI history 14→21; screener_momentum
post-reclass 8→14) plus one NEW finding: most `job_heartbeat` rows are registered with
`last_status=NULL, run_count=0` — the heartbeat table is not integrated with all producers.

### The ranker

- **`unified_score` is NOT reading no-edge.** Do not quote the old "5d rank IC = 0.0001" figure —
  it was measured under the PRE-2026-08-30 weights. Measured 2026-09-10 (`factor_edge.py --table
  unified_recommendations --scores unified_score --date-col computed_at --entry open`):

      unified_score  ALL   5d   rank_IC +0.050  hit_AUC 0.522  n=37734  18 dates  LOW-DATA
      unified_score  ALL  10d   rank_IC +0.064  hit_AUC 0.529  n=27620  13 dates  LOW-DATA
      unified_score  ALL  21d   rank_IC +0.066  hit_AUC 0.531  n=4387    2 dates  LOW-DATA

  WAS -> 2026-09-19 automated sweep: close-entry 5d +0.0543/0.5254 (19 dates),
  10d +0.0675/0.5369 (19), 21d +0.0491/0.5216 (8); open-entry 5d +0.048/0.522 on 24 dates
  (engine block below). Panel grew 18→24 dates; IC stable; verdict unchanged.
  (Re-run at 19:15 IST the same day; an earlier 11:02 run read 17/12/1 dates and
  +0.050/+0.058/+0.073 — the difference is one additional session landing between the two
  runs, not a methodology change. The 5d IC was identical to three decimals across both.)
  Close-entry the same day read +0.0525 @5d, consistent with this file's "h=5 barely moves"
  finding, so the 5d number is not a close-entry artifact. Broadly in line with the 6-engine
  reconstruction (+0.081 @5d) that `unified_ranker.py:127` cites for zeroing `screener` — i.e.
  **the shrinks appear to have worked**, which that comment said could not be verified
  retroactively. **Three things this is NOT yet, none of them skippable before calling the ranker
  "working":** (1) 17 dates is under `MIN_DATES_RELIABLE=20`, so the verdict is LOW-DATA, not
  USABLE; (2) **the panel is MIXED-WEIGHT** — `unified_recommendations` spans 2026-08-10..09-10
  (24 dates, re-counted live 2026-09-10) but the cs/smart_money zeroing landed 2026-08-31, so only
  **8** of those dates were generated under today's weights; a clean post-change panel needs ~12
  more sessions (**19 of them now exist — live count 2026-09-27, so the clean post-change panel
  completes 2026-09-28**); (3) ~~no cost-aware `factor_backtest.py` pass has ever been run on
  `unified_score`.~~ **FIRST PASS TAKEN 2026-09-27 — see "The ranker, cost-aware" below.**
  An IC of 0.05 is not money — `win_probability` had a real IC too and
  still failed at 83.4% turnover.
- **`REGIME_WEIGHTS` re-read live 2026-09-10:** `screener`, `cs` and `smart_money` are **0.0 in all
  five regimes** (BULL / BEAR / HIGH_VOL / CRASH / SIDEWAYS). Nobody has silently reverted the
  shrinks.

### The ranker, cost-aware (2026-09-27)

**The first cost-aware readings ever taken of `unified_score`**, both through `factor_backtest.py`'s
new `external_score` path (AF-20260927-13 — a table-scored factor was previously unreachable
because `run_backtest()` only accepts factors computed from the `stock_ohlcv` panel):

| cadence | panel | periods | gross / cost / net per period | universe | net excess | t | one-way turnover | cost drag |
|---|---|---|---|---|---|---|---|---|
| 5-session | 2026-08-10..09-25 | **3** (0.06y) | +1.6201 / −0.3367 / +1.2835 | −0.0316 | **+1.315** | (4.49) | 0.673 | **16.97%/yr** |
| 1-session | 2026-08-01..09-25 | **24** (0.1y) | +0.3283 / −0.1996 / +0.1287 | +0.0536 → +14.44%/yr (`benchmark_sane` true) | **+0.0752** | (0.73) | 0.399 | **50.3%/yr** |

- **Neither run reaches the verdict floor**, and that is the headline. `MIN_PERIODS_FOR_VERDICT = 20`
  AND `MIN_YEARS_FOR_VERDICT = 1.0` (AF-20260927-14) both apply, so the harness prints
  `INSUFFICIENT POWER` and refuses a verdict. The 5-session t=4.49 is **three overlapping periods —
  do not quote it**; the 1-session t=0.73 over 24 periods is the more honest read and says nothing
  distinguishable from zero net of costs. The verdict floor for this factor is a **full year of
  ranked sessions**: `unified_recommendations` starts 2026-08-10, so a 5-session-cadence verdict
  cannot exist before ~**2027-08**. Until then only the turnover/cost-drag figures below are
  reportable.
- **What IS readable now: turnover is the binding constraint.** 0.673 one-way per 5 sessions →
  **16.97%/yr**; 0.399 per session → **50.3%/yr**, at 25bps/side. Before any IC converts to money the
  ranker must clear a 17–50%/yr cost hurdle, and this is a mechanical property of the holdings, not a
  return estimate — hence it survives the power gate.
- **Date the score by `generated_at`, never `computed_at`** (the trap this pass found):
  `computed_at` is the session the ranking is **for** (the entry session — verified, the batch
  stamped 2026-09-28 was written 2026-09-25 17:00:01Z), `generated_at` is when the run produced it.
  Merging on `computed_at` lags every period by one session and re-scores a post-close re-run
  against its own day.


### Models
- **`dl` weight PAUSED to 0.0 in all five regimes, 2026-09-13 (user decision, AF-20260913-05).**
  Not a verdict that DL cannot work -- a pause while the inputs are rebuilt and the model retrained
  (AF-20260913-02). Evidence at the time: `dl_score` no edge on `unified_recommendations`
  (+0.007 rank IC @5d, 2026-09-10, LOW-DATA); live inference had been reading raw prices
  (AF-20260913-01, fixed); with inputs corrected the active v5 pins **40%** of served `prob_up_5d`
  below 0.01 / above 0.99 (23% on its own training window), and the calibrated v3 (2.8%) has no
  honest AUC. Freed weight split over ml/confluence/technical, breakout pinned. **Measured effect on
  the 2026-09-11 panel (1,971 names, SIDEWAYS): rank-corr old-vs-new blend 0.895, top-50 overlap
  19/50** -- from a simplified `_blend` re-run that reproduces the stored `unified_score` only at
  corr 0.76 (vetoes/dispersion drops not replayed), so treat those two numbers as indicative.
  **Population boundary: `unified_score` rows from 2026-09-14 onward carry no dl contribution --
  do not pool them with earlier rows when grading the ranker.** Restore only from a promoted
  model's realized `factor_edge_history` reading, not the old 0.16-0.21 weights.


- **The active ensemble is CV 0.5277, trained 2026-09-10** (`model_registry` id=322, version
  `20260910_102154`, n=281,476, test_roc_auc 0.5422).
  **WAS -> "still 0.5305, trained 2026-08-29 — no retrain has landed since." That was wrong by two
  retrains:** 2026-09-06 (cv 0.5303) and 2026-09-10 (cv 0.5277, now active). Across the
  post-label-switch champions the trend is mildly *down* (0.5348 -> 0.5324 -> 0.5305 -> 0.5303 ->
  0.5277) while training samples grow (206k -> 281k). That is what an honest label's CV doing
  regressing toward its true value looks like, and is **not** evidence of degradation — but per
  this file's own governing rule, none of these numbers is evidence of anything either way; only
  the realized `factor_edge_history` reading is. Note `is_active` is a **bigint (0/1), not a
  boolean** — `WHERE is_active = true` throws `operator does not exist: bigint = boolean`.
- **Every DL BiLSTM `roc_auc` recorded before 2026-09-10 is INFLATED and must not be quoted**
  (AF-20260910-08). `walk_forward_validate` sliced a symbol-major concatenated panel by ROW
  POSITION, so folds 1-27 carried 99.9-100% train/test DATE overlap. Fixed 2026-09-10 with
  date-grouped `purged_cv` folds. **The purged-CV numbers now exist, and they are chance-level**
  (re-verified live 2026-09-30, `model_registry` `model_type='deep_learning'`, 15d horizon):
  `cv_roc_auc` 0.5057 (09-12 10:32), **0.5177 (09-12 20:59, the `is_active=1` row)**, 0.5119
  (09-13), 0.5208 (09-20); the held-out series in `dl_model_performance` (lstm_v4/v6) matches.
  Nothing has registered since 09-20: `dl-trainer` failed 3× on 2026-09-28/29 (AF-20260927-20,
  AF-20260929-01). Quote DL as "~0.51-0.52 purged-CV AUC, i.e. no demonstrated edge" — never
  any pre-09-10 figure in `dl_model_config.json`, and never a CV AUC as forward-return evidence
  (`ml-model-bugs.md`). `dl` ranker weight stays PAUSED at 0.0 (AF-20260913-05).
  ⚠ 8 `dl_model_performance` rows (ids 77..186, 2026-08-24..09-09, `model_version='current'`)
  still carry the test sentinel `roc_auc=0.58 / directional_accuracy=0.55` — AF-20260930-01.
- **Engine dispersion now PASSES at 0% collapse — the "ml 80%, WARN" story is retired.**
  `dq:check`'s `ur-engine-dispersion-collapse` reads live: *"ml 0%, dl 0%, technical 0% of last 10
  dates (baseline 2026-08-22: dl 39%, ml 34%, technical 18%)"*, status **pass**.
  **WAS -> "ml 80% / dl 0% / technical 0%, still WARN".** The cause is a constant this file never
  recorded: **`ZERO_DISPERSION_MIN_SD_BY_ENGINE = {"ml": 3.0}`** (`unified_ranker.py:562`) now
  overrides the global `ZERO_DISPERSION_MIN_SD = 5.0` for `ml` alone. Measured directly, ml's
  per-date sd over the last 10 ranker dates is **3.217-4.647** — that is 10/10 "collapsed" against
  the old 5.0 bar and **0/10** against the live 3.0 bar. The underlying finding is unchanged and
  still stands: `calibrated_win_probability`'s banding is the isotonic fit working as intended and
  must **not** be "fixed" (tie-breaking within a band costs 23% of h=5 IC to buy +0.007 at h=21).
  **SUPERSEDED 2026-10-15:** the stored ranker input now collapses on 10/10 dates, but the raw
  source does not: `technical_signals.win_probability * 100` has cross-sectional sd 4.30-4.69
  and about 1,490 distinct values on the latest grid, while stored `ml_score` has sd 0.38-0.74
  recently. The live BEAR `calib_slope=0.13321` mechanically explains the gap (raw 4.33 × 0.133
  ≈ stored 0.58); this is not a dead/frozen model. `ur-engine-dispersion-collapse` now reads both
  populations: raw collapse remains a failure; a dispersed raw source deliberately shrunk below
  the blend floor is a WARN/no-trust state. The engine remains excluded — this monitoring fix
  does not promote it and does not alter the standing no-edge verdict below.

### Populations that cleared their date floor — all now graded

- **GRADED 2026-09-06, all NO EDGE.** `smart_money_score` (rank_IC +0.004 @1d / -0.016 @5d, 18
  usable dates), `technical_signals.ext_*` (all 10 vendor columns no-edge at 1d and 5d; the best
  reading is `ext_t80_tech_score` at 21d, rank_IC +0.185 / AUC 0.574, but on only 17 dates — treat
  it as a lead, not a result), and `ccc_trend` (negative at every horizon on a well-powered panel:
  -0.006 / -0.035 / -0.042 at 1/5/21d across 64/60/44 dates).
  **WAS -> the Snapshot described all three as "gradeable and none has been graded yet" while the
  Open/pending section below already recorded these verdicts — the file contradicted itself.**
  `ccc_trend` now carries **86 dates** (2026-05-16..2026-09-09). Data-integrity finding from the
  same run: `ext_mojo_quality_rank` and `ext_t80_quality_rank` are **100% identical, corr = 1.0**
  across all 28,584 rows — one column stored under two vendor names (AF-20260906-06).
- **The analyst-revision trio is now writing real rows, exactly on schedule.** Live 2026-09-10:
  `eps_revision_3m_pct` 2,288 rows, `target_revision_3m_pct` 3,065, `analyst_count_chg` 3,116,
  spanning 2026-09-07..2026-09-10 across **3 distinct dates**. The 2026-09-05 prediction ("the
  first real rows land Monday 2026-09-08") held exactly. **Still ungraded, and must not be graded
  yet** — ~20 dates are needed, so ~2026-10.
- **`movement_probability` and `stock_futures_oi_history` are no longer "under the floor" —
  both graded.** movement_probability: 2026-09-11 open-entry, **no edge** (see the Snapshot
  bullet above; WAS -> "15 dates, neither gradeable yet"). OI history: **21 dates** as of
  2026-09-20, graded 2026-09-19 — `basis` 1d +0.139/0.565 is the lead reading (see Snapshot).
- **`screener_momentum_score`'s post-reclassification panel is at 14 dates** (WAS -> 8 on
  2026-09-10, ~4 on 2026-09-04). Still under the 20-date floor; clears ~2026-09-29/10-06 —
  genuinely calendar-blocked, not neglected.

### Harness state

- **`factor_edge_history` is fresh:** latest `run_at` **2026-09-19T12:17 IST** (WAS ->
  2026-09-10T18:59) — now **3,022 rows across 12 distinct `table_name` values** (WAS -> 1,571/11).
  The 2026-09-19 12:15–12:17 run is an **automated daily sweep** (it graded
  `stock_futures_oi_history` for the first time and refreshed all `unified_recommendations`
  engine scores); expect a new batch every trading day, so any manual re-run should filter
  `run_at` to the latest batch. **Check the entry convention before reading any row** —
  the automated sweep persists CLOSE-entry rows under `table_name = '<table>'` and open-entry rows
  under `'<table>__open_entry'`. The two are not comparable, this file's panel spec prefers open
  entry, and every close-entry IC is an upper bound.
- **`factor_edge.py` could not grade ANY table whose date column is `timestamptz` — fixed
  2026-09-10.** `_load` did a bare `pd.to_datetime`, producing a tz-aware column that pandas
  refuses to merge against the tz-naive DATE coming from `stock_ohlcv`. It failed loudly rather
  than silently, but it blocked `confluence_signals` (73 dates) and any other timestamptz-keyed
  table outright; `unified_recommendations` escaped only because its `computed_at` is stored as
  **TEXT**. Now converted to **Asia/Kolkata before taking the calendar day** — stripping the zone
  instead would mis-date every row written by a post-midnight-IST job. Per this repo's rule that a
  measurement-tooling change deserves at least as much suspicion as the thing it measures, a known
  result was reproduced first: `win_probability` came back **bit-identical** (0.056 / 0.506 /
  n=97,487 / 64 dates), so the change is a strict no-op on tables that already worked.
- **`feature_store` QUARANTINE LIFTED 2026-09-10 — the rebuild landed and the readings were
  re-run on raw data. The mean-reversion finding SURVIVED unchanged.** Measured after the
  rebuild (`factor_edge.py --table feature_store --entry open`), on **1,376-1,415 dates and
  ~2.6M rows** — far better powered than any prior reading of these columns:

      rsi_14   1d -0.028/0.490   5d -0.038/0.488   21d -0.021/0.496   no edge
      bb_pct   1d -0.031/0.488   5d -0.042/0.485   21d -0.022/0.495   no edge
      ret_5d   1d -0.028/0.490   5d -0.051/0.481   21d -0.026/0.492   no edge
      adx      1d -0.004/0.499   5d -0.004/0.502   21d -0.012/0.499   no edge

  **Compare the pre-rebuild (scaled-column) readings of the same factors at 5d: ret_5d -0.0519
  vs -0.051 now, adx -0.0052 vs -0.004, bb_pct -0.0541 vs -0.042, rsi_14 -0.0517 vs -0.038.**
  Nearly identical. The per-symbol affine transform reordered the cross-section in principle,
  but in practice preserved enough of it that these rank ICs barely moved — so **the caveat was
  warranted and the conclusion did not change**. Every clean-trend/overbought reading is still
  inverted; the platform's dominant 5d mean-reversion result stands, now on honest raw columns.
  Note `rsi_14` and `bb_pct` at 5d clear the `|rank_IC| >= 0.03` half of the bar while AUC stays
  at 0.485-0.488 — the same IC-real-but-AUC-stalls shape this file records for 7+ unrelated
  engines, in its inverted form.

  **⚠ QUALIFIED 2026-09-26 — these four readings were taken with NO LIQUIDITY FLOOR, so they
  overstate the effect on tradeable names by 30-45%.** Re-graded on >=Rs 1cr ADT (2024-01-01+,
  654-675 dates, 2,189 symbols): ret_5d **-0.040** @5d (not -0.051), bb_pct **-0.028** (not
  -0.042), rsi_14 **-0.022** (not -0.038), adx +0.003. At h=21 all three are ~0. The
  mean-reversion finding is real but is **concentrated in illiquid names and in the shortest
  horizon** — and on the liquid panel the strongest, most horizon-persistent columns are
  VOLATILITY (`atr_pct` -0.077 @21d) rather than reversal. See the 2026-09-26 Snapshot block.
  Both `mean_reversion_14` arms and the low-vol single columns have since been run through the
  cost-aware harness and are negative; the 23-column Bonferroni sweep has still NOT been
  individually re-run and keeps its tag.

- **[superseded by the entry above, kept for the record] `feature_store`-sourced readings were QUARANTINED pending a rebuild (AF-20260910-18 / -20).**
  Until 2026-09-10 that table stored per-symbol `RobustScaler` output for every numeric column,
  targets included — the stored label was `(raw - that symbol's median) / that symbol's IQR`.
  **230,572 rows held `target_ret_5d < -1`**, which a close ratio minus 1 cannot produce, and
  `rsi_14` (0-100 by construction) spanned **-4.09M to +6.23M**. Rank IC is cross-sectional and a
  per-symbol affine transform reorders the cross-section, so every `feature_store` factor reading
  graded the *self-normalized* column rather than the factor. Rebuild was running as of 2026-09-10
  18:00 IST (~62% complete when this was written). **Do not quote the `feature_store` rows in
  "Already tested" — including both `mean_reversion_14` arms — until they have been re-run.** The
  platform's mean-reversion finding itself is corroborated by non-`feature_store` routes and is
  **not** retracted; only these specific numbers are.

## Position sizing: FULL_ENGINE_COVERAGE is derived, not chosen (measured 2026-09-17)

`size_confidence_multiplier(strength, coverage)` shrinks a position by
`c = min(1, coverage / FULL_ENGINE_COVERAGE)`, where `coverage` is `len(present)`. AF-20260916-08
narrowed `present` from "engines with a row" to "engines with a NONZERO weight in the active
regime" — correct on its own, but the denominator was left hardcoded at **5** while only **4**
engines carry nonzero weight in ANY regime (screener/cs/dl/smart_money are all pinned 0.0).

**Measured on the live 2026-09-17 grid (1,893 rows):**

    active engines   rows    c=n/5   mult@q=1    c=n/4   mult@q=1
         4          1,698    0.80      0.900      1.00      1.000
         3             32    0.60      0.800      0.75      0.875
         1            163    0.20      0.600      0.25      0.625
    mean size multiplier @q=1:  0.8725 (FULL=5)   vs   0.9656 (FULL=4)

i.e. **89.7% of the book capped at 0.900 instead of 1.000, and mean size sat 9.6% below where it
belonged** — a platform-wide position-size cut nobody asked for, arriving as a side effect of a
coverage-COUNTING fix. This is `recurring-bugs.md`'s "restricting a universe upstream re-tunes
every absolute threshold downstream", in sizing form.

`FULL_ENGINE_COVERAGE` is now **derived** from `REGIME_WEIGHTS`
(`max(count of nonzero weights per regime)`), so re-enabling the PAUSED `dl` engine
(AF-20260913-05) cannot silently reintroduce the skew. Guarded by
`src/server/tests/test_engine_coverage_denominator.py`, negative-controlled (pre-fix
`size_confidence_multiplier(100, 4)` returns 0.9 against an asserted 1.0).

**This changes SIZING only, never the ranking.** The multiplier is applied after the blend and is
monotone in `coverage`, so it cannot reorder `unified_score` — no factor-backtest re-run is owed
for it, and none was run. Do not cite this entry as evidence about the ranker's edge.

## Accuracy comes from realized returns, never a proxy

- **Accuracy and win-rate must always be computed from actual realized returns vs. the actual system-generated signal — never from a proxy metric** (a job's "success" status, a promotion gate's CV/AUC number, a model's self-reported test score). Join the signal table (`unified_recommendations`/`unified_signals`/`intraday_recommendations`) against what the instrument actually did afterward (`stock_ohlcv`/`intraday_ohlcv`, or the already-graded `signal_outcomes`/`intraday_recommendation_outcomes` tables) and compute win rate as `WIN / (WIN + LOSS)` — decisive outcomes only, NEUTRAL/PENDING excluded — plus average realized return, never a single blended percentage. **Before trusting or comparing any win-rate number, check its `label_definition`** — `signal_outcomes.label_definition` has two structurally different conventions (`terminal_pct2`: strict fixed ±2% terminal barrier; `path_barrier`: path-based max-favorable-excursion) that are NOT comparable — the same calendar window read 88–91% win rate under one and 41–44% under the other, almost entirely the label, not skill. See [[topgainers_reverse_engineering_practice]].

## Reverse-engineer against what actually happened

- **Always validate via reverse-engineering against live data — never a code-only review.** Trace the claim against what actually happened: pull real top gainers/losers from `stock_ohlcv` and check whether the system's own pre-move signal called it correctly ([[topgainers_reverse_engineering_practice]]); grade a model's stored predictions against realized outcomes, never its own reported CV/test metric; re-run a fix against live production and query the result back, rather than stopping at `tsc --noEmit`/a green suite. This project has repeatedly found real, currently-active bugs this way that code-only review missed — e.g. tracing one symbol's absence through the live pipeline surfaced the RL gate silently excluding 825 symbols platform-wide.

## The panel spec (use this exact recipe, every time)

Any cross-sectional forward-return measurement on this data:

- **Per-date, then average. Never pooled.** Pooling has flipped or inflated a conclusion three separate times here — a pooled +0.798% became a per-date +0.098%, t=1.22. If a dramatic pooled number disagrees with per-date numbers, the pooled number is wrong.
- **Winsorise.** Raw means on `stock_ohlcv` are void: a +127,900% RELIANCE bar once produced an 850%-annualised phantom edge.
- **Filter `is_suspect = 1`.** ~425 quarantined bars; `ohlcv_quality.py` owns the flag.
- **Liquidity floor ≥ ₹1cr ADT.** Without it you are measuring microcaps you cannot trade.
- **Next-day OPEN entry, and treat any close-to-close IC as an upper bound.** Signals computed off a close cannot be bought at that close — `factor_edge.py`'s default grades close-to-close, and measured 2026-08-22 every IC it has ever produced overstates the honest open-entry number (h=1 by more than half: +0.045→+0.021; h=5 barely moves; h=21 loses −0.012). An `--entry open` mode now exists and should be preferred when available; where only close-entry numbers exist, discount h=1 hardest.
- **Check `label_definition` before comparing any two win rates.** `terminal_pct2` and `path_barrier` are not comparable — same calendar window, 41–44% vs 88–91%, almost entirely the label.
- **Read `factor_edge.py`'s `top50_exc` column, not just `rank_IC`/`hit_AUC`** (added 2026-09-26). A positive IC beside a negative `top50_exc` means the factor beats the median name and loses to the universe — the row prints `<-- median-beater` when that happens. It is a cheap pre-screen for the next bullet, not a substitute for the cost-aware run.
- **Ask which CENTRE an excess return was measured against before reading a rank IC as money.** `factor_edge.py` centres on the per-date **median**; `factor_backtest.py` benchmarks the equal-weight universe **mean**. Indian cross-sectional returns are strongly right-skewed (measured: universe mean 1.4532%/21d period over 2021-2026), so a factor that avoids the right tail can beat the median name — real, positive, well-powered rank IC — and still lose to the universe it is benchmarked against. Demonstrated 2026-09-26: a low-volatility composite read TEST rank IC +0.049@5d (eff 60.6, t=+10.71 at 21d, leak-checked) and its cost-aware arms read −0.53 to −0.94%/period net excess. **A positive rank IC is a claim about ordering, never about the book being worth holding** — the cost-aware run is not a formality after a good IC, it is the arbiter, and this is the clearest case in this file of the two disagreeing while both are correct.
- **Check `signal_source` before joining `signal_outcomes`.** Three writers share that table.
- **Decompose a "% of rows affected" figure by liquidity before believing it.** A defect reading 42% of rows read ~100% of the *tradeable* slice.
- **Judge any datasource by dates PER SYMBOL and by its DENSE span, never by raw `min(date)`/`count(DISTINCT date)` over the whole table.** A table can report years of span while being 4-5 rows per symbol. Run both: `SELECT min(n), median(n), max(n) FROM (SELECT symbol, count(DISTINCT date) n FROM t GROUP BY 1)` and a per-year distinct-date count.
- **Grade every candidate factor against BOTH tails**, not just AUC-vs-winners — an AUC computed only against winners cannot tell "predicts winners" from "predicts volatility" (this codebase has been fooled by that exact statistic three times now, most recently 2026-09-04's screener-tenure result below). Report AUC vs the winning tail, AUC vs the losing tail, AUC of one tail against the other.

## Standing architecture facts (still true — dates below say when each was last checked)

- **The ML training label is `triple_barrier`** (`signal_excursions.tb_label`, a cost-aware López de Prado barrier), not the old `path_barrier`-derived `horizon` label that inflated CV to 0.7664 by measuring the label's easiness rather than skill — the honest label gives CV 0.5203 at the switch, and the incumbent trained **2026-09-10 reports CV 0.5277** (`model_registry` id=322, **re-read live 2026-09-10**; supersedes the 0.5305/2026-08-29 figure this line carried, which had been overtaken by two retrains) — both matching live realized AUC (0.49–0.53). **Promotion gates on `factor_edge_history`, not just CV**: `model_promotion.py`'s `live_edge_verdict()`/`live_edge_is_unproven()` skip the CV-margin bar entirely when the label changed, and treat the incumbent's own realized `factor_edge_history` reading as the bar when it fails `|rank_IC|>=0.03 AND hit_AUC>=0.55`. A "never graded" column is NOT read as "no edge" (that would auto-override on zero evidence), and a reading under `MIN_DATES_RELIABLE=20` cannot override either.
- **`win_probability` has a real, small IC on a terminal-return grading, but it keeps decaying toward null as its panel grows, and AUC never clears 0.55** (last read: 2026-08-29, IC/AUC +0.020/0.500 @1d 57 dates, +0.065/0.510 @5d 53 dates, +0.084/0.523 @21d 37 dates — this itself is a decay from earlier reads, see `measurement-history.md`). Graded against its own real training label instead (`signal_outcomes`, `path_barrier`, decisive WIN/LOSS) it DOES clear `USABLE` at 1d/5d (AUC 0.617/0.600), but that is a same-shape base-rate artifact of the barrier construction, not proof of tradeable skill, and the cost/turnover-aware `factor_backtest.py` run still fails (5d/top-50/15bps: 7 periods, net +1.52%/period, t=1.54, not significant, 83.4% one-way turnover, 12.61%/yr cost drag). Two independent disqualifiers — do not trade this as scored today. **RE-GRADED 2026-09-10 (`--entry open`, persisted), and the decay continued: 5d rank_IC +0.056 / AUC 0.506 (64 dates), 10d +0.059 / 0.508 (59 dates), 21d +0.070 / 0.511 (48 dates) — `no edge` at every horizon.** The panel is now WELL-POWERED (all three horizons clear `MIN_DATES_RELIABLE=20`), so this is no longer a LOW-DATA caveat: it is a well-powered no-edge reading. Compare 2026-08-29: +0.065/0.510 @5d and +0.084/0.523 @21d — IC and AUC both fell again as dates were added, which is the same monotone decay this entry has recorded twice before.
- **`ml_breakout_probability`** (a sub-engine feeding `confluence_ml_engine.py`, native label = `signal_outcomes` WIN/LOSS h=7) clears `USABLE` outright — IC +0.082, AUC 0.553, n=44 dates (**last read 2026-08-29**). The strongest previously-ungraded result measured on this platform; has zero downstream readers today (advisory only), and has not yet had the cost-aware `factor_backtest.py` follow-up `win_probability` got. **The +0.082/0.553 figure is a NATIVE-LABEL reading and has NOT been refreshed since 2026-08-29.** A separate 2026-09-10 grading against the generic forward-return grid (`--entry open`, persisted — newly possible only because `factor_edge.py` could not read this table's `timestamptz` date column until that day's fix) reads **no edge at every horizon**: 5d +0.044/0.524 (48 dates), 10d +0.056/0.533 (43 dates), 21d +0.059/0.542 (32 dates), on a population that has grown to 73 dates / 5.88M rows. **These two readings do not contradict each other — they grade different targets**, and this file's own history records that grading an engine against the generic grid instead of its native label was the original first-pass mistake. The honest summary is: USABLE against its own label as of 2026-08-29, no edge against forward returns as of 2026-09-10.
- **`breakout_probability`** (native label = fwd-10d max return ≥ +6%) reads IC +0.153/AUC 0.583 at 19 dates against that native label (**last read 2026-08-29, still not refreshed**) — one date short of `MIN_DATES_RELIABLE` at the time. **Graded against the generic forward-return grid on 2026-09-10** (`--entry open`, persisted) it is now well-powered and reads **no edge**: 5d +0.001/0.505 (39 dates), 10d +0.023/0.506 (34 dates), 21d +0.024/0.516 (23 dates). Same caveat as `ml_breakout_probability` directly above — the native-label and generic-grid numbers measure different targets and neither refutes the other; what can be said is that nothing about this column predicts plain forward returns.
- **`breakout_classifier.py`'s feature set was extended with delivery/sector/options candidates and measured live 2026-09-02** — both testable candidates came back null, so `FEATURE_COLS` was left unchanged (still the original 22). Sector-relative return moved purged-OOF AUC 0.6130→0.6131 and held-out test AUC 0.6399→0.6402 — noise. Delivery% moved OOF AUC not at all. Options OI was judged too sparse to measure. Reproducible via `--sector-ablation`/`--delivery-ablation` if the universe/regime mix changes materially.
- **`movement_probability`** had a real train/serve-skew bug (fixed 2026-08-20; every value written before that date is tainted). Post-fix population: **15 dates as of 2026-09-10** (was ~11 on 2026-09-04, 7 on 2026-08-29), spanning 2026-08-20..2026-09-09 — still under the ~20-date floor, so still not gradeable. Re-check the exact count with a fresh join once you are about to grade it; the count above is a distinct-date read on the post-fix window, not the canonical harness's own matched-date output, which will be lower.
- **The IC-real-but-AUC-stalls-near-0.52 shape recurs across 7+ architecturally unrelated engines** (`win_probability`, `cs_score`, `ml_breakout_probability`, `prob_up_5d`@15d, the confluence composite, `engine_composite_scores`). Tested directly (Gaussian-copula simulation matched to each engine's measured IC): for most horizons the measured AUC is exactly what that IC mechanically implies — this is a property of the correlation magnitude at this sample size, not a fixable measurement artifact. Raising it needs IC ≥ ~0.15, not a better classifier or a different AUC threshold. The engines really are independent (max pairwise Spearman rho 0.29 on a z-scored panel) — the shared ceiling is not redundancy.
- **`_blend` normalizes all 8 engines onto the same 0–100 scale before averaging** (fixed 2026-08-22). `ZERO_DISPERSION_MIN_SD = 5.0` is calibrated for this 0–100 scale only — applying it to a raw 0–1 probability column (e.g. `win_probability`) will read nearly every engine as collapsed; this has already produced one confidently-wrong ablation result. **There is now also a per-engine override, `ZERO_DISPERSION_MIN_SD_BY_ENGINE = {"ml": 3.0}` (`unified_ranker.py:562`, read live 2026-09-10), which this file had never recorded** — so the global 5.0 is NOT the bar that applies to `ml`. Quoting 5.0 for `ml` inverts the verdict: ml's per-date sd over the last 10 ranker dates is 3.217-4.647, i.e. 10/10 collapsed at 5.0 and 0/10 at the live 3.0.
- **`calibrated_win_probability`'s 2–7 distinct-value collapse on days when the day's raw `win_probability` spread lands inside one isotonic step is NOT a defect — do not "fix" it.** Tested directly: tie-breaking within a collapsed band to restore raw ordering costs 23% of h=5 IC for +0.007 at h=21 — the collapse is the isotonic fit correctly discarding within-band ordering that doesn't predict at 5d. Monitored by `ur-engine-dispersion-collapse` (**warn >= 75%, fail >= 90%** — the "warns 60%/fails 80%" this line used to quote was itself the stale `dataQualityChecks.ts` comment corrected on 2026-09-05, contradicted three sentences later in this very bullet) and `ur-engine-score-zero-not-null`. **Last read 2026-08-29**: `ml`'s collapse rate over the last 10 ranker dates was 80%, and `dq:check` reported WARN not FAIL. **Resolved 2026-09-05 — there was no discrepancy to chase:** the 80% "documented fail threshold" came from a STALE COMMENT in `dataQualityChecks.ts` (it claimed warn 60 / fail 80); `evaluate()` has always used **warn >= 75%, fail >= 90%**, so WARN at 80% was correct behaviour. The comment has been corrected; the code was deliberately left alone, since this same file establishes that `ml`'s collapse is the isotonic fit working as intended and must not be "fixed". **SUPERSEDED 2026-09-10 — the check now PASSES at 0%.** Live read: *"ml 0%, dl 0%, technical 0% of last 10 dates (baseline 2026-08-22: dl 39%, ml 34%, technical 18%)"*, status `pass`. The change is not a change in ml's behaviour but in the bar applied to it — the per-engine `ZERO_DISPERSION_MIN_SD_BY_ENGINE = {"ml": 3.0}` override (see `_blend` entry above). ml's measured sd is 3.217-4.647, unchanged in character from the 2026-09-05 read; only the threshold moved. The substantive finding — that the banding is the isotonic fit working as intended and must not be "fixed" — is unaffected.
- **2026-10-15 dispersion follow-up:** raw-first ML still has sd above 3, but
  `edge_adjusted_probability` scales it by the measured calibration slope before persistence and
  the dispersion gate. The resulting 100% blend exclusion is real and remains in force; the
  monitor now names it as deliberate gating instead of falsely declaring the raw model dead.
- **Two population boundaries apply to `unified_recommendations`' reporting `*_score` columns and must be filtered on, never pooled across:** `2026-08-18` (zero-vs-NULL fix — before this date a `0.0` in `ml_score`/`dl_score`/etc. could mean either "engine scored zero" or "engine never ran," pre-fix rows must NOT be repaired/backfilled); `2026-08-23` (trading-day calendar-cutoff fixes — before this date `dl_score` was silently zero on ~5 of 8 Mondays).
- **Only TWO `technical_signals` columns have never been written, and neither is a bug** (re-counted live 2026-09-10): `fcf_yield` (0 rows) is droppable schema debris and `pledge_chg_90d` (0 rows) is calendar-blocked. **WAS -> "7 columns... `fcf_yield`/`created_at` are droppable schema debris". `created_at` is NOT never-written — it holds 41,726 rows across 20 dates**, so do not delete it as debris on the strength of this file. **The analyst trio (`eps_revision_3m_pct`/`target_revision_3m_pct`/`analyst_count_chg`) is no longer in this list** — its calendar constraint cleared on 2026-09-05 exactly as predicted, and the writer bug that was discarding the data was fixed the same day (see the Snapshot above and AF-20260905-20). First rows land 2026-09-08. `ccc_trend` is no longer in this list — it now has **86 dates** (live 2026-09-10) and **was graded 2026-09-06: negative at every horizon on a well-powered panel, no edge**. See the Snapshot above.
- **⚠ EVERY DL BiLSTM `roc_auc` recorded before 2026-09-10 is INFLATED and must not be quoted — including the 0.6493 below.** `dl_engine.walk_forward_validate` was not a walk-forward: it sliced a symbol-major concatenated panel by ROW POSITION, so each fold trained on ~40 stocks and tested on ~3 others over the SAME calendar dates. Measured live 2026-09-10 on the real validation panel (50 symbols, 59,702 sequences): **100% of test dates also appeared in the training slice from fold 1 onward**, across 28 folds, train and test both spanning 2021-03-31..2026-09-09, zero shared symbols. That is why this engine alone reported 0.6459-0.6578 against the 0.52-0.55 ceiling every other engine on this platform hits — the gap WAS the tell, and it went unread for weeks. Fixed 2026-09-10 (AF-20260910-08): date-grouped folds via `purged_cv`, purged by the 15-day label horizon, verified live at 5 forward folds with **zero** date overlap and a full 15-date purge on every fold. Fold seeding was fixed in the same pass (AF-20260906-02) — folds no longer start from weights already fit on their own test period. **No honest DL number exists yet**: the first one arrives from the next `dl-retrain-weekly`, and until then the correct statement is "ungraded", not any figure in `dl_model_config.json`. The stored numbers can no longer act as a promotion baseline either (AF-20260910-11). Related, same date: 10 rows in `dl_model_performance` (2026-08-27..2026-09-10, `model_version='lstm_v99'`) are a unit test's hardcoded `0.55/0.58` sentinel written into production, on an upsert key that excludes `model_version` and therefore REPLACED those dates' real rows (AF-20260910-10).
- **[superseded by the entry above — kept for the record]** **The DL BiLSTM's first real walk-forward AUC (0.6493, 2026-08-25) was rejected by the saturation guard** (`frac_saturated=0.536` > `MAX_SATURATION_FRAC=0.5`) — champion stays v3. The guard working as designed, not a bug. If saturation persists across future retrains, the next lever is label/loss-side calibration, not gate tampering. Check `model_registry` for a fresher BiLSTM row before quoting this as current — none had trained as of 2026-08-30 (a scheduler defect, since fixed).
- **`stock_futures_oi_history`** (F&O long/short buildup, rollover, basis) — `oi_change`/`oi_pct_change`/`oi_pcr`/`basis`/`rollover_pct` all still LOW-DATA at **14 dates as of 2026-09-10** (was 9 on 2026-09-04, ~3 on 2026-08-27), spanning 2026-08-21..2026-09-09. `oiBuildup` deliberately not graded — vendor text label. Re-check once ~20 dates accumulate; at ~1 trading date/day that is ~late September.

## Open / pending — re-check or act, ranked by how close each is to answerable

- **GRADED 2026-09-06 — all three came back NO EDGE. This item is closed; do not re-run it as
  "the highest-value task" again.** `factor_edge.py --entry open --persist`, results in
  `factor_edge_history`:
  - `smart_money_score` (unified_recommendations, `--date-col computed_at`): rank_IC **+0.004**
    /AUC 0.502 @1d, **-0.016**/0.488 @5d. Still **LOW-DATA at 18 usable dates**, not the 21 the
    Snapshot claimed — forward-price matching costs 3 dates, so "non-zero dates in the table" is
    not the same number as "dates the harness can grade". Consistent with the 2026-08-29 read.
  - `technical_signals.ext_*` (10 vendor columns): **every one "no edge" at 1d and 5d.** Best
    reading is `ext_t80_tech_score` at 21d — rank_IC **+0.185**, AUC **0.574** — but on only
    **17 dates**, under the floor. That is the one worth re-checking once it clears 20; treat it
    as a lead, not a result.
  - `ccc_trend`: **negative at every horizon on a well-powered panel** — rank_IC -0.006/-0.035/
    -0.042, AUC 0.496/0.491/0.488 at 1/5/21d across 64/60/44 dates. Not underpowered, just no
    edge (mildly inverted), which is the same direction as most of this file's other findings.
  - **Data-integrity finding from the same run:** `ext_mojo_quality_rank` and
    `ext_t80_quality_rank` are **100% identical, corr = 1.0** across all 28,584 rows — the same
    numbers stored under two vendor names. Two "independent vendors agreeing" on quality is one
    column counted twice. (`ext_is_overall_score`/`ext_is_percentile_rank` are corr 0.988 but a
    monotone transform of each other, which is why their rank-ICs match exactly — expected, not
    a defect.) See AF-20260906-06.
- **RE-MEASURED 2026-09-19 (automated daily sweep, close-entry on `unified_recommendations`):**

      confluence_score  5d +0.068/0.535  10d +0.107/0.558  21d +0.156/0.580
      technical_score   5d +0.027/0.513  10d +0.024/0.511  21d +0.013/0.504
      ml_score          5d +0.012/0.505  10d +0.024/0.508  21d -0.000/0.497
      dl_score          5d +0.007/0.504  10d +0.002/0.501  21d -0.011/0.494
      unified_score     5d +0.048/0.522  10d +0.068/0.537  21d +0.049/0.522

  All LOW-DATA (24/19/8 dates). Verdict unchanged: confluence carries the ranker and its edge
  grows with horizon. Regime split (2026-09-19 sweep + prior runs): SIDEWAYS and HIGH_VOL
  positive at all horizons (HIGH_VOL 21d +0.173/0.590 on 5 dates), BEAR negative at all
  horizons (5d -0.191, 10d -0.144, 21d -0.111 — LOW-DATA). No reweighting conclusion.
- **MEASURED 2026-09-10 — all four live engine scores graded together on `unified_recommendations` (`--entry open`, persisted). `confluence` is carrying the ranker and it is not close:**

      confluence_score   5d +0.084/0.542   10d +0.113/0.558   21d +0.168/0.583
      technical_score    5d +0.024/0.509   10d +0.017/0.506   21d +0.013/0.503
      ml_score           5d +0.021/0.503   10d +0.026/0.506   21d -0.013/0.500
      dl_score           5d +0.007/0.506   10d -0.008/0.496   21d -0.008/0.494

  **Every row is LOW-DATA** (18 dates at 5d, 13 at 10d, and only **2** at 21d — the 21d column is barely more than an anecdote and must not be quoted on its own). Two things worth noting and neither is yet actionable: `confluence_score` is both the strongest-reading engine AND already the highest-weighted one in `REGIME_WEIGHTS` (0.30-0.378), so this is consistent with the current weights rather than an argument to change them; and `dl_score` reads at or below zero at 10d/21d, which is expected given its walk-forward was only fixed on 2026-09-10 (AF-20260910-08) and no honestly-trained DL model has shipped yet. Re-run once the panel clears 20 dates under stable post-2026-08-31 weights (~2026-09-26/29) before drawing any reweighting conclusion. This supersedes the older "t=+2.13 at 1d on 12 dates" note for `technical`, which was never refreshed.
- **`earnings_beat_yoy`/`earnings_beat_qoq`, `screener_breadth`, the 3 named results screeners** — all underpowered (3–27 periods), genuinely calendar-blocked until ~12+ months of history exists in their source tables.
- **⚠ CORRECTION 2026-09-25 — this bullet and the Snapshot "models" bullet attributed the Pair's champion and rejected challengers to `cs_ranker`. They are `exit_policy`'s.** Live `model_registry`: `exit_policy` has 1 active row (id 312, trained 2026-09-01 12:34, `cv_roc_auc` 1.8021 = MFE holdout MAE, `cv_accuracy` 1.2761 = MAE holdout MAE) and 16 inactive (latest 2026-09-19) — those are the "champion 20260901_123532" and the rejected 1.9981/2.1444/2.0750/1.9907/2.0725 challengers below. **`cs_ranker` (LightGBM Regressor) has 35 registrations, ZERO active, latest 2026-08-29: it was deliberately deactivated and unscheduled 2026-08-31 (commit `9ceb4e72`, live CV 0.176, worse than random; `queues.ts:1622`, `jobRegistry.ts:248`), so it has no champion and no further retrains. `online_sgd` (95 registrations, 0 active, latest 08-30) was retired the same day (live AUC 0.5017).** Do not read "no active cs_ranker / online_sgd row" as a bug, and do not attribute the Pair numbers to cs_ranker. Original text follows unedited:
- **`cs_ranker` has had TWO further retrains since this was written, both REJECTED — and the metric this row quotes cannot be read out of `model_registry.cv_roc_auc` (checked live 2026-09-10).** The active `GradientBoosting Regressor Pair` is dated 2026-09-01 with `cv_roc_auc` **1.8021**; the two challengers since read 1.9981 (2026-09-06) and 2.1444 (2026-09-10), both `is_active = 0`. Those values are all **> 1, so they are not AUCs** — for this model type the column holds some error-style metric (lower better), which makes the rejections internally consistent (1.80 < 1.99 < 2.14) but means the "0.176 vs 0.161/0.161/0.133" figures in the original note came from somewhere else (they match the rho series recorded in `ml-model-bugs.md`, not this column). **Do not compare the two sets of numbers.** Still flagged, still not confirmed as a bug, and the underlying caution stands: a self-reported metric on a thin date-split holdout is exactly what this file says not to trust. 12 registrations existed for this pair as of 2026-09-10 (WAS count); **three more Pair challengers have been rejected since — 2.0750 (09-11), 1.9907 (09-14), 2.0725 (09-19), all `is_active=0`; champion still 20260901_123532 (1.8021)** — see the Snapshot models bullet. `model_registry` overall holds **343 registrations** (2026-09-20).
- **`win_probability` sub-population split** (grid-scored vs. pattern-fired via `signals_json IS NOT NULL`) has never been explicitly re-graded to confirm the two sub-populations behave the same way — flagged, not measured.
- **`mc_fno_eligible`/`mc_del_acceleration`** are cheaply derivable but deliberately not built — the risk was a formula silently disagreeing with the fetcher's own definition. Revisit if prioritized.
- **`engine_composite_scores` is FRESH as of 2026-09-20** — 121,892 rows across **84 distinct dates**, most recent 2026-09-18 (WAS -> 109,174 rows / 79 dates / 2026-09-10). Its producer runs weekly (inside `processMlWeeklyRetrain`) and this row has had reliability problems before (see `measurement-history.md`), so the standing advice is unchanged — check `job_heartbeat` before trusting freshness (but see the NEW 2026-09-20 heartbeat-integration-gap finding above: a NULL heartbeat row means unmonitored, not healthy) — but as of this check there is nothing wrong with it.
- **`dl_score` in `unified_recommendations_history`** IS stored (migration `1787110000000`, applied 2026-08-21) — do not re-derive that the column is missing. **Coverage corrected 2026-09-10: it is 96.1%, not 100%** (50,494 of 52,555 rows), and the earliest row is **2026-08-24**, not 2026-08-22. Blend-decomposition analysis is still unblocked for that window, but a ~4% hole means you must filter `dl_score IS NOT NULL` explicitly rather than assuming completeness — and per this file's own population-boundary rule, a NULL here is "engine never ran", not "engine scored zero".
- **`technical_signals.screener_momentum_score` reclassification effect** — **RE-GRADED 2026-09-10 and it NO LONGER CLEARS `USABLE`** — 21d now reads rank_IC **+0.172** / hit_AUC **0.532** on **42 dates**, against 0.217 / 0.552 on 33 dates measured 2026-08-29. The IC still clears the `|rank_IC| >= 0.03` half of the bar but the AUC has fallen **below the 0.55 half**, so the verdict is now `no edge` at every horizon (1d +0.037/0.500 on 62 dates, 5d +0.084/0.517 on 58 dates). **Do not cite the old "clears USABLE" framing.** This is the same monotone decay-as-the-panel-grows that `win_probability`, `breakout_probability` and `ml_breakout_probability` all showed in the same pass — on this platform a promising LOW-DATA reading has, so far, never survived reaching full power, but the 2026-08-29 screener reclassification's OWN effect is still genuinely calendar-blocked — needs ~20+ trading dates generated after 2026-08-29, of which **14 exist as of 2026-09-20** (WAS -> 8 on 2026-09-10, ~4 on 2026-09-04) — so ~6 more sessions, i.e. ~2026-09-29/10-06. Re-run `factor_edge.py --table technical_signals --scores screener_momentum_score --entry open` once that accumulates, filtering to post-2026-08-29 dates only.

## Already tested — re-run any of these anytime; here's what the last run found

These were measured on the 5-year price panel with the panel spec above. Re-testing one is
usually a single command and costs minutes, not days — the bar for re-running isn't high, it's
just "have something changed" (more history, a different horizon, a different construction,
different code). State that in one line and go; you don't need permission. Full derivation for
any row: `docs/measurement-history.md`.

| Factor | Result | Verdict |
|---|---|---|
| **`high_flyer_candidates` two-tail daily learner** (active equity, prior-20-session ADT >= Rs10cr, next-session open-to-close, NIFTY50-relative, 30bp costs) | Corrected walk-forward replay: 1,230 candidates / 41 dates; gross -0.2375%/day (t=-1.23), excess -0.1377% (t=-0.80), **net excess -0.4377%/day (t=-2.55)**. | **No edge; shadow-only.** Daily storage/learning continues, but the API withholds names until >=40 dates, positive cost-aware excess and t>=2.0. Winner-only and pooled-cross-section lifts are prohibited for promotion. |
| `momentum_12_1` | **Re-run 2026-09-26: net excess +0.7889%/period, t=1.61, 55 periods/4.58yr, 35.2% turnover, 4/5 years positive, CAGR 18.2%, Sharpe 0.75.** WAS -> +0.686%/period, t=1.45 (bit-identical across 2026-08-23/08-27/08-29). The drift is the panel growing, not a harness change — this run was used as the reproduce-a-known-result check before trusting the harness for the 2026-09-26 reversal re-runs, and the verdict is unchanged. (`factor_backtest.py --factor momentum_12_1 --rebalance 21 --top-k 50 --cost-bps 25`.) The older "+0.53%/mo, t=1.10" is stale and matched no reproduction. | still not significant, but the closest thing to a survivor among the price factors — note it is the only one whose turnover (35%) is low enough that costs are not the binding constraint |
| `value_book_to_price` | +0.78%/mo, t=1.99 (post-fix) | not significant; vendor history may be retrospectively restated |
| `insider_net` | net excess +0.29%/period, t=1.73 (re-run 2026-08-12, superseding the earlier +0.48%/t=2.05 which did not reproduce) | not significant |
| `momentum_21d` / `63d` / `reversal_21d` | negative, t up to −3.96 | dead |
| `high_vol` / `low_vol` | both negative (−1.21, −1.66) | **both tails lose**; the middle outperforms |
| `delivery_spike` / `delivery_trend` | t=−1.08 / −1.43 | dead |
| **`delivery_pct` (raw level, NOT the derived spike/trend above)** | quintile spread +0.19pp/day, t=+7.82 — but **long-only top-50 net excess −1.04%/period at 21d/25bps and −0.15%/period at 5d/15bps, t=−1.48 both** | **dead as a long-only factor** despite a real directional signal in the spread |
| `ticket_size` (institutional proxy) | −0.67%, t=−2.36 | significantly **inverted** |
| `smart_money` (`unified_ranker.py`'s live insider+block-deal+institutional-deal composite input) | Live-verified 2026-08-29: rank_ic=-0.000/hit_auc=0.502 (h1, 14 dates), rank_ic=-0.020/hit_auc=0.484 (h5, 10 dates) — trending toward zero/negative rather than positive. **GRADED 2026-09-06 and the verdict is NO EDGE, confirming the 2026-08-29 direction:** rank_IC **+0.004** / AUC 0.502 @1d, **-0.016** / 0.488 @5d (`--entry open`, persisted). Note the panel is **18 usable dates, not the 21 non-zero dates** the table holds — forward-price matching costs 3 — so it is still formally LOW-DATA. | **no edge (graded 2026-09-06); still LOW-DATA at 18 usable dates** |
| screener bullish consensus | IC −0.027, t=−2.36 | significantly negative; cleaning the labels made it *more* negative |
| `screener_breadth` | 5d/15bps top-50: −0.11%/period, t=−0.45 | not significant, low-power (9 periods) — re-test once ~12+ months exist |
| **every individual screener** (1,563, one at a time) | **0 survive FDR or Bonferroni** | population direction negative, sentiment labels inverted |
| 3 named "upcoming/recent results" screeners | 5d excess: +0.83%/t=1.76, +0.01%/t=0.02, +0.34%/t=0.59 | not significant, any of the three; too few dates to rule dead either |
| **`feature_store`** (23 candidate technical/fundamental/news columns) | **⚠ MEASURED THROUGH A KNOWN DEFECT (AF-20260910-18) — re-grade before quoting.** Until 2026-09-10 `feature_store` stored per-symbol `RobustScaler` output, not raw values, so every reading below graded the SELF-NORMALIZED column. Rank IC is cross-sectional and a per-symbol affine transform reorders the cross-section. Columns rebuilt raw 2026-09-10; re-run pending. **14 of 23 clear a 23-factor Bonferroni — all 14 negative** (stoch_d t=−9.28 worst). `rev_growth`/`eps_growth` 100% NULL — dead schema. | every clean-trend/overbought/high-volume reading is inverted — reconfirms the platform's dominant 5d mean-reversion finding via the full turnover/cost-aware harness |
| news sentiment | same-day +0.13 IC, next-day −0.03 | real but not tradeable — the move is over by the first entry you can take |
| `near_52w_high`, `low_beta`, `low_idio_vol` | insignificant | US-published factors that did not transfer |
| `low_max_ret` (lottery demand) | t=−3.12 | significantly **inverted** vs the published result |
| intraday (23 days, 256 configs) | best net at 15bps = −0.004% | edge exists in sign, smaller than costs |
| **`mojo_indigraph`** (MarketsMojo's own composite bullish/bearish call) | −0.08 to −0.14%/period, t=−0.15 to −1.26 | **no edge** — a vendor's standing directional call is not better than this platform's own |
| **sector-neutral (industry-relative) value & momentum** | every one worse than its raw parent; B/P +0.82→+0.46%/mo, t 2.08→1.12 | **rejected** — confound (smaller universe) ruled out with a registered control |
| `gap_down` (reconstructed, top-50/25bps/21d) | net excess −1.33%/period, t=−3.54, 1/6 years positive; 5d/15bps: t=−9.0 | **significantly negative net of costs** — ~90-93% one-way turnover is a turnover trap, not an edge |
| `gap_up` (same construction, control) | net excess −1.45%/period, t=−3.55, 0/6 years positive | **significantly negative net of costs**, same magnitude/sign as `gap_down` — both directions are the turnover trap |
| **`earnings_beat_yoy`/`earnings_beat_qoq`** (PEAD) | 5d/top-50/15bps: 3 periods, net excess −0.78%/period, t=−1.79 | **NOT significant, severely underpowered** — re-test once ~12+ months exist. `pead_score` (same family) graded separately: no edge at any horizon (1-21d), 37 dates, well-powered — AND has zero downstream readers; nightly schedule retired 2026-08-20 on that combined basis. |
| **`win_probability`** (factor-backtest construction) | 21d fails outright (calendar); 5d/top-50/15bps: 7 periods, net excess +1.52%/period, **t=+1.54, NOT significant**, 83.4% turnover, 12.61%/yr cost drag | **NOT significant** — see "Standing architecture facts" above for the full picture (real IC, AUC ceiling, cost drag: three independent disqualifiers). **The cost/turnover arm below has NOT been re-run since; only the IC arm was, on 2026-09-10, and it decayed further to +0.056/0.506 @5d on a now-well-powered 64-date panel.** Re-running `factor_backtest.py` here is the outstanding piece. |
| **`breakout_classifier.py` / `movement_predictor.py` / `cs_ranker.py` / `confluence_ml_engine.py`** | Graded against each model's own NATIVE label (not the generic 1/5/21d grid, which was the first-pass mistake): `breakout_probability` IC +0.153/AUC 0.583 (19 dates, LOW-DATA); `ml_breakout_probability` IC +0.082/AUC 0.553 (44 dates) — **clears USABLE**; `movement_probability` had a real leak bug, now fixed, genuinely ungraded again; `cs_score` no edge (correctly configured on the first pass) | See "Standing architecture facts" above for the 2026-09-10 re-gradings, which materially change two of these four. **Against the generic forward-return grid on 2026-09-10, `breakout_probability` reads +0.001/0.505 @5d (39 dates) and `ml_breakout_probability` +0.044/0.524 @5d (48 dates) — both now well-powered, both `no edge`.** Their native-label readings above are from 2026-08-29 and have NOT been refreshed; the two gradings measure different targets and neither refutes the other, but nothing here predicts plain forward returns. `ml_breakout_probability` is still next in line for a cost-aware `factor_backtest.py` pass. |
| **`screener_combo_finder.py --tier1`'s "capitulation" triple** (`gap_down AND open_eq_low AND top_loser`, next-session open→close, single day) | 430→658 signal-rows through 2026-08-20, spread +0.5064%/day net of 0.15%, **t=+3.48, p=0.0005**, clears the 41-combination Bonferroni bar, robust to winsorization and to dropping the top 3 most extreme days. 5/6 years positive (2026 YTD is the exception, thin partial year, t=−0.49 not significant). Reproduced bit-identical 2026-08-27. | **The one validated edge on this platform — but capacity-constrained, not scale-tradeable.** Median deployable capital ≈₹0.46cr/signal-day at a conservative 2%-of-ADTV convention (p90 ₹3.54cr); signals cluster at ~1/day (median), max 28 on one day. Real at small/personal/prop scale; do not build production infrastructure assuming it scales to meaningful AUM. |
| **screener CONCEPT-TAG membership as of D-1** (40 tags via `screener_name_concepts.decompose`, point-in-time from `screener_membership_snapshot`, top-20 daily gainers, 25 dates, `screener_tenure_mover_analysis.py`) | Winners-only: **8 of 40 tags clear a 40-tag Bonferroni** with large lifts (`mech_52w_high` 23.8% of gainers vs 10.6% of universe, t=6.70; `mech_overbought` t=6.43; `fund_growth` t=5.15). Graded against BOTH tails: **0 of 40 survive** — every one of the 8 lifts the LOSING tail as much or more (`mech_overbought` +13.7pp on gainers vs **+16.1pp on losers**; `flow_volume_surge` +7.9 vs **+12.5**; `mech_momentum` +8.8 vs +8.8, separation exactly 0.000). Best winners-minus-losers separation is `mech_52w_high` at 3.0pp, t=1.04. | **No directional edge — these are volatility detectors.** Screener membership predicts that a stock will MOVE, not which way, which is the same "AUC excellent and useless" shape `ml-model-bugs.md` records for `flyer_classifier`. Reproduces this file's standing finding by a new route. **The winners-only number is the trap**: it looks like a strong, multiply-corrected result and is entirely an artifact of selecting on the dependent variable. LOW-DATA (25 dates, just above the 20-date floor) but the both-tails collapse is not marginal. Tenure ("since when") inherits the same limitation — `tf_daily` t=-5.03 etc. says fresh entries MOVE, not that they rise. |
| **exit-target quantile head** (replace `exit_policy.py`'s `MFE_CAPTURE=0.6` haircut with a `GradientBoostingRegressor(loss='quantile')` MFE head) | Time-ordered embargoed holdout, 40k most recent `signal_excursions`, n_test=4,004. **The shipped constant is a median rule and is near-perfectly calibrated as one: `0.6 x pred_MFE` is reached 50.1% of the time (0.1pp off a true median).** Every quantile head is systematically OVER-optimistic -- claimed/actual: a=0.20 80%/74.5%, a=0.30 70%/62.9%, a=0.40 60%/52.2%, a=0.50 50%/41.5% (calibration error 5.5-8.5pp). At a MATCHED hit rate there is no gain: c=0.6 -> 1.37% median target @50.1%; a=0.40 -> 1.35% @52.2%. | **REJECTED — the constant wins.** The a=0.50 head does this constant's exact job 8.5pp worse. Capture/hit curve for any future retune: c=0.4->63.0%, 0.5->56.3%, 0.6->50.1%, 0.7->43.6%, 1.0->29.7%. Do not re-propose a quantile exit head without a new angle (different features, conformal wrapper, or a recalibration layer) — the appeal is real in principle and false on this data. |
| **`mean_reversion_14`** (sign-flipped composite of the 14 negative feature_store factors, standalone long factor) | **RE-RUN DONE 2026-09-26 on the rebuilt RAW columns, and the verdict FLIPPED from "not significant" to significantly NEGATIVE: 67 periods, net excess −0.9374%/period, t=−3.26, 0/6 years positive (every single year negative: 2021 −1.43, 2022 −0.65, 2023 −1.49, 2024 −0.90, 2025 −0.24, 2026 −0.99), 89.6% one-way turnover, 5.38%/yr cost drag, max DD −33.2%.** WAS -> "+0.044%/period, t=+0.64, NOT significant, 2/6 years positive" — that reading was taken through the AF-20260910-18 scaling defect and must not be quoted. **Also found 2026-09-26: the composite's SIGN SET is stale.** Its 14 columns were chosen from the 2026-08-12 Bonferroni sweep, run on the same defective scaled data; graded on raw columns at h=21 three of them are no longer negative — `vwap_dist_pct` **+0.043**, `volume_ratio_20d` **+0.023**, `stoch_d` +0.007 — so the composite shorts a column that now reads positive. Rebuilding it with fresh signs was deliberately NOT done: the lowest-turnover member of the whole family (`fs_atr_pct_inv`, 41.6%) already reads t=−1.78, so a re-signed 89%-turnover blend has no path to positive net. | **significantly NEGATIVE net of costs — do not trade, and do not rebuild.** Turnover is the mechanism: 89.6% one-way per 21d rebalance, independently reproduced at 88.1% by a separate top-50 membership-persistence count. Family closed. |
| **`fs_atr_pct_inv` / `fs_bb_width_inv`** (low-volatility, tested as single columns for the first time — 2026-09-26, via the new `fs_*_inv` harness entries) | `fs_atr_pct_inv`: 67 periods, net excess **−0.7932%/period, t=−1.78**, turnover **41.6%** (the lowest of the whole reversal/low-vol family), 2/6 years positive, CAGR 7.47%, Sharpe 0.67, max DD −18.6%. `fs_bb_width_inv`: 65 periods, −0.5361%/period, t=−1.55, turnover 83.5%, 1/6 years positive. Both have a real, well-powered, out-of-sample POSITIVE rank IC (atr_pct_inv +0.048 @5d on eff 60.6, +0.059 @21d, t=+6.96) — see the 2026-09-26 Snapshot block for why that coexists with negative net excess (median-centred IC vs mean-benchmarked backtest on right-skewed returns). | **NOT significant, and negative in sign — do not trade.** Worth recording precisely because the IC looked good: this is the cleanest example in this file of a factor with genuine, well-powered, leak-checked, out-of-sample rank IC that is still the wrong book to hold. It is also the family's best case — the low-turnover member — so nothing else in the reversal/low-vol family needs re-testing. |
| **`mean_reversion_14`** (as a VETO on `momentum_12_1`'s pool instead — 2026-08-30, re-run same day against the full backfilled 2021-2026 `feature_store` history) | **⚠ STILL MEASURED THROUGH THE AF-20260910-18 DEFECT — the standalone arm above was re-run 2026-09-26, this VETO arm was NOT.** Do not quote it. It is now doubly superseded: the standalone composite it vetoes on is significantly negative on raw data, so a veto built from it is ranking on a signal whose sign set is stale (3 of 14 columns flipped). Its defect-era numbers, for the record only: same-dates paired, 21d +0.27pp/period, paired t=1.50, n=54; 5d -0.01pp/period, t=-0.24, n=230. | **NOT significant, CLOSED, and the re-run is deliberately not owed** — the standalone arm's 2026-09-26 result (t=−3.26, 0/6 years) removes the hypothesis this veto was testing. Do not re-test without a genuinely new angle. |

| **bharat_alpha point-in-time features vs the top/bottom-20 forward movers, BOTH TAILS** (35 features, h=5, 271 NON-OVERLAPPING dates, `bqa movers`) | **31 of 35 would clear a 35-factor Bonferroni on WINNERS-ONLY; 14 of 35 clear on SEPARATION** (winners' mean cross-sectional percentile minus losers'). The winners-only survivors are dominated by volatility/illiquidity detectors that separate the tails by nothing: `atr_pct_14` t=+43.7 winners-only, separation −0.015; `vol_63` t=+43.5, separation −0.033 (both tails sit at the ~0.70 percentile); `vol_21` +41.7; `amihud_21` +28.7; `log_adt_20` −17.5 (both tails BELOW 0.5 — movers are small and illiquid, in both directions). **The asymmetry also runs the other way, which is the part the legacy study could not see: the single strongest directional feature, `close_loc_21` (separation −0.0703, t=−8.90), reads t=−0.60 winners-only** — the naive method discards it. Same for `deliv_pct` (separation **+0.0350, t=+4.56**, winners-only −1.90). Sign of almost every directional separation is NEGATIVE — winners ranked LOWER beforehand on `close_loc_21`, `vwap_dist`, `ret_5`, `rsi_14`, `dist_52w_low` — i.e. short-term mean reversion, reproducing this file's dominant 5d finding by a third independent route. | **Reproduces "screener membership predicts MOVEMENT, not direction" on a completely different feature set, and adds the converse: selecting on the dependent variable does not merely add false positives, it HIDES the true signal.** Directional content is (a) mean reversion — already known to be un-tradeable here, `mean_reversion_14` t=−3.26 net of costs on 89.6% turnover, and the h5 gate reproduced it exactly (gross 0.257%/period vs 0.272% cost) — and (b) **`deliv_pct`, the one directional separator that is neither a volatility detector nor mean-reversion**, independently the strongest ablation group (ΔIC +0.0098, t=6.53, on just 3 features). Delivery is slow-moving, so it does not carry the turnover penalty that kills the rest. **That is where to look next; do not re-run a winners-only version of this study.** Harness is `bqa movers` (`evaluation/movers.py`), negative-controlled in `tests/test_movers.py` — a synthetic pure-volatility detector must light the winners-only statistic and score ~0 separation, and swapping the verdict to the winners-only column makes that test fail. |

## Not testable — do not spend time here without a genuinely new angle

- **⚠ `fundamentals_history.return_on_equity` DECAYED to 6.1% and the row below does not say so
  (measured 2026-09-18, AF-20260917-07).** Per-as-of-date non-null symbol counts: **1,928/2,229
  (86%) on 2026-07-02 -> 1,443 (65%) 08-03 -> 1,092 (49%) 08-09 -> 476 (21%) 08-16 -> 151 (6.1%)
  from 08-23 onward.** The table stayed fresh daily throughout, so no freshness check fired. The
  cause is upstream and provable in one query rather than by reading the fetcher:
  `fundamentalsSyncService.ts` reads `debtToEquity` and `returnOnEquity` from the SAME
  `financialData` object in the SAME Yahoo response, and d/e still reads 85% -- so parsing and auth
  are fine and the vendor field itself stopped coming back.
  **Do not grade anything on `roe`, `feature_store.roe`, or any percentile rank derived from them
  across this window without filtering on the date.** `institutional_quant_engine.py`,
  `multi_factor_scorer.py` and `quantScoringWorker.ts` all `pct_rank` this column, so from ~08-23
  they have been ranking ~151 names out of ~2,474. **2026-08-23 is a population boundary** in the
  same sense as this file's 2026-08-18 zero-vs-NULL and 2026-08-23 calendar-cutoff boundaries: do
  not pool across it.
  **A clean replacement exists and is now collected, but is NOT yet wired into features.**
  `investsights_fundamentals_history.return_on_equity` measures **Pearson 0.9608 against the
  yfinance value, same fraction scale, ZERO sign flips**, and its fetcher's `--limit 300` cap (the
  real constraint -- not the vendor) was lifted on 2026-09-18 after measuring 1000/1000 symbols in
  129s with zero failures; stored coverage went **287 -> 929 symbols** on one run.
  **Note the near-miss, because it is the reusable part:** the sibling table
  `investsights_factor_scores.roe` is a DIFFERENT ROE definition -- Pearson 0.7727, percent scale,
  outright sign flips -- and was measured first and wrongly reported as "the" investsights ROE.
  Two tables from one vendor, two definitions. `information_schema.columns WHERE column_name
  ILIKE '%roe%'` enumerates all four candidates in a second; do that before concluding no
  alternate exists. Monitored since 2026-09-18 by `fundamentals-history-vendor-field-decay`
  (`dataQualityChecks.ts`), which reads per-field FILL RATES rather than a table timestamp and was
  verified to discriminate: FAIL on ROE 6.1%, pass on debt_to_equity 85.2% / operating_margins
  97.0% / piotroski_f_score 97.3%.

- **Fundamentals, analyst, ownership and earnings factors**: still calendar-constrained, but **re-counted live 2026-09-10 — `fundamentals_history` now holds 56 distinct dates (2026-06-30..2026-09-09) across 2,232 symbols, not the ~30 this line used to claim.** Still only 1-2 independent quarterly observations, so the constraint is unchanged in substance. **A backfill route now exists and is worth costing before waiting another quarter:** `trendlyne_pe_history` holds **4.16M rows back to 2013-12-24**, with **2,997 distinct dates across 1,940 symbols BEFORE `fundamentals_history` even begins** (`trendlyne_pb_history` is comparable at 4.21M rows). `_merge_fundamentals` already does a correct point-in-time `merge_asof`, so the machinery is in place. **The one thing to verify first:** vendor valuation history can be retrospectively restated, which would inject look-ahead into a point-in-time join — check a known historical snapshot against an independent source before building on it. This is the single largest available unblock in this section.
- **FnO / positioning (long/short buildup, short covering)**: built (`mc_stock_futures_oi_fetcher.py`, `stock_futures_oi_history`, composite-keyed `(source, symbol, date, expiry)`, scheduled daily, live-graded LOW-DATA at **14 dates as of 2026-09-10**, was 9 on 2026-09-04) — see "Standing architecture facts" above. Not yet enough dates to verdict; ~6 more sessions to the floor.
- Of 60 symbol+date tables audited 2026-08-11, only 9 have enough history to test anything at all; the other 35 start ~2026-06-30.
- **REGIME_WEIGHTS re-check, 2026-08-25**: `blend_walkforward.py` re-run across all 46 available sessions — TILT alternative still fails its pre-declared bar (dIC −0.0003). Weights confirmed unchanged. **Live-reverified again 2026-09-10**: `screener`, `cs` AND `smart_money` are all still 0.0 in every one of the five regimes — a validation, not an improvement, do not cite it as one.
- **`technical_signals.date` is TEXT→DATE** (migration `20260825120000`, applied via a manual single-statement rerun after node-pg-migrate's sql-file runner silently executed only the file's first statement). Writers unaffected; `db/schema.postgres.sql` updated so new throwaway test schemas get DATE natively. A migration's ledger row proves execution of *a* statement, not necessarily the one you meant — verify the effect via `information_schema`, never the tool's exit code alone.

- **2026-09-30 — `unified_ranker` 30-day bound on `confluence_signals` reads (AF-20260930-11): measured
  score-neutral on live data.** Cost map (`_compute_cost_map` atr): of 1,840 ranked symbols, 1,716
  have a non-null atr inside the window; the other 124 have **no non-null atr in any older row
  either**, so old and new code both fall back to `cmp*0.02` — identical cost for all 1,840, so no
  `unified_score` moves. Entry-target map: 1,827/1,840 ranked symbols have a row in the window; the 13
  outside (KOTAK, LARSEN, NESTLE, INDUSIND, VODAFONE, BAJAJINSUR, CENTRALBANK, CHOLAFINSV,
  JIOFINANCIAL, LTFH, NIFTYBEES, POLICYBAZAAR, SHINDL) now take trade levels from the rec_log /
  unified_signals tiers instead of >30-day-old confluence levels — geometry only, not score. Also
  measured: `atr` is ~50% NULL, so an unbounded `atr IS NOT NULL ORDER BY computed_at DESC LIMIT 1`
  per symbol walked the full compressed history for every always-NULL symbol.

- **2026-10-08 — the first honest win rate on published signal geometry, computed from real exit
  prices (AF-20261008-08/-10).** Previously impossible: the scheduled `stuck-signal-resolver` wrote
  `status` alone, so 114,749 terminal `unified_signals` rows carried a COMPLETED/FAILED verdict
  with **no `exit_price`, `closed_at` or `exit_reason`** — only 3,700 of ~119,000 (3.2%) had been
  closed by `signal_lifecycle.py`, which stamps all four. The resolver now records the exit it
  already computes, and `data_integrity_repair.py --signal-exit-evidence` back-stamped the rest
  (99.73% of re-derived verdicts matched the stored one, so this recorded evidence rather than
  re-grading; 307 disagreed and were left alone).
  **Measured live over 125,675 closed signals with real exit prices, direction-aware, net of the
  0.30% round trip (`ROUND_TRIP_COST_PCT`):**

      side                          n       win%    avg net ret   target   stop    time
      LONG  (tradeable)        90,653     35.86%     -0.739%      34.0%   62.0%    4.0%
      SHORT (not tradeable)    35,022     47.31%     -0.038%      39.4%   50.0%   10.6%

  - **The tradeable long book wins 35.9% of the time and loses 0.74% per signal after costs.**
    This is the platform's own published stop/target geometry graded on the prices it actually
    exited at — not a factor IC, and not a proxy label.
  - It **independently agrees with the ranker-plan replay** taken the same day (AF-20261008-02:
    −0.62% per plan, 26.5% target / 62.1% stop, over the 4,866 plans `unified_recommendations`
    published). Two different corpora, two different methods, same conclusion — which is the
    reason to believe either.
  - The SHORT side is reported only to show it was being measured; this is a cash-equity
    long-only platform (`unified_ranker.py`'s "longs only"), so those 35,022 rows are not a
    tradeable result.
  - **Not a factor verdict and not date-corrected**: these are overlapping windows across ~4
    months, so no t-statistic is quoted and `factor_edge`'s effective-date gate is not cleared.
    What it does establish is the SHAPE — stops are hit ~1.8x as often as targets on the long
    side — which is a property of the geometry, not an estimate of forward return.

- **2026-10-08 — `unified_signal_outcomes.return_pct` is a LONG-only simulation applied to every
  signal, so 139,579 short-direction rows carry the wrong sign (AF-20261008-10).**
  `outcome_resolver.simulate_exit`'s own docstring reads "Bar-by-bar **long-trade** exit
  simulation", and `_resolve_unified_batch` calls it for every row regardless of direction. A
  Bearish signal has its target BELOW and its stop ABOVE entry, so the long logic reads both
  levels inverted. Measured live:

      signal_type  outcome      n         avg return_pct
      Bullish      STOP_LOSS   32,253        -5.866     <- correct for a stopped-out long
      Bearish      STOP_LOSS  115,731        +4.427     <- a LOSS recorded as a +4.4% gain
      Bearish      WIN          3,571        +7.405

  `return_pct` tracks the raw price move in every bucket (±0.3pp), confirming no direction
  adjustment and no cost netting anywhere in the column.
  **Blast radius is contained and that is why this is a finding rather than an incident:** grep
  across `.ts`/`.py` finds no trainer, scorer, ranker or report reading this table — the only
  references are two `dataQualityChecks.ts` checks and the ontology bindings. `ml_ensemble.py`
  trains on `signal_outcomes`, a different table. So this is a corrupt measurement store, not a
  live decision input. **Fixed and re-graded the same day:** `simulate_exit(direction=...)` mirrors the short side and
  `_resolve_unified_batch` derives direction from geometry (target < stop). After the `ml-api` restart the whole
  table was re-graded; live: Bearish STOP_LOSS avg `return_pct` +3.05/+4.4 -> **-5.25** (Bullish -5.87), short-geometry
  rows h1 +0.07 / h5 +1.49 / h15 +2.63 (were ~+5.0). Rows are still gross of the 0.30% cost beyond `net_return_pct`'s
  own netting and overlapping across horizons, so quote the `unified_signals` exit-price table above for win rates.

- **2026-10-08 — `unified_ranker` tier-3 geometry bound + the price-sanity gate (AF-20261008-01):
  measured score-neutral, label-affecting on 2.8% of published Buys.** `_get_entry_targets`'s third
  geometry tier (`unified_signals`) was the only one with neither a 30-day window nor a status
  filter, and no tier compared its levels against the current price. **No score, weight, threshold
  or engine input is touched** — `plan_is_current` reads only the plan's own stop and target, so
  there is nothing calibrated here and `unified_score` cannot move. What changes is the
  CLASSIFICATION of rows whose plan is dead, via the existing `actionable_without_plan_veto`
  (Buy → Hold).
  Measured live on the published 2026-10-08 grid (read-only replay of the old and new SQL plus the
  real `plan_is_current`, `scratchpad/verify_af01.py`):
  - tier-3 eligible symbols **2,438 → 1,123** (1,315 dropped). Of the 96,440 long-type
    `unified_signals` rows previously eligible to supply geometry, only **7,160 were ACTIVE**
    (48,601 FAILED / 27,752 COMPLETED / 10,954 EXPIRED / 9,133 INVALIDATED_CONFLICT).
  - **9 of 316** Buy/Strong Buy rows with a plan lose it and become Hold (**2.8%**); 307 unchanged
    (confluence 228, rec_log 34, unified_signals 43).
  - 7 lost to the status/date bound, all tier 3: PYRAMID, ZSARACOM, MODINATUR, CAPITALSFB
    (**Strong Buy, score 94.52**), NAHARSPING, PARKHOSPS, TINNARUBR.
  - 2 lost to the price gate, both tier 2 (rec_log): SURAKSHA close 321.70 vs stop 328.21,
    UNOMINDA close 1,104.80 vs stop 1,116.36 — both already through their own stop.
  - The worst pre-fix case, MODINATUR: published Buy, zone 387.44-395.26 / stop 362.93 / target
    438.71, every number copied from a 2026-08-07 `AI` signal whose status was already **FAILED**,
    while the stock closed at **299.60**.
  **2.8% is the honest size of this and it is not an edge claim**: whether those 9 rows would have
  lost money is a different question, and the plan-outcome panel that could answer it does not exist
  yet (AF-20261008-02). The gate is justified by arithmetic, not by a backtest — a plan whose stop
  the market has already closed through is not available at the price it quotes.
  **Deliberately NOT changed here:** how far the last close may drift from the entry ZONE while
  still inside stop..target. That is a threshold and needs the measurement in AF-20261008-02; live,
  21% of confluence-tier Buys close outside their own ±0.25-ATR zone at a mean drift of 0.39%, which
  is the zone being narrow, not the plan being stale.

- **2026-10-04 re-grade batch (`factor_edge`, open-entry panels, persisted to `factor_edge_history`, run_at 2026-10-04T20:28-20:29).
  Supersedes the 2026-09-26 `basis` reading above — `basis` is NO LONGER `USABLE`.**
  - `basis` 1d on the 25-date panel (eff 25.0): rank_IC **+0.064**, AUC 0.532, top-50 excess +0.129%, t_eff 1.84 → verdict **`no edge`**. The
    2026-09-26 `+0.1355 / USABLE` (22 dates) decayed as the panel grew; `+0.139 / 0.565` (17 dates) was the small-sample peak. `basis` 5d +0.004
    (21 dates, eff 4.2) is a median-beater (+IC, top-50 loses to the universe mean). **Do not cite basis as the platform's one usable factor.**
    `oi_change`/`oi_pct_change`/`oi_pcr`/`rollover_pct` 1d are all `no edge`. (A basis cost-adjusted test, AF-20261003-05, is lower priority now.)
  - Engines, 37-date panel (2026-08-10..10-05), every horizon still `LOW-DATA` (eff 0.8-6.2): `unified_score` 5d IC +0.047 / t 2.03; `confluence_score`
    the strongest (21d +0.143 but eff 0.8); `technical_score` and `dl_score` ~0 and `technical_score` 10d/21d are median-beaters; `ml_score` ~0.
    Nothing here clears the eff-date gate, so none is evidence of edge — the positive ICs are the same overlapping-window inflation as factor_edge
    Overlap Correction.
  - `ext_t80_tech_score` 5d +0.053 / 10d +0.087 / 21d +0.153, 51 dates but eff 10.2 / 4.6 / 1.7 → `LOW-DATA`; promising and unproven.
  - `screener_momentum_score` post-reclass (since 2026-08-31, 21 dates) 1d IC **-0.023**, AUC 0.486 → `no edge`, negative sign.
  - Analyst revision trio is still at 18 dates (< `MIN_DATES_RELIABLE`=20): not gradeable before ~2026-10-08.

- **2026-10-05 — `signal_type_priors` 15% blend REMOVED from `scoring_engine.py` (AF-20261001-47).** Test: for each technical signal type with >=100 graded outcomes since 2026-08-15, rank-correlate its stored Beta posterior mean with the mean realized `return_pct`. h5: 10 types, prior range 0.51-0.75, Spearman +0.236 (p=0.51) mean / +0.382 (p=0.28) median; h15: 9 types, -0.200 (p=0.61) / -0.433 (p=0.24). No relationship and the sign flips between horizons; the top-prior type (PCR_EXTREME, 0.67) realizes -1.64% (h5) / -4.02% (h15). The posteriors have counts in the 10^5 (EMA_BULL_STACK 223,120/161,168), so they shrink nothing - they are each type's frozen win rate under the path-barrier label, which this file records as a volatility detector. `SIGNAL_TYPE_PRIOR_WEIGHT = 0.0`; guarded by `test_scoring_signal_type_prior_blend_off.py`. This is a removal of an uninformative input, not a reweighting toward an edge.
- **2026-10-05 — technical outcomes are overwhelmingly universe-wide labels, not trades (AF-20261001-13).** Since 2026-09-01, of graded h5 `technical` outcomes 36,506 carry signal_score 0-1 (no setup), 2,475 score 2-4, and **none reach 5** (the scan's actionable bar); avg return -1.26% / -0.76% for those buckets (median -1.89% / -1.40%). The 21,374-STOP_LOSS-vs-3,241-WIN September figure is the market's own drift over a down tape applied to every symbol, not signal skill. Score 2-4 beats 0-1 by ~0.5pp at both horizons (monotone but both negative in absolute terms; excess vs the universe not yet computed). Trade-performance statistics must filter to published setups (score >= 2 with levels); the universe-wide rows remain a calibration/benchmark dataset and feed the RL gate, which is a trend-negative filter in practice (it is why RELIANCE/TCS/INFY are absent from the latest ranking).

- **2026-10-05 — AF-20261003-08 experiments 1 and 10 RUN (experiment 6 calendar-blocked; 3 and 8 not yet built).**
  - **Experiment 1 — does the mean-reversion arm depend on regime? Harness: `factor_backtest.py --by-regime` (new).** Regimes are rule-based and point-in-time (Nifty close vs its 200-session mean x 20d realised vol vs its trailing-252 median; first 199 sessions unlabelled), NOT the stored `market_regimes`, because 681 of its 729 rows were written by one 2026-08-09 backfill from an HMM fitted on the full history - conditioning a historical result on those labels leaks the future. Periods are disjoint, so each regime's `periods` is an honest N. `mean_reversion_14`, top-50, 25bps/side, 2021-01-01..: **21-session cadence** (67 periods, net excess -0.836%/period, t=-2.95, 1/6 years positive): UP-LV 24 periods -0.891% t=-2.56; UP-HV 18, -1.413% t=-2.02; DOWN-HV 11, +0.321% t=+0.51 (LOW-DATA); DOWN-LV 4, LOW-DATA. **5-session cadence** (283 periods, -0.425%/period, t=-6.58, 0/6 years positive, 18.9%/yr cost drag): UP-LV 101, -0.411% t=-4.15; UP-HV 78, -0.508% t=-3.73; DOWN-HV 45, -0.022% t=-0.13; DOWN-LV 21, -0.337% t=-1.86. **Verdict: no regime rescues the long-only reversal book.** It is significantly negative in both UP regimes at both cadences and merely break-even (no edge, wide error bars) in the one regime where reversal is plausible - a high-volatility sell-off. That regime has only 45 five-session periods, so a conditional "buy reversals only in DOWN-HV" idea is unproven and, at ~75% one-way turnover, would still have to clear costs it does not clear today. Family stays closed; revisit only DOWN-HV as a conditioning variable if its periods reach ~100.
  - **Experiment 10 — duplicate-information census** (mean per-date cross-sectional Spearman, last 30 `technical_signals` dates joined to `feature_store`, 196 numeric columns with >=60% coverage): **effective independent columns = 16 of 196** (participation ratio; 67 components for 90% of variance); 91 pairs have |rho|>=0.95, 228 have >=0.80, 1,062 of 19,110 have >=0.50; 17 redundancy clusters at |rho|>=0.90 cover 67 columns (largest 12, 12, 8). Within-group mean |rho|: `ext_*` 0.22 (vendor columns are mostly independent of each other, apart from the exact duplicates below), `dvm_*` 0.21, `screener_*` 0.34. Exact duplicates found: `ext_t80_financial_pts` = `ext_mojo_financial_pts` (29,219/29,219 rows; known - MarketsMojo reissues Trading80, AF-20260906-06), `ext_is_overall_score` ~ `ext_is_percentile_rank` (monotone), `stoch_k` ~ `williams_r` (algebraic), `ts.mc_ma200_dist_pct` = `fs.dist_sma200_pct`, `ts.rs_rank_21d` = `fs.ret_21d`'s rank, and the price-level family (`cmp`, `sma*`, `ema*`, `bb_*`) which are rank-identical by construction. **New defect found: `technical_signals.pcr_vol` == `pcr_oi` on 35,887/35,887 recent rows** - it was filled from `stock_options_oi.market_pcr`, which equals `pcr` (3,620/3,620) because that source has no volume ratio; fixed to NULL (AF-20261005-07). **Consequence for modelling:** the feature matrix carries ~16 independent signals, so adding another correlated vendor column is near-free noise; a model's apparent breadth is mostly the same few ideas (price level, momentum, volatility, valuation, flows).
  - **Experiment 6 (index PCR / F&O state as a conditioner) is calendar-blocked:** index PCR history starts 2026-06-30 (73 sessions) against a 2021 backtest window; it cannot condition older periods. At 5-session cadence ~20 periods exist around 2026-11-20. **Experiments 3 (capitulation x mean-reversion overlap) and 8 (sector RS incremental IC)** need a name-level join / a sector-RS series that are not built; not improvised.

- **2026-10-06 — FROZEN FORWARD TEST and selective-accuracy report started (`forward_test_report.py`, AF-20261006-03).** Protocol hash `13210b4e2c3ae688`, frozen in `app_settings['forward_test_protocol']` on 2026-10-06 (the script exits 2 on drift; change a rule only by starting a new protocol version). Rules: calls = each symbol's LATEST `unified_recommendations_history` row published before the entry open (pre-09:15 IST publications enter that morning); entry next session open, exit N sessions later at the open; horizons 5/10/21; ranked names with >= Rs 1cr trailing-20d ADT; per-date 1/99 winsorised forward returns; 25 bps per side charged to every call; benchmark = equal-weight mean of the same universe on the same dates; coverage tiers top 1/2/5/10/25/50/100% by `unified_score` plus the calls as published (Buy/Strong Buy); uncertainty = dates/h independent windows, LOW-DATA below `MIN_DATES_RELIABLE`. A "hit" is a call that beat the universe mean AFTER costs; `lift` is hit rate minus a random pick's hit rate (right-skewed returns put chance near 38%, not 50%). Runs nightly as the last step of `ml-daily-ops`; snapshot in `app_settings['forward_test_report']`, watched by `forward-test-report-freshness`. **No call dated on or after 2026-10-06 has a closed window yet; nothing here is evidence.** When it can speak: 5d reaches 20 independent windows at ~100 sessions (about late Feb 2027), 10d at ~200 (mid 2027), 21d at ~420 (2028) - so judge the ranker on the 5d horizon first and do not wait for 21d.
  **Retrospective block (informational, NOT the forward test; since 2026-09-01, 22 sessions, 42,347 calls, every row LOW-DATA, eff 3.4 / 1.2 / 0.0):** 5d, top 5% (63 calls/day): hit 0.462 vs random-pick 0.382, lift +0.080 +-0.071, net excess +0.10%/period (t_eff 0.29); top 1%: hit 0.448, lift +0.066, excess +0.00%; as-published Buy/Strong Buy (171 calls/day): hit 0.451, lift +0.069 +-0.037, excess -0.04%. 10d top 1%: hit 0.519, lift +0.136, excess +1.10% (eff 1.2, anecdote). Reading: the top of the ranking picks winners more often than chance (lift +0.07 to +0.14) but the margin is about what 50 bps of round-trip cost absorbs at 5d; holding everything returns exactly -cost by construction. Consistent with the ranker's IC ~0.05 and with `factor_edge`'s LOW-DATA verdicts; it moves nothing until the windows accumulate.

- **2026-10-08 — the plan geometry is a null lever: moving the intraday target, or rescaling the swing
  and positional stops and targets, changes the hit rate but not the net return (AF-20261008-03/-04).**
  Both replays are cost-aware (0.30% round trip), stop-first when one bar touches both, and were first
  checked against stored outcomes: `intraday_target_replay.py` reproduces LONG target 5.5% / stop 14.5%
  against the stored 5.6% / 14.2%.
  - **Intraday, 13,168 LONG / 2,165 SHORT trades (2026-07-17..10-07).** `intraday_ranker` uses 1.0 daily-ATR
    target and 0.6 stop (the ledger's earlier "2.5 / 1.5" was wrong). Target at x1.0 / x0.75 / x0.5 / x0.25 of
    its distance: hit 5.5 / 10.4 / 20.8 / 42.8%, net **-0.407 / -0.406 / -0.407 / -0.452%** (LONG);
    SHORT -0.449 / -0.445 / -0.456 / -0.503%. A nearer target wins more often and earns less per win, so
    expectancy does not move. The loss comes from the entries and the cost.
  - **Swing / positional plans (`plan_outcome_report.py`, 2026-08-01.., overlapping, no ADT floor).**
    SWING net -0.595% as published; stop and target x0.866 -0.619, x0.75 -0.585, x1.25 -0.594, target x0.5
    -0.556. POSITIONAL -0.634% as published; x0.866 (what aligning HOLDING_SESSIONS 20 -> 15 would do) -0.643,
    x0.75 -0.685, x1.25 -0.521 (n=665). Every variant sits between -0.52% and -0.69%.
  - **Consequence.** No stop or target multiple, and not the 20-vs-15 session mismatch, has evidence behind
    changing it; none was changed. Both are shapes on overlapping dates and are not edge claims. The only
    thing the replays do show is that a Buy plan loses roughly 0.6% net per plan at every geometry tried, which
    is `unified_score`'s standing verdict seen through the trade plan.

- **2026-10-08 — end-to-end expert review, retrospective on the published ranking (LOW-DATA; the frozen forward test still has no closed window).**
  Source `unified_recommendations_history`, 40 sessions 2026-08-10..10-07 (all of it a falling tape: Nifty 24,571 -> 22,603, -8%; regimes BEAR 6 / HIGH_VOL 6 / SIDEWAYS 31 dates), each symbol's latest call
  published before the entry open, next-session OPEN entry, per-date 1/99 winsorised forward returns, benchmark the equal-weight mean of the same liquid set. Scripts: `retro_scorecard.py`,
  `beta_check.py`, `engine_ablation.py` (review scratchpad, reuse `forward_test_report` helpers; PROTOCOL untouched).
  - **Rank IC of `unified_score`, mean per date:** Rs1cr 5d +0.058 (35 dates, 7 non-overlapping windows) / 10d +0.084 (31, 4); **Rs10cr 5d +0.052 / 10d +0.069**; **Rs50cr 5d +0.043 / 10d +0.051 / 21d +0.010 (20 dates, 1 window)**. Non-overlapping subsamples read higher
    (Rs10cr 5d +0.066, t 3.66 on 7 windows) but 7 windows in one down-tape is a sample of one regime, not power: **the binding limit is regime coverage, not statistical power**.
  - **Top-decile net excess vs the universe mean, 5d, Rs10cr:** +0.15%/period at 0.30% round trip (+0.31% non-overlapping, t 1.84, n=7), **-0.05% at the frozen 25 bps/side**; hit rate 45.7% vs a random pick's 40.4% (lift +5pp).
    Published Buy/Strong Buy set (~100 names/date): +0.13% at 0.30%, -0.07% at 0.50%. 21d has one independent window and says nothing.
  - **It is not a liquidity, volatility or momentum artifact, but it IS partly a low-beta tilt.** corr(score, log ADT) +0.17, corr(score, 5d momentum) +0.15, corr(score, beta) -0.16. IC after residualising on ADT/ATR/5d-momentum
    +0.056 (raw +0.052); after residualising on 60d beta **+0.043 @5d, +0.054 @10d** (raw +0.052/+0.069). In a bull tape the tilt would work against it; no bull-tape sample exists.
  - **Engine ablation (ranks normalised per publication like `_normalize_to_100`, current REGIME_WEIGHTS, Rs10cr, 35/31 dates):** confluence alone IC +0.094 @5d / +0.135 @10d; breakout +0.056 / +0.091; technical +0.032 / +0.022; **ml +0.016 / +0.032**.
    Re-blend of the 4 weighted engines +0.085 / +0.119; **dropping confluence +0.049 / +0.065 (it carries the ranker); dropping ml +0.093 / +0.127 (ml adds nothing); dropping technical +0.087 / +0.131.**
    `ml` raw cross-sectional sd is 5.1 points on 0-100 (barely above the 3.0 dispersion override) yet percentile normalisation hands it a full 0.18-0.27 influence share on an IC of +0.016.
    Pairwise engine Spearman 0.05-0.37 (ml-confluence 0.35, confluence-breakout 0.37), so they are not redundant; they are mostly noise except confluence.
  - **The published score is worse than its own blend:** published `unified_score` IC +0.052 / +0.069 against +0.085 / +0.119 for the re-blend (Spearman between them only ~0.5). Approximating the overlays: high-vol veto (x0.7 on the top-20% 20d vol) -> +0.0725 / +0.0949
    (**-0.013 / -0.024**; the vol rank itself has IC +0.043 / +0.086 in this window, the opposite of the 4.5-year monthly result that justifies the veto, so one down-tape window does not overturn it); quality gate (latest `stock_fundamentals`
    piotroski/ROE as stand-in) **+0.003** (helps slightly; 43% of liquid names get x0.85); the remainder (red-flag veto x0.5 on ~17% of liquid names, factor-crowding x0.9, thin-coverage/plan vetoes) is unreplayed. **EVIDENCE: do not change any overlay on this window;**
    the forward-test shadow arms (re-blend, re-blend+vol-veto vs published) are the arbiter.
  - **Calibration:** `technical_signals.calibrated_win_probability` mean 0.51 vs realised decisive-WIN rate 0.32 (5d, n=19,864, signals since 2026-08-20; 15d 0.51 vs 0.30, n=13,128); **Brier 0.2524 vs 0.2191 for the constant base rate** (raw 0.2497; 15d 0.2547 vs 0.2107).
    Bins are monotone (decisive win 0.28 -> 0.33 -> 0.40 -> 0.53 across predicted 0.48 -> 0.51 -> 0.67 -> 0.70, mean return still -0.17% in the best bin), so it ranks weakly (corr 0.085) but it is NOT a probability; call it a rank everywhere it is shown.
  - **Realised plan outcomes (absolute, not excess, in a falling tape):** closed BUY plans, 15-session: Jun +1.69% net (n=3,908), Jul +0.32% (16,914), Aug -0.50% (32,207), Sep **-2.38% net, 68% stopped** (18,848). Intraday (`intraday_recommendation_outcomes`, 47 sessions): LONG avg -0.47/-0.57/-0.69/-0.86% per signal by month, SHORT -0.64..-0.70%, win ~21-25%.
    The Aug-Sep `technical_scan` h5 rows have no target and almost no stop (known, AF-20261001-10/-56) and are 99% time exits; exclude them from any plan statistic.
  - **Survivorship (price panel), measured:** `stock_ohlcv` holds 2,428 symbols, only 23 stopped trading after 2025-01 and 1 before 2025; `nse_universe_history` holds 973 EQ-series symbols absent from it (399 ended before 2026-09-01, 198 with ADT >= Rs10cr), **but most of the "ended" names are RENAMES, not delistings** (10 of 12 sampled held-then-gone names reappear under a new ticker: TWL->TITAGARH, LSIL->LLOYDSENGG, GET&D->GVT&D, IIFLSEC->IIFLCAPS...), so the real delisting count is far below 399.
    Re-run of the three closest-to-survivor price factors on the existing panel vs a survivorship-reduced panel (bhavcopy union, renames de-duplicated, ended names closed at last close), identical settings (21-session non-overlapping, next-open, Rs10cr floor, 25 bps/side, 55-66 periods 2021-2026): `momentum_12_1` top-10 +0.62% (t 1.38) -> +0.74% (t 1.60), top-50 +0.50% (t 1.19) -> +0.59% (t 1.41), harness check reproduces the recorded +0.7892% / t 1.61; `low_vol` top-10 -0.73% (t -1.94) -> -0.64% (t -1.53), top-50 -0.46% -> -0.44%; `reversal_21d` top-10 -0.65% (t -2.20) -> -0.75% (t -2.44), top-50 -0.60% -> -0.59%.
    **No verdict changes** (momentum still not significant, low-vol and reversal still negative); adding the gone names moves the numbers by 0.1pp per period or less. [Likely: the agent's written report was cut off by a rate limit; these figures are from its logs, with the rename-continuity question only spot-checked.]

- **2026-10-09 — multi-regime replay of the part of the ranker that CAN be reconstructed (2021-2026; LOW-DATA only where stated; AF-20261008-29).**
  Panel: bhavcopy (`nse_universe_history`, incl. delivery %) unioned with `stock_ohlcv`, survivorship-reduced (132 duplicate renames removed, 1,084 bhavcopy-only names kept, 8,789 `is_suspect` bars and the thin 2026-02-01 special session dropped, 243 bad bars flagged): 3,058,836 rows, 3,491 symbols, 1,431 sessions. Next-session OPEN entry, per-date winsorised, non-overlapping windows, regime = NIFTY50 close vs its 200-session mean. Harness check: `factor_backtest` momentum_12_1 at Rs1cr/25 bps reproduces +0.7889%/period, t 1.61, 55 periods (the recorded +0.7892% came from a panel that still held index tickers); random control IC -0.002, excess = minus the cost. Scripts: `h_build_panel.py`, `h_analyze.py`, `h_summarize.py` (review scratchpad).
  - **The published IC looks mostly like a product of its window.** A price-only rebuild of the ranker (price part of confluence + a technical-pattern count) reads IC +0.073 in the published window (vs +0.052 published) but **+0.003..+0.014 at 5d over 2022-2026 (t <= 1.1)**: +0.025 when NIFTY is above its 200-day mean, negative below it; at 21d in drawdowns -0.090 (t -2.8, 7 windows, LOW-DATA).
  - **Low beta is a bet on market direction, not an edge.** By the forward regime its IC is ~0 everywhere; split by what NIFTY did over the holding window it is +0.072 (t 6.5) when the market fell and -0.050 (t -4.4) when it rose (diagnostic only: the split uses the outcome). 70% of 2026's 5-day windows fell vs 35-48% in earlier years.
  - **Delivery:** the 5d-minus-20d delivery TREND is the only input positive in every regime, in both market directions and in all 6 years (IC +0.019, t 5.4) but its top-decile book still loses -0.27%/period after costs; the delivery LEVEL is defensive (+0.094 in falling windows, -0.019 in rising).
  - **Vol overlay (x0.7 on the top-20% 20d vol):** a small consistent plus over 2021-2026, IC +0.008 (t 3.9), positive in both regimes and every year; the -0.013 seen in the 40-session window was the falling-tape exception. Not significant net of cost. Keep it.
  - **Combination:** equal-weight mix with signs fixed on the first half only: out-of-sample IC +0.050 (t 5.4) at 5d / Rs10cr, positive in every regime, top decile -0.16%/period net **WAS charged the full 0.30% round trip on every rebalance; on actual turnover (54% one-way per 5 sessions) it is -0.022% (t -0.38), i.e. about zero (corrected 2026-10-09 by the lever study below)**; at 21d / Rs50cr ~0.
  - **Cannot be reconstructed (untested across regimes):** screener engine, `win_probability`/dl/breakout/cs models, confluence's fundamentals and composite-rank term, PCR/news/learned weights, the red-flag/quality/crowding overlays.
  - **Verdict:** the rebuildable part has no edge that holds across regimes; simple price and delivery inputs reach IC ~0.05 in any regime but not after costs. Keep "unproven, regime-dependent" until the forward test covers a rising market.

- **2026-10-09 — do structural levers turn the rebuildable combination's IC of ~+0.05 into a net edge? No (AF-20261008-31; 58 variants tried, Bonferroni |t| 3.33; none reaches t 2 out-of-sample).**
  Same 2021-2026 replay panel and signal as above (equal-weight price+delivery combination, signs fixed on the first half, evaluated second half and full sample), next-open entry, Rs10cr and Rs50cr floors, 0.30% round trip charged on ACTUAL turnover, non-overlapping windows. Harness check: `factor_backtest.py --factor momentum_12_1` reproduces +0.7889%/period t 1.61 (55 periods).
  - **Baseline:** net -0.022%/period (t -0.38) once cost is charged on actual turnover (54% one-way per 5 sessions), not the full round trip per rebalance. Scripts: `e_levers.py`, report `audit_E_levers.md` (review scratchpad).
  - **Rank buffer (enter top 10%, exit below top 30%):** turnover 0.54 -> 0.17, cost 0.16% -> 0.05% per period; best net +0.005% (out-of-sample t <= 0.3). Worth adopting as an EXECUTION rule (it cuts cost without hurting) but it creates no edge.
  - **Longer holding:** the signal still predicts (IC +0.048 / +0.047 / +0.046 at 5 / 10 / 21 sessions) but net excess does not improve; at Rs50cr it falls to about -0.26%.
  - **Beta hedge:** hedged book +0.10%/period, but hedging the plain equal-weight universe gives +0.17%: the positive number is the small/mid-cap premium over NIFTY, not selection skill. Hypothesis not supported.
  - **Liquidity weighting / capacity:** capacity at 2% of daily traded value is ~Rs17cr at the Rs10cr floor and ~Rs42cr at Rs50cr (Rs26-60cr with a buffer); weighting by traded value lifts it to ~Rs260-350cr but loses -0.07..-0.44% because the signal lives in the smaller names.
  - **Best-of combination (first-half winner: 21-session holding + 40% buffer + hedge):** second half +0.30% (t 0.38) at Rs10cr, +0.20% (t 0.32) at Rs50cr, negative in bull markets, below simply hedging the universe.
  - **By regime:** weakly defensive (negative in bull, positive in sideways/bear, nothing significant); no calendar year has |t| above 1.4. Selection rank vs same-day return -0.086 (Rs10cr) / -0.214 (Rs50cr) by construction (the signal includes short-term reversal to that day's close, entry is the next open); vs the overnight gap -0.02 / -0.06.
  - **Conclusion [Likely]:** the limit is signal strength, not cost structure: an IC of +0.05 gives a +0.03..+0.15% gross spread per period, about the size of any realistic cost.

- **2026-10-09 — PRE-REGISTERED hypotheses for the backfilled data (written BEFORE any of it was analysed; AF-20261008-33).**
  Data: `nse_results_filings` (broadcast timestamps from 2021), `stock_option_features_history` (2021-01..2024-07), `nse_shareholding_history`, `nse_pit_disclosures` (to 2026-05). Universe: ADT >= Rs10cr primary, Rs50cr secondary. Entry next-session OPEN after the knowable time (filing broadcast / bhavcopy day), non-overlapping windows, 0.30% round trip charged on actual turnover, per-date winsorised, benchmark equal-weight mean of the eligible set, survivorship-reduced panel (`h_panel.parquet`), regimes by NIFTY50 vs its 200-session mean.
  Primary tests (5, so the Bonferroni bar is two-sided |t| >= 2.58 at alpha 0.01; everything else is descriptive):
  - **H1** PIT revenue growth YoY (latest filing known at the decision date, not the period end): positive rank IC at 21 sessions.
  - **H2** PIT PAT growth YoY: positive rank IC at 21 sessions.
  - **H3** PIT Piotroski F-score: positive rank IC at 21 sessions.
  - **H4** ATM implied volatility minus trailing 20-day realised volatility (options history): NEGATIVE rank IC at 5 sessions (rich option premium predicts lower returns).
  - **H5** put-call skew `skew_95_105` (OTM put IV minus OTM call IV): NEGATIVE rank IC at 5 sessions (downside demand predicts lower returns).
  Not tested as primary (descriptive only, no verdict): promoter-holding change and pledge from the shareholding history, insider PIT net buying (its source stops serving data after 2026-05-02), put-call ratio, straddle size. A hypothesis that fails the bar is recorded as failed here; none is re-run with a different construction to rescue it.

- **2026-10-09 — intraday news event study on exchange-timestamped announcements (AF-20261008-34; ~40 sessions, LOW-DATA outside the primary test).**
  Events: NSE/BSE announcements in market hours on liquid names since 2026-08-12, classified by transparent keyword rules, abnormal return vs NIFTY50 intraday from 15-minute bars (`intraday_ohlcv`; 12 events dropped for a price-scale mismatch against daily prices). Scripts `n_event_study.py`, `n_analyze.py`, `n_quality.py`, `n_probe.py` (review scratchpad), report `audit_N_news_coverage_event_study.md`.
  - **Pre-stated primary test FAILED:** results + order wins, long, entry 30 minutes after exchange publication, exit at the close, ADT >= Rs10cr: gross -0.02% (t -0.19, 221 events over 64 dates, hit 46%); net of 0.30% round trip -0.32% (t -2.92). At ADT >= Rs50cr gross +0.04% (t 0.33), net -0.26%. The bar was |t| >= 2.58.
  - **Announcements DO move prices, but the reaction is over in ~15 minutes:** order wins +0.76% abnormal (t 6.19, 52 dates, 77% positive) in the 15-minute bar containing publication, only +0.01% left from a 30-minute entry to the close; results +0.19% in that bar then ~0. Following the first reaction loses (results -0.36%, t -2.39; order wins -0.19%; acquisitions -0.23%): leans toward reversal. [Likely, descriptive]
  - **Sentiment adds nothing:** only 11.6% of exchange events have |score| >= 0.2; sentiment-signed returns after entry -0.04% (t -0.65).
  - **We could not enter faster anyway:** the NSE feed is polled every 15 minutes with a median 13-minute lag.
  - **Coverage:** the NSE API `/api/corporate-announcements` is NOT ingested (a single GET with only `User-Agent: Mozilla/5.0` returned 200 with native symbol, exchange timestamp and date-range history); the RSS we use drops ~35% of filings (company name does not map to a symbol), has no history before 2026-08-12 and relies on title parsing. `NSE Financial Results` RSS has 3 rows ever; BSE rows arrive ~92 days late (cause not found). ET Top Stories and FT entity tagging is 4% / 3%. 12.7% of symbol-links are the same story from another source within 30 minutes. NSE item timestamps are the exchange's own (95.9% agree within 5 minutes where the URL carries one).
  - **Conclusion:** intraday news is not capturable by this platform; the more plausible edge is multi-day drift after results, which needs a surprise measure (XBRL from `nse_results_filings` plus consensus) and the Q2 season (~2026-10-10 to 11-14) as the pre-registered next test.

- **2026-10-10 — RESULTS of the pre-registered tests on the backfilled data (AF-20261008-33; bar |t| >= 2.58, definitions fixed before any result was seen).**
  Harness check reproduced momentum_12_1 +0.7889%/period t 1.61; random control IC -0.009. Next-open entry after the knowable time (63.6% of results are broadcast after 15:30 IST and count as next-session events), non-overlapping windows, 0.30% on actual turnover, survivorship-reduced panel. Scripts `p_tests.py`, `p_diag.py`; report `audit_P_preregistered_tests.md` (review scratchpad).
  | Test | Windows | Mean IC | t | Net spread/period | Verdict |
  |---|---|---|---|---|---|
  | H1 PIT revenue growth, Rs10cr, 21 sessions | 48 | +0.030 | 2.45 | +0.89% | **FAIL** (t just under the bar; stays failed) |
  | H2 PIT PAT growth, Rs10cr, 21 sessions | 48 | +0.034 | 2.77 | +1.03% | **PASS, marginal** |
  | H3 PIT Piotroski | - | - | - | - | **UNTESTABLE** (the dalalos table lacks assets, cash flow, debt, current ratio, gross margin and shares: 7 of 9 components cannot be built; every vendor F-score source starts in 2025/2026) |
  | H4 ATM IV minus RV20, F&O, 5 sessions | 162 | -0.042 | -4.68 | +0.10% (t 1.0) | **PASS statistically; not tradeable** (net spread ~0 after costs) |
  | H5 skew_95_105, F&O, 5 sessions | 162 | +0.024 | +2.88 | -0.49% | **FAIL, wrong sign** (predicted negative) |
  - **H2 detail:** above NIFTY's 200-session mean +0.040 (t 3.0, 38 windows); below it +0.013 (10 windows, LOW-DATA); 4 of 5 years positive (2025 negative on 3 windows); at Rs50cr t 1.79. PAT growth correlates +0.25 with the announcement-day return, but the label leaves that reaction out, so H2 measures the drift AFTER it.
  - **H4 detail:** the predicted sign in every year 2021-2024; same-name controls: random -0.009, momentum +0.031, low-vol -0.013; with realised volatility and the 5-day return removed it is -0.034 (t -3.3); about 0 below the 200-session mean (21 windows). F&O universe only (208 names).
  - **Coverage and caveats:** 82.2% of 26,969 quarterly values dated by an exact filing match, 1.4% by an any-type fallback, 16.3% dropped as undated; only 4 names that later stopped trading are in the fundamentals (2.8% of the Rs10cr universe); dalalos values may be restated rather than first-reported. Leak checks: mean |corr| with same-day return 0.06-0.11 (limit 0.2).
  - **Descriptive only (no verdict):** put-call ratio IC +0.010 (its book loses 0.36% net); straddle size IC -0.019; promoter-holding change IC +0.003 (+0.013 at Rs50cr); insider net buying IC -0.014; pledge has no point-in-time history.
  - **Honest reading:** 1 of 5 passes the corrected bar with a thin margin and one regime split; the fundamental-growth drift is consistent with the earlier 5-day growth IC of +0.07..+0.11 (one results season, AF-20261001) and with a real post-announcement drift, but it is a LEAD, not an edge.

- **2026-10-10 — PRE-REGISTERED out-of-sample confirmation of H2 (written BEFORE it was run; AF-20261008-35).**
  Single hypothesis, so the bar is one-sided t >= 1.65 (alpha 0.05): same definition as H2 (PIT PAT growth YoY, knowable at `broadcast_ts` of the matching filing, next-session open entry, 21 sessions, Rs10cr, non-overlapping, 0.30% on actual turnover) on filings broadcast on or after 2025-02-14 only (windows not used to define H2), using whatever dated quarterly values exist for those periods (state the coverage; if fewer than 15 independent windows exist the verdict is LOW-DATA and nothing is concluded). H1 is NOT re-run; H4 confirmation waits for options data after 2024-07 which this program has not loaded.

- **2026-10-10 — RESULT of the pre-registered out-of-sample H2 confirmation (AF-20261008-35): PASS, narrowly; the sign is confirmed, the size is not.**
  Filings broadcast on or after 2025-02-14 (26,500 rows, 25,861 of them from the integrated-filing endpoint; max broadcast_ts 2026-10-09). 17 non-overlapping windows (decision dates 2025-04-25 to 2026-09-01, all after H2's last decision date 2025-03-21), Rs10cr, 21 sessions, next-open entry, 0.30% on actual turnover. Bar fixed in advance: one-sided t >= 1.65.
  - **Mean rank IC +0.023, t 1.82** (12 of 17 windows positive); net top-minus-bottom quintile spread +0.52%/period (t 2.18), gross +0.77%; **long-only net +0.26% (t 1.27)**. Random control on the same names/windows IC -0.001 (t -0.07); same-day leak check mean |corr| 0.045.
  - **Size:** the IC is ~0.7x the in-sample +0.034, and without the two best windows it falls to +0.012 (t 1.05). So the sign survives; do not size an edge from it. The long-only leg (the only one a cash investor can hold) is not significant.
  - **Coverage:** dalalos values run to period_end 2026-06-30; 94-96% of its rows per quarter from 2025-03 to 2026-06 are dated by a matching filing (9,328 symbol-periods, 1,537 symbols; in-sample 82%). The first window has only 120 names (most 2024-12 results were broadcast before the cutoff), the rest 600-740. No value source was substituted.
  - **Caveats:** dalalos values may be restated rather than first-reported (the timing is point-in-time); dalalos covers almost only names that are still listed (survivorship); one results-season structure, 17 windows.
  - **Reading:** post-earnings fundamental-growth drift is the first factor on this platform with a pre-registered in-sample pass (t 2.77, Bonferroni bar) AND an out-of-sample same-sign pass, but its long-only net is small and not significant. Proper next step: a shadow arm in the forward test, not a ranker weight.

- **2026-10-11 — PRE-REGISTERED Q2-FY27 post-results drift shadow arm (written BEFORE any Q2 value was parsed or any Q2 return observed; AF-20261008-42).**
  Hypothesis (from the H2 pass and its out-of-sample confirmation, AF-20261008-33/-35): among companies that report in a results season, those with the highest YoY profit growth outperform the other reporters over the next 21 sessions.
  - **Cohort:** filings broadcast on a session (broadcast after 15:30 IST count for the next session) on or after 2026-10-12, consolidated if present else standalone, ADT >= Rs10cr (Rs50cr secondary). Cohorts are formed per ISO week; a week with fewer than 15 eligible filers is merged with the next week.
  - **Value source:** first-reported profit-after-tax and revenue for the quarter and for the same quarter a year earlier, parsed from the filing's own XBRL (so no restated figures). Growth = (PAT_q - PAT_q-4) / |PAT_q-4|, winsorised at +-300%; filers with PAT_q-4 = 0 or a missing prior-year value are excluded and counted.
  - **Arm:** long the top quintile by PAT growth within the cohort, entry at the next session OPEN after the broadcast session, exit 21 sessions later at the open, 0.30% round trip charged on the actual turnover, benchmark = equal-weight mean of all eligible filers in the same cohort. Reported also: top-minus-bottom quintile spread and rank IC (descriptive).
  - **Bar and verdict date:** primary metric = mean net long-only excess per cohort-week, one-sided t >= 1.65 on cohort-weeks. Q2 alone yields about 5 cohort-weeks, so Q2 is LOW-DATA by construction and is recorded without a verdict; the verdict pools Q2-FY27, Q3-FY27 (Jan-Feb 2027) and Q4-FY27 (Apr-May 2027) cohorts and is due 2027-06-30 with at least 15 cohort-weeks, else LOW-DATA again. Nothing is wired into the ranker before then.
  - **Not allowed:** changing the quintile, the horizon, the winsorisation or the liquidity floor after the first Q2 return is observed; adding revenue growth as a second primary test (it failed as H1 and stays descriptive).

- **2026-10-12 — AMENDMENT to the Q2-FY27 pre-registration, fixing three measurement choices the XBRL build forced (AF-20261008-42). Written BEFORE any Q2-FY27 return was observed: the earliest possible entry is the 2026-10-12 open and no Q2 cohort has traded yet.**
  What the build found: the filings' XBRL does NOT carry prior-year comparatives in a usable slot (the plan to get YoY growth from one file failed), and about 9.5% of Q2 filers put half-year (YTD) figures in the quarter slot. Validation: standalone PAT matches the independent dalalos figure within 0.5% on 97.5% of 1,947 symbol-quarters; consolidated headline PAT matches 70%, and a further 451 rows match PBT minus tax (dalalos excludes the associates/JV share), so counting either definition 97.5%; 4 rows (0.2%) are ~100x off because the company's own file declares lakhs.
  - **PAT definition (primary):** the filing's headline profit-for-the-period (it includes the share of associates/JV, which is what the market reads as net profit), consolidated if present else standalone. PBT minus tax is reported descriptively only.
  - **Year-ago value:** the first-reported figure from the SAME company's year-earlier filing (Q2-FY26, already parsed in `nse_filing_financials`), not a restated comparative. Filers with no year-earlier filing in the table, a zero or missing base, or a year-earlier value flagged as half-year are excluded and counted.
  - **Half-year-in-quarter-slot filers:** EXCLUDED from the primary arm (flagged and counted); a secondary descriptive variant may repair them as H1 minus the company's Q1, with no verdict.
  - **Scale guard:** a PAT growth beyond +-300% after winsorising stays; a value flagged as a probable lakh/crore scale error (|ratio to the year-ago value| outside 0.001..1000 together with a file declaring lakhs) is excluded and counted.
  - Everything else in the 2026-10-11 pre-registration is unchanged (cohorts, quintile, 21-session hold, 0.30% on turnover, one-sided t >= 1.65 on cohort-weeks, verdict 2027-06-30).

- **2026-10-12 — CLARIFICATIONS to the Q2-FY27 arm made by the grader's implementation (still before any Q2-FY27 return was observed).** (1) The season start is read against the EVENT session, so a filing broadcast after 15:30 IST on Friday 2026-10-09 counts for the 2026-10-12 session. (2) A year-ago value available only on the other basis (consolidated vs standalone) counts as 'no year-ago' and the filer is excluded, so growth is always like-for-like. (3) The cohort benchmark is the equal-weight mean of all eligible filers WITHOUT the 0.30% charge, the same convention as `forward_test_report.py`; only the arm pays it. (4) A season's undersized final week stays pending (nothing merges backwards). (5) Q3-FY27 and Q4-FY27 can only be graded once their year-ago quarters (2025-12-31, 2026-03-31) are parsed into `nse_filing_financials`; that backfill is due before 2027-01-15.

- **2026-10-15 — walk-forward recalibration of `win_probability` (AF-20261008-45): NO recalibration beats a trailing constant base rate out of sample. The honest product is a rank, not a probability.**
  Reproduced the live scorecard alert: 5d n=27,305, mean calibrated 0.545 vs realised decisive-WIN 0.343, Brier 0.2692 vs 0.2253; 15d 0.558 vs 0.335, Brier 0.2690 vs 0.2228. Data with both columns and a graded outcome exists only 2026-05-16..2026-10-07 (5d) and ..2026-09-22 (15d). Scripts `c2_pull.py`, `c2_study.py`, report `audit_C2_recalibration.md` (review scratchpad).
  - **Why the column is wrong [Certain]:** `ml_calibration.recalibrate_win_probabilities` fits ONE isotonic map across 1/2/3/5/15d outcomes (no horizon filter) on all history since May; the label drifts with the market (5d win rate 0.50 in July -> 0.29 in September; 15d 0.59-0.73 -> 0.28); the model trains on `tb_label` (base 0.37 falling to 0.28) while the scorecard grades the path-barrier WIN; the raw value is the day's median model output plus (rank - 0.5) x 0.15, not a probability either. The 2026-10-11 retrain changed none of this (October still averages 0.452 predicted vs 0.301 realised). The scorecard's own 0.2253 benchmark uses the realised base rate of the same rows, which nobody could know in advance.
  - **Walk-forward (purged by h sessions, block bootstrap by date):** current column worse than the trailing 20-session base rate by +0.057 Brier at 5d [+0.025, +0.090] and +0.027 at 15d [+0.001, +0.058]; raw worse too (+0.047 / +0.022). Best alternative (rank deciles, 20-session window): -0.0005 [-0.003, +0.002] at 5d, +0.0011 at 15d = a tie with the constant. Per-date AUC ~0.55 (against a label already documented as mostly a volatility detector). Knowing each date's realised win rate would cut Brier by 0.038 and the rank adds only 0.0002 on top: the error is the market level, which nothing here forecasts. No regime split possible: NIFTY was below its 200-session mean on all 104 signal dates.
  - **Consumer risk:** at least five consumers apply absolute thresholds to the column (scoring_engine 0.55/0.40/0.30, the technicalSignalsService filter, the recommendation_log expiry gate, the backtester, the edge.router reliability bins); overwriting it with honest values would mass-expire and penalise. Sizing reads the raw value first, and an honest probability under 0.5 would size every ML bet at 0.
  - **Decision:** do not overwrite the column; show the rank ("ML rank: top X%", computed cross-sectionally at read time), pass null as the confidence input, and compare the scorecard against a trailing base rate.

- **2026-10-15 - tradability floor on the ranker's top decile (AF-20261015-10): the apparent 5d edge is concentrated in names under Rs 10 cr/day, and after the floor it is no larger than the 0.30% round trip.**
  Panel: `unified_recommendations_history` 2026-08-10..2026-10-14 (46 sessions), one run per IST date, entry = NEXT-session OPEN, exit = close 5 sessions after entry, suspect bars excluded, returns clipped to [-60%, +100%], ADT = mean(close x volume) of the prior 20 sessions. Top decile of `unified_score` per date vs the same date's universe mean; windows made non-overlapping by taking every 5th date at all 5 phase offsets (7-8 independent windows each).
  - All names: excess vs universe +0.37..+0.69% per 5d across the 5 phases, per-phase t 2.3-4.2 (n=8); top-minus-bottom decile +0.76..+1.14%. Absolute top-decile NET return is negative in 4 of 5 phases (universe mean -0.14..-0.81%: a falling tape).
  - ADT >= Rs 10 cr (re-ranked within the liquid subset): excess +0.18..+0.39%, per-phase t 0.7-3.7; top-minus-bottom +0.30..+0.96%. Roughly half the edge, and mostly not distinguishable from zero at 7-8 windows.
  - Bullish `unified_signal_outcomes`, 5d, 2026-05-16+: every ADT tier loses (mean gross -0.63..-0.85%, win rate 36-38%), no tier is better; the <Rs 1 cr tier is the worst (-0.85% gross).
  Caveats: 40 dates is ~8 independent windows from one bearish stretch; illiquid-name opens are the least fillable, so the all-names number is an upper bound on what is realisable. No weight, threshold or classification changed; this decides only how the list is LABELLED (tradability badge), not what it ranks.
- **2026-10-15 - listed-universe filter in `unified_ranker._restrict_to_tradeable_universe` (AF-20261015-12): 13 retired-alias / phantom symbols removed from the ranked set.** A symbol with no bhavcopy row in the last 45 sessions is no longer ranked (INDUSIND, LARSEN, MAHINDRA, KOTAK, NESTLE, TATAMOTORS, CHOLAFINSV, ...). They were Yahoo-priced duplicates of a real listing (INDUSIND Hold 42 vs INDUSINDBK Sell 23). Population change 2,326 -> ~2,313 (0.56%): a percentile moves by at most ~0.6 points; no engine weight or threshold touched. Fails open if the bhavcopy table is empty.
- **2026-10-16 - official equity-universe admission policy (AF-20261015-11/-12): 2,379 ACTIVE equities after reconciliation.** NSE's complete equity catalogue is now authoritative; its separate 355-symbol ETF catalogue is excluded exactly, and new equities require 60 observed sessions. Relative to the 2,324 previously-active symbols that were still in the official catalogue, this admits 55 mature current listings (+2.37%) while deactivating 29 absent aliases/listings and one ETF. This changes only the eligible cross-section, not any engine weight, score threshold, or factor construction; the point-in-time factor harness remains bhavcopy-derived and therefore is not a test of this current-master control. Ranker regressions and live active/ISIN postconditions are the relevant evidence.
