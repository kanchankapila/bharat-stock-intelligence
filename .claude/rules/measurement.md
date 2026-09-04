# Measurement Discipline

Read before quoting, comparing, or acting on any accuracy, win-rate, IC, or backtest number.
Full incident narrative and investigation detail behind every claim below:
`docs/measurement-history.md` (split out 2026-08-12 for length, and condensed again 2026-08-28 —
this file is the rules and current verdicts you need before acting; that one is the derivation,
read on demand). The 2026-08-28 pass moved every corrections-of-corrections narrative out of this
file into history verbatim — nothing was deleted, only relocated, so a fact missing here is not a
fact lost, it's one line away in history.

## Current state, as of the last full re-measurement (2026-08-27)

Every harness (`factor_edge.py`, `factor_backtest.py`, `assembly_ablation.py`,
`blend_walkforward.py`, `screener_combo_finder.py`) was re-run against live production on
2026-08-27. **Headline: nothing clears `USABLE` on a terminal-return grading, `unified_score` is
still no-edge, and two older claims were retracted that day** (`REGIME_WEIGHTS` no longer beats
equal weighting on today's re-shrunk weights; `unified_score`'s 5d IC is +0.017, not the ~0.0001
long quoted here — still no-edge, but stop citing 0.0001 as re-confirmed). Full tables and every
number: `docs/measurement-history.md`'s "FULL LIVE RE-MEASUREMENT, 2026-08-27" section.

**Re-run in full 2026-08-29** (explicit user request for a full harness pass, not the spot-check
this section originally described — superseding that plan): `factor_edge.py` re-run live against
`technical_signals` (both entries), `engine_composite_scores` (both entries), and
`unified_recommendations`' 8 engines, all `--persist`ed; `assembly_ablation.py`,
`factor_backtest.py --factor momentum_12_1`, `screener_combo_finder.py --tier1`, and
`blend_walkforward.py` also re-run. **Nothing reversed.** Every verdict in this file reproduced
with only the mild continued decay already documented as this platform's expected pattern for a
weak signal: `win_probability` close 1/5/21d now 0.037/0.068/0.085 (from 0.039/0.070/0.091 on
2026-08-27); `engine_composite_scores` close 5d IC 0.073 (from 0.076) — still the platform's
highest measured 5d IC; `dl_score` 21d IC **0.098, bit-identical** to 2026-08-27, still the
strongest single engine. `smart_money_score` and `movement_probability` below are corrected with
these live numbers; `ml_breakout_probability` (USABLE, 44 dates) and `breakout_probability`'s
h=10 LOW-DATA read (19 dates) reproduced unchanged. Full per-score table: this run's own stdout,
persisted to `factor_edge_history` (`run_at` 2026-08-29T14:4x-14:5x) — not re-transcribed here to
avoid a second copy that can drift from the source of truth.

**What reproduced exactly and matters most:** the screener bisection. Adding `screener` to the
6-engine blend costs −0.0136 IC @5d / −0.0163 @21d; `smart_money` is inert (identical to baseline
to 4 decimals). This is the **fourth** independent confirmation that the screener engine is
actively harmful (direct factor test, the `confluence_score` natural experiment, the ablation
bisection, and this run) — both weight shrinks taken so far (2026-08-20, 2026-08-21) were
directionally right. **THIRD shrink, 2026-08-30: `screener`'s `REGIME_WEIGHTS` set to 0.0 in
every regime** (was ~0.054–0.115), freed weight redistributed proportionally across the other 6
non-pinned engines (`breakout` stays fixed at its own independent audit-derived ceiling —
`[0.15, 0.05, 0.10, 0.05, 0.13]` across BULL/BEAR/HIGH_VOL/CRASH/SIDEWAYS — a naive proportional
split across all 7 remaining engines would have scaled it up, which `test_regime_weights_sum_to_one`
caught before it shipped). This is not a fresh discovery — it's acting on the bisection result
already reproduced 4 times above, since `assembly_ablation.py`'s `rw7`/`rw7+screener` arms read
`REGIME_WEIGHTS['screener']` directly through the same `_blend()`-style renormalization this
change uses, making that comparison mechanically identical to this code change. All 221
`unified_ranker`-related pytest cases pass; `unified_ranker.py` runs as a fresh subprocess per
scheduled invocation (`runPython`, not a resident service), so no `pm2 restart` was needed — it
took effect on the next run. **Re-verify on FRESH dates once ~15-20 accumulate under the new
weights** (`factor_edge.py --table unified_recommendations` against the live `unified_score`
column) — today's `assembly_ablation.py` re-run confirmed the code runs cleanly with sane,
non-degenerate output, but its `stored_unified_score` arm still reflected pre-change history (the
ranker hadn't run yet at re-run time), and its per-arm row populations aren't cleanly comparable
population-for-population without modifying the script, so it does not by itself constitute the
fresh confirmation — that has to come from live dates generated under the new weights. `dl_score`
is the strongest engine at 21d (+0.098 IC), consistent with
`ml_score` grading mildly negative at every horizon (corroborating the 2026-08-24 halving).

`momentum_12_1` and the capitulation triple (`gap_down AND open_eq_low AND top_loser`, next-session
open→close) both reproduced bit-identical to their prior runs — the harness is deterministic and
neither panel moved. The capitulation triple remains **the one validated edge on this platform**
(t=+3.48, p=0.0005, 5/6 years positive, clears Bonferroni) — see the small-capacity caveat in
"Already tested" below. `blend_walkforward.py`'s TILT alternative still fails its pre-declared bar
(dIC −0.0006) — **do not reweight the shipped vector again** on the strength of any single ablation.

**Verified again 2026-08-30 (scheduler audit, read-back not re-run).** `factor_edge_history`'s
latest persisted run (`run_at` 2026-08-30T00:22, written by that night's `ml-weekly-retrain`) was
read back column-by-column against this file. **Every number in the 2026-08-29 block above
reproduces exactly** — `win_probability` close 1/5/21d 0.0371/0.0677/0.0855 (60/56/40 dates),
`engine_composite_scores` close 5d IC 0.0726 (51 dates), `dl_score` 21d IC 0.0981 (28 dates),
`smart_money_score` h1 -0.000/AUC 0.502 (14 dates) and h5 -0.020/0.484 (10 dates),
`screener_momentum_score` open-entry 0.047/0.104/0.2175 with 21d AUC 0.5516 still the only
`USABLE`. Nothing was re-derived and nothing moved; this is a read-back confirmation, not a
fifth independent measurement, and must not be cited as one.

**What DID change on 2026-08-30, and is new here:**

- **The active ensemble's CV is now 0.5305, not 0.5203.** `model_registry` id trained
  2026-08-29 23:25 (`label=triple_barrier`, `is_active=1`) reports `cv_roc_auc` **0.5304899**,
  superseding the 0.5203 this file has quoted since the label switch. This is the same honest
  triple-barrier label, so the two ARE comparable — it is a small genuine improvement, not a
  label artifact. It changes nothing about the verdict: 0.53 still sits inside the live realized
  AUC band (0.49–0.53) that the label switch was made to match, and `unified_score` is still
  no-edge. Quote 0.5305 as the incumbent's CV from now on; keep quoting 0.7664 only as the
  retired `horizon`-label number it always was.
- **⚠ The NEXT ensemble CV will NOT be comparable to 0.5305, and a LOWER number is the
  expected, correct outcome — do not read it as a regression.** Uncommitted-at-time-of-writing
  changes to `ml_ensemble.py` (reviewed 2026-08-30) change the CV *construction*, not the label:
  (a) `tune_hyperparameters()`/`_fit_stack()` now use a date-grouped **purged** walk-forward
  splitter (`purged_cv.make_purged_group_time_series_split`) instead of row-based
  `TimeSeriesSplit(gap=embargo)`, so a single trading day can no longer be split across
  train/validation; (b) `_base_models()` is now `(*, cv)` keyword-only with NO default and the
  real splitter is threaded into all six `CalibratedClassifierCV` instances, closing the
  `cv=int` -> `StratifiedKFold` leak recorded in `ml-model-bugs.md`; (c)
  `drop_untrainable_features()` removes constant/degenerate columns before training, so
  `feature_count` will fall below the 421 every ensemble row has carried to date.
  All three REMOVE leakage or noise, so the honest CV should come out below 0.5305.
  **This is the same hazard as the 0.7664 -> 0.5203 label switch, one layer over**: the metric
  moved because the measurement changed, not because the model got worse.
  The promotion gate does NOT deadlock on it — verified live 2026-08-30: `live_edge_verdict()`
  reads the incumbent's `technical_signals.win_probability` best horizon as
  rank_ic=0.0855 / hit_auc=0.5179 over 60 dates, which passes IC>=0.03 but FAILS AUC>=0.55, so
  `live_edge_is_unproven()` returns True, `baseline_untrustworthy` is set, and the CV-margin bar
  is skipped. Record the CV construction alongside the label on the registry row if this changes
  again; `baseline['label'] != new_label` keys on the LABEL only and would not have caught this.
- **`online_sgd` (the daily incremental learner) reports val_AUC 0.5017** — live-measured
  2026-08-30 over 266,396 outcomes in a 180-day window. Chance, as expected for this engine.
- **Two promotion gates rejected again, both reproducing `ml-model-bugs.md`'s 2026-08-30
  feature-completeness finding rather than contradicting it**: `cs_ranker` spearman_rho 0.1403
  vs baseline 0.1758 (REJECTED — up from 0.0875 pre-fix, still short), `exit_policy` held-out
  MFE MAE 5.664 vs baseline 4.7642 (REJECTED — and WORSE than its own 4.998 pre-fix run). The
  "more features is not a one-way lever" corollary in that file is now two runs deep, not one.
- **11 `technical_signals.ext_*` vendor columns are newly graded and ALL `LOW-DATA` at 4 dates**
  (`ext_fii_holding_pct`, `ext_dii_holding_pct`, `ext_fii_qoq_chg`, `ext_dii_qoq_chg`,
  `ext_mojo_financial_pts`, `ext_mojo_quality_rank`, `ext_mojo_valuation_rank`,
  `ext_t80_financial_pts`, `ext_t80_quality_rank`, `ext_t80_valuation_rank`,
  `ext_t80_tech_score`). Their h=5 ICs swing from -0.24 to +0.39 on FOUR dates, which is noise,
  not signal — do not read the positive ones as promising. These are exactly the untested
  correlated vendor surface `data-sources.md`'s vendor-onboarding freeze was written about;
  re-check once ~20 dates exist (~late September 2026) and treat a continued no-edge as a
  removal candidate.
- **No BiLSTM has trained since 2026-08-25** (`model_registry` last BiLSTM row: v4, 2026-08-25
  00:27, cv 0.6493, rejected by the saturation guard; champion still v3). This is NOT a new
  modelling result — it is a scheduler defect found the same day: `dl-retrain-weekly`'s Saturday
  2026-08-29 11:30 IST run was left marked `active` in BullMQ with no surviving worker process
  (killed by a pm2 restart), so the slot neither ran nor reported failure. Re-run 2026-08-30 as
  a make-up. Do not interpret the flat DL champion as evidence about the model.
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
- **Check `signal_source` before joining `signal_outcomes`.** Three writers share that table.
- **Decompose a "% of rows affected" figure by liquidity before believing it.** A defect reading 42% of rows read ~100% of the *tradeable* slice.
- **Judge any datasource by dates PER SYMBOL and by its DENSE span, never by raw `min(date)`/`count(DISTINCT date)` over the whole table.** A table can report years of span while being 4-5 rows per symbol. Run both: `SELECT min(n), median(n), max(n) FROM (SELECT symbol, count(DISTINCT date) n FROM t GROUP BY 1)` and a per-year distinct-date count.
- **Grade every candidate factor against BOTH tails**, not just AUC-vs-winners — an AUC computed only against winners cannot tell "predicts winners" from "predicts volatility" (this codebase has been fooled by that exact statistic twice). Report AUC vs the winning tail, AUC vs the losing tail, AUC of one tail against the other.

## Standing architecture facts (still true, verify before contradicting)

- **The ML training label is `triple_barrier`** (`signal_excursions.tb_label`, a cost-aware López de Prado barrier), not the old `path_barrier`-derived `horizon` label that inflated CV to 0.7664 by measuring the label's easiness rather than skill — the honest label gives CV 0.5203 at the switch, and the incumbent trained 2026-08-29 now reports 0.5305 — both matching live realized AUC (0.49–0.53). **Promotion now gates on `factor_edge_history`, not just CV**: `model_promotion.py`'s `live_edge_verdict()`/`live_edge_is_unproven()` skip the CV-margin bar entirely when the label changed, and treat the incumbent's own realized `factor_edge_history` reading as the bar when it fails `|rank_IC|>=0.03 AND hit_AUC>=0.55`. A "never graded" column is NOT read as "no edge" (that would auto-override on zero evidence), and a reading under `MIN_DATES_RELIABLE=20` cannot override either.
- **`win_probability` has a real, small IC on a terminal-return grading, but it keeps decaying toward null as its panel grows, and AUC never clears 0.55.** Live-verified 2026-08-29 against `factor_edge_history`'s latest (2026-08-27) run: IC/AUC now read **+0.020/0.500 (1d, 57 dates), +0.065/0.510 (5d, 53 dates), +0.084/0.523 (21d, 37 dates)** — down from the 0.044→0.077→0.103 figures this row previously quoted (themselves already a decay from an earlier 21d IC of 0.103→0.091 recorded in `measurement-history.md`). Graded against its own real training label instead (`signal_outcomes`, `path_barrier`, decisive WIN/LOSS) it DOES clear `USABLE` at 1d/5d (AUC 0.617/0.600), but that is a same-shape base-rate artifact of the barrier construction, not proof of tradeable skill, and the cost/turnover-aware `factor_backtest.py` run still fails (5d/top-50/15bps: 7 periods, net +1.52%/period, **t=1.54, not significant**, 83.4% one-way turnover, 12.61%/yr cost drag). Two independent disqualifiers (weak, decaying AUC on the honest target, real cost drag) — do not trade this as scored today. Re-test once ~12 months of history exist.
- **`ml_breakout_probability`** (a sub-engine feeding `confluence_ml_engine.py`, native label = `signal_outcomes` WIN/LOSS h=7) clears `USABLE` outright — IC +0.082, AUC 0.553, n=44 dates. The strongest previously-ungraded result measured on this platform; has zero downstream readers today (advisory only), and has not yet had the cost-aware `factor_backtest.py` follow-up `win_probability` got.
- **`breakout_probability`** (native label = fwd-10d max return ≥ +6%) reads IC +0.153/AUC 0.583 at 19 dates — one date short of `MIN_DATES_RELIABLE`, promising, do not downweight in the blend on an older superseded wrong-horizon reading.
- **`breakout_classifier.py`'s feature set was extended with delivery/sector/options candidates and measured live 2026-09-02 — both testable candidates came back null, so FEATURE_COLS was left unchanged (still the original 22).** Sector-relative return (`rs_vs_sector_21d/63d`, reusing `relative_strength.py`'s tested `build_sector_features`, full-history-safe) moved purged-OOF AUC 0.6130→0.6131 and held-out test AUC 0.6399→0.6402 on the identical 775,254-row/1,153-date panel — noise, not a lift; a second independent confirmation (after this file's rejected sector-neutral value/momentum factors) that sector-relative framing doesn't help here. Delivery% (`stock_delivery_data`, restricted to its own ~262-date covered window for an apples-to-apples read, 116,447 rows) moved OOF AUC not at all (0.6433→0.6433) and held-out test AUC slightly negative (0.6035→0.6018). Options OI (`so_option_chain`/`stock_options_oi`, 44-54 dates, a single Jun-Sep 2026 regime) was judged too sparse to measure meaningfully and was not wired in or ablated. Both tested candidates are reproducible via `--sector-ablation`/`--delivery-ablation` (write no model) if the universe/regime mix or history depth changes materially — re-run rather than re-deriving the wiring.
- **`movement_probability`** had a real train/serve-skew bug (live `score()` skipped the lag `load_training_data()` applies, so every pre-2026-08-20 value used same-day data to "predict" itself — AUC 0.894 was leakage, not skill). Fixed; every value written before 2026-08-20 is tainted. As of 2026-08-29 only **7 of the ~20 needed post-fix dates** have accumulated (23 pre-fix dates vs. 7 post-fix, last date 2026-08-28) — it remains genuinely ungraded, re-check once ~20 fresh post-fix dates exist (~mid-September at the current pace of ~1 trading date/day).
- **The IC-real-but-AUC-stalls-near-0.52 shape recurs across 7+ architecturally unrelated engines** (`win_probability`, `cs_score`, `ml_breakout_probability`, `prob_up_5d`@15d, the confluence composite, `engine_composite_scores`). Tested directly (Gaussian-copula simulation matched to each engine's measured IC): for most horizons the measured AUC is exactly what that IC mechanically implies — **this is a property of the correlation magnitude at this sample size, not a fixable measurement artifact**. Raising it needs IC ≥ ~0.15, not a better classifier or a different AUC threshold. The engines really are independent (max pairwise Spearman rho 0.29 on a z-scored panel) — the shared ceiling is not redundancy.
- **`_blend` now normalizes all 8 engines onto the same 0–100 scale before averaging** (fixed 2026-08-22 — 4 engines were already percentile-ranked, 4 returned raw `probability*100`, so weights did not mean what they said; `ml` at 0.172 weight was contributing ~1.1% of actual ranking influence). This is a **correctness fix with a measured-null forward effect on IC** (flat across all A/B arms) — ship it because weights now mean what they say, not because it improved anything. `ZERO_DISPERSION_MIN_SD = 5.0` is calibrated for this 0–100 scale only — applying it to a raw 0–1 probability column (e.g. `win_probability`) will read nearly every engine as collapsed; this has already produced one confidently-wrong ablation result.
- **`calibrated_win_probability`'s 2–7 distinct-value collapse on days when the day's raw `win_probability` spread lands inside one isotonic step is NOT a defect — do not "fix" it.** Tested directly: tie-breaking within a collapsed band to restore raw ordering costs 23% of h=5 IC (0.1116→0.0858) for +0.007 at h=21 — the collapse is the isotonic fit correctly discarding within-band ordering that doesn't predict at 5d. `_get_ml_scores` correctly gets dropped from the blend by `drop_zero_dispersion_engines` on these days (measured baseline: `dl` 39%, `ml` 34%, `technical` 18%, `confluence` 3% of ranker-dates); monitored by `ur-engine-dispersion-collapse` (warns at 60%, fails at 80% collapse rate) and `ur-engine-score-zero-not-null` (a genuine bug would look like a SPIKE above this baseline, not the baseline itself). **Escalated 2026-08-29**: `ml`'s collapse rate over the last 10 ranker dates is now **80%** (up from 60% on 2026-08-27, AF-20260827-15, itself up from the 34% baseline) — `dl` (0%) and `technical` (0%) both improved over the same window. This sits exactly at the documented fail threshold but the live `dq:check` run still reported it as WARN, not FAIL — worth a closer look at the boundary condition, not yet re-litigated as a defect in the underlying mechanism (which the 4-arm A/B above already settled).
- **Two population boundaries apply to `unified_recommendations`' reporting `*_score` columns and must be filtered on, never pooled across:** `2026-08-18` (AF-20260818-31 zero-vs-NULL fix — before this date a `0.0` in `ml_score`/`dl_score`/etc. could mean either "engine scored zero" or "engine never ran," and pre-fix rows must NOT be repaired/backfilled, the correct value is unrecoverable); `2026-08-23` (the trading-day calendar-cutoff fixes — before this date `dl_score` was silently zero on ~5 of 8 Mondays and `win_prob_map` on all of them, dropping Factor 3 from mean 17.71/20 to 8/20 uniformly on those days).
- **7 `technical_signals` columns have never been written, and none is a bug**: `fcf_yield` (superseded by `fcf_yield_approx`) and `created_at` (dead, use `computed_at`) are droppable-whenever schema debris; `eps_revision_3m_pct`/`target_revision_3m_pct`/`analyst_count_chg`/`pledge_chg_90d` are calendar-blocked (need ~76-90 days of history the source tables don't have yet, unblocking ~2026-09-05 for the analyst trio); `ccc_trend` was a real bug (fetcher requested only 5 quarters instead of 20 for a YoY computation) fixed 2026-08-27 and now just needs a second fiscal year to accumulate. **Do not re-audit any of these as "dead columns" without re-checking this list first.**
- **The DL BiLSTM's first real (non-NULL) walk-forward AUC (0.6493, 2026-08-25, widened 78→85 features) was still rejected by the saturation guard** (`frac_saturated=0.536` > `MAX_SATURATION_FRAC=0.5`) — champion stays v3. This is the guard working as designed, not a bug. **If saturation persists across future retrains, the next lever is label/loss-side calibration, not gate tampering.**
- **`stock_futures_oi_history`/`mc_stock_futures_oi_fetcher.py` (F&O long/short buildup, rollover, basis) is built and now graded via `factor_edge.py`** — `oi_change`/`oi_pct_change`/`oi_pcr`/`basis`/`rollover_pct` all `LOW-DATA` (table under a week old at last check). `oiBuildup` is deliberately NOT graded — it's a vendor text label, same caution as `mojo_indigraph` below. Re-check once ~20 dates accumulate (~late September 2026).

## Open / pending — re-check or act on these, don't re-derive them from scratch

- **CORRECTED 2026-08-30 — this row was stale.** `unified_recommendations_history` DOES store `dl_score`: migration `1787110000000` added it and was applied to production 2026-08-21, and `unified_ranker.py`'s insert already writes it (verified live 2026-08-30: 100% non-null coverage on every day 2026-08-22 through 2026-08-27, the most recent populated range). Rows before 2026-08-21 are still NULL by design (never captured, deliberately not backfilled — see the migration's own comment). The blend-decomposition pass this row used to block is now unblocked for any window starting 2026-08-22 or later — attempt it against that window rather than re-deriving that the column is missing.
- **`smart_money_score`** — at 14 dates as of 2026-08-29 (up from 1), still under the ~15-20 date floor (see "Already tested" table below for the live reading — trending toward zero/negative). `ENGINE_EDGE_SHRINK` will apply automatically once it clears LOW-DATA with a negative verdict (gated behind `engine_edge_adjustment_enabled`, off by default).
- **`technical`'s next-session-entry directional call** (t=+2.13 at 1d on 12 dates, under this file's own 20-date bar) — re-run once ~20+ dates accumulate under the corrected next-session-entry convention (~2026-09).
- **`earnings_beat_yoy`/`earnings_beat_qoq`, `screener_breadth`, the 3 named results screeners** — all underpowered (3–27 periods), re-test only once ~12+ months of history exists in their source tables.
- **`cs_ranker`'s active model has a declining self-reported CV-AUC across 3 consecutive retrains** (0.176 active vs 0.161/0.161/0.133 rejected) — flagged, not confirmed as a bug (self-reported CV-AUC on a thin date-split holdout is exactly the kind of number this file warns not to trust blindly). Worth a dedicated look.
- **`mean_reversion_14` veto construction — CLOSED 2026-08-30, definitively not significant. Moved from "Open" to the "Already tested" table below; do not re-open without a genuinely new angle.** The `feature_store` coverage gap that made the first pass ambiguous (412/~1,128 dates, a recent-only subset) was itself backfilled the same day (2,428 symbols, 2,658,313 rows, full 2021-2026 trading-calendar coverage) specifically to settle this question — see the "Already tested" row for the final, full-history, well-powered result.
- **`win_probability` sub-population split** (grid-scored vs. pattern-fired via `signals_json IS NOT NULL`) has never been explicitly re-graded to confirm the two sub-populations behave the same way — flagged, not measured.
- **`mc_fno_eligible`/`mc_del_acceleration`** are now cheaply derivable (`mc_pricefeed_daily.fno_lot_size > 0`; `del_pct_3d`/`del_pct_20d`) but deliberately not built — the risk was a formula that might silently disagree with the fetcher's own definition. Revisit if these features are ever prioritized.
- **`engine_composite_scores`'s producer runs weekly** (inside `processMlWeeklyRetrain`) and that job **failed on 2026-08-24** (`job_heartbeat.last_error`: `2 steps failed: exit-policy-train,backtest-optimizer`, wrapped in a swallowed `.catch()` so its own failure never reddens the job) — the weekly job's reliability is the open item, not the composite score itself.
- **`technical_signals.screener_momentum_score` (AF-20260829-12's requested before/after read) — measured 2026-08-29, and it does NOT settle the question it was asked to answer.** `factor_edge.py --table technical_signals --scores screener_momentum_score --entry open` against live production: **rank_IC 0.047/0.104/0.217, hit_AUC 0.503/0.524/0.552 at 1d/5d/21d (53/49/33 dates), 21d clears USABLE** — genuinely positive, not the "actively harmful" reading `measurement.md` has recorded for the plain "screener bullish consensus" count (IC −0.027) and for individual screener sentiment (0/1,563 survive FDR). **Why this isn't the before/after AF-12/20 need**: the graded panel spans 2024-06-01→2026-08-28 (79 dates), so it is almost entirely PRE-reclassification history — the 2026-08-29 relabeling (162/651 screeners) contributes zero forward-return-gradeable dates yet. This is a genuinely new, never-before-graded column (`screener_momentum_score` blends `bayesian_score`/`tier` with `inferred_sentiment`, not sentiment alone) showing real signal under the OLD labels — worth its own follow-up regardless of the reclassification question. **The reclassification's specific effect remains ungraded and calendar-blocked** — re-run this exact command once ~20+ trading dates have accumulated after 2026-08-29 to isolate the post-relabel-only population.

## Already tested — do not re-run without a reason

Each of these was measured on the 5-year price panel with the spec above. Re-testing them costs days and returns the same answer. If you think one deserves another look, state what changed (more history, a different horizon, a different construction) before spending the time. Full derivation for any row: `docs/measurement-history.md`.

| Factor | Result | Verdict |
|---|---|---|
| `momentum_12_1` | net excess +0.686%/period, t=1.45 (post-fix; `factor_backtest.py --factor momentum_12_1 --rebalance 21 --top-k 50 --cost-bps 25`) — bit-identical across three independent runs (2026-08-23, 08-27, 08-29). The older "+0.53%/mo, t=1.10" this row previously quoted was stale and did not match any of the three reproductions; corrected 2026-08-29, live-verified rather than assumed | not significant |
| `value_book_to_price` | +0.78%/mo, t=1.99 (post-fix) | not significant; vendor history may be retrospectively restated |
| `insider_net` | net excess +0.29%/period, t=1.73 (re-run 2026-08-12, superseding the earlier +0.48%/t=2.05 which did not reproduce) | not significant |
| `momentum_21d` / `63d` / `reversal_21d` | negative, t up to −3.96 | dead |
| `high_vol` / `low_vol` | both negative (−1.21, −1.66) | **both tails lose**; the middle outperforms |
| `delivery_spike` / `delivery_trend` | t=−1.08 / −1.43 | dead |
| **`delivery_pct` (raw level, NOT the derived spike/trend above)** | quintile spread +0.19pp/day, t=+7.82 — but **long-only top-50 net excess −1.04%/period at 21d/25bps and −0.15%/period at 5d/15bps, t=−1.48 both** | **dead as a long-only factor** despite a real directional signal in the spread |
| `ticket_size` (institutional proxy) | −0.67%, t=−2.36 | significantly **inverted** |
| `smart_money` (`unified_ranker.py`'s live insider+block-deal+institutional-deal composite input) | Live-verified 2026-08-29 via a fresh `factor_edge.py --table unified_recommendations` run (not just a read of cached history): rank_ic=-0.000/hit_auc=0.502 (h1, 14 dates), rank_ic=-0.020/hit_auc=0.484 (h5, 10 dates) — the panel grew from the earlier 1-date read but is still under the ~15-20 date bar, and the early +0.0671 reading did not hold up as more dates arrived | **still LOW-DATA**, and now trending toward zero/negative rather than positive — consistent with, not contradicting, `ticket_size`'s significant inversion. Re-check again once ~15-20+ dates accumulate. A "Smart Money Override" that bypassed the validated `HIGH_VOL_VETO` was reverted 2026-08-12 — re-add only if this clears LOW-DATA and is positive, which is looking less likely than when this row was first written. |
| screener bullish consensus | IC −0.027, t=−2.36 | significantly negative; cleaning the labels made it *more* negative |
| `screener_breadth` | 5d/15bps top-50: −0.11%/period, t=−0.45 | not significant, low-power (9 periods) — re-test once ~12+ months exist |
| **every individual screener** (1,563, one at a time) | **0 survive FDR or Bonferroni** | population direction negative, sentiment labels inverted |
| 3 named "upcoming/recent results" screeners | 5d excess: +0.83%/t=1.76, +0.01%/t=0.02, +0.34%/t=0.59 | not significant, any of the three; too few dates to rule dead either |
| **`feature_store`** (23 candidate technical/fundamental/news columns) | **14 of 23 clear a 23-factor Bonferroni — all 14 negative** (stoch_d t=−9.28 worst). `rev_growth`/`eps_growth` 100% NULL — dead schema. | every clean-trend/overbought/high-volume reading is inverted — reconfirms the platform's dominant 5d mean-reversion finding via the full turnover/cost-aware harness |
| news sentiment | same-day +0.13 IC, next-day −0.03 | real but not tradeable — the move is over by the first entry you can take |
| `near_52w_high`, `low_beta`, `low_idio_vol` | insignificant | US-published factors that did not transfer |
| `low_max_ret` (lottery demand) | t=−3.12 | significantly **inverted** vs the published result |
| intraday (23 days, 256 configs) | best net at 15bps = −0.004% | edge exists in sign, smaller than costs |
| **`mojo_indigraph`** (MarketsMojo's own composite bullish/bearish call) | −0.08 to −0.14%/period, t=−0.15 to −1.26 | **no edge** — a vendor's standing directional call is not better than this platform's own |
| **sector-neutral (industry-relative) value & momentum** | every one worse than its raw parent; B/P +0.82→+0.46%/mo, t 2.08→1.12 | **rejected** — confound (smaller universe) ruled out with a registered control |
| `gap_down` (reconstructed, top-50/25bps/21d) | net excess −1.33%/period, t=−3.54, 1/6 years positive; 5d/15bps: t=−9.0 | **significantly negative net of costs** — ~90-93% one-way turnover is a turnover trap, not an edge |
| `gap_up` (same construction, control) | net excess −1.45%/period, t=−3.55, 0/6 years positive | **significantly negative net of costs**, same magnitude/sign as `gap_down` — both directions are the turnover trap |
| **`earnings_beat_yoy`/`earnings_beat_qoq`** (PEAD) | 5d/top-50/15bps: 3 periods, net excess −0.78%/period, t=−1.79 | **NOT significant, severely underpowered** — re-test once ~12+ months exist. `pead_score` (same family) graded separately: no edge at any horizon (1-21d), 37 dates, well-powered — AND has zero downstream readers; nightly schedule retired 2026-08-20 on that combined basis. |
| **`win_probability`** (factor-backtest construction) | 21d fails outright (calendar); 5d/top-50/15bps: 7 periods, net excess +1.52%/period, **t=+1.54, NOT significant**, 83.4% turnover, 12.61%/yr cost drag | **NOT significant** — see "Standing architecture facts" above for the full picture (real IC, AUC ceiling, cost drag: three independent disqualifiers) |
| **`breakout_classifier.py` / `movement_predictor.py` / `cs_ranker.py` / `confluence_ml_engine.py`** | Graded against each model's own NATIVE label (not the generic 1/5/21d grid, which was the first-pass mistake): `breakout_probability` IC +0.153/AUC 0.583 (19 dates, LOW-DATA); `ml_breakout_probability` IC +0.082/AUC 0.553 (44 dates) — **clears USABLE**; `movement_probability` had a real leak bug, now fixed, genuinely ungraded again; `cs_score` no edge (correctly configured on the first pass) | See "Standing architecture facts" above. `ml_breakout_probability` is next in line for a cost-aware `factor_backtest.py` pass. |
| **`screener_combo_finder.py --tier1`'s "capitulation" triple** (`gap_down AND open_eq_low AND top_loser`, next-session open→close, single day) | 430→658 signal-rows through 2026-08-20, spread +0.5064%/day net of 0.15%, **t=+3.48, p=0.0005**, clears the 41-combination Bonferroni bar, robust to winsorization and to dropping the top 3 most extreme days. 5/6 years positive (2026 YTD is the exception, thin partial year, t=−0.49 not significant). Reproduced bit-identical 2026-08-27. | **The one validated edge on this platform — but capacity-constrained, not scale-tradeable.** Median deployable capital ≈₹0.46cr/signal-day at a conservative 2%-of-ADTV convention (p90 ₹3.54cr); signals cluster at ~1/day (median), max 28 on one day. Real at small/personal/prop scale; do not build production infrastructure assuming it scales to meaningful AUM. |
| **screener CONCEPT-TAG membership as of D-1** (40 tags via `screener_name_concepts.decompose`, point-in-time from `screener_membership_snapshot`, top-20 daily gainers, 25 dates, `screener_tenure_mover_analysis.py`) | Winners-only: **8 of 40 tags clear a 40-tag Bonferroni** with large lifts (`mech_52w_high` 23.8% of gainers vs 10.6% of universe, t=6.70; `mech_overbought` t=6.43; `fund_growth` t=5.15). Graded against BOTH tails: **0 of 40 survive** — every one of the 8 lifts the LOSING tail as much or more (`mech_overbought` +13.7pp on gainers vs **+16.1pp on losers**; `flow_volume_surge` +7.9 vs **+12.5**; `mech_momentum` +8.8 vs +8.8, separation exactly 0.000). Best winners-minus-losers separation is `mech_52w_high` at 3.0pp, t=1.04. | **No directional edge — these are volatility detectors.** Screener membership predicts that a stock will MOVE, not which way, which is the same "AUC excellent and useless" shape `ml-model-bugs.md` records for `flyer_classifier`. Reproduces this file's standing finding by a new route. **The winners-only number is the trap**: it looks like a strong, multiply-corrected result and is entirely an artifact of selecting on the dependent variable. LOW-DATA (25 dates, just above the 20-date floor) but the both-tails collapse is not marginal. Tenure ("since when") inherits the same limitation — `tf_daily` t=-5.03 etc. says fresh entries MOVE, not that they rise. |
| **`mean_reversion_14`** (sign-flipped composite of the 14 negative feature_store factors, standalone long factor) | 278 periods/5.52yr: net excess +0.044%/period, **t=+0.64, NOT significant**, 2/6 years positive | Confirms this file's "combining/reweighting reduces performance" prior applies to this hypothesis too |
| **`mean_reversion_14`** (as a VETO on `momentum_12_1`'s pool instead — 2026-08-30, re-run same day against the full backfilled 2021-2026 `feature_store` history) | Same-dates paired, full history: 21d +0.27pp/period, paired t=1.50, n=54 (well-powered, down from a truncated-window t=1.75/n=17); 5d -0.01pp/period, t=-0.24, n=230 (no effect) | **NOT significant, CLOSED** — the earlier truncated-window "promising" reading was a regime-confounded artifact, not a real effect; do not re-test again |

## Not testable — do not spend time here without a genuinely new angle

- **Fundamentals, analyst, ownership and earnings factors**: every one of those tables has ~30 distinct dates, all starting 2026-06-30 (1–2 independent quarterly observations). Calendar constraint, not engineering — elapsed time or a backfill fixes it, nothing else does.
- **FnO / positioning (long/short buildup, short covering)**: built (`mc_stock_futures_oi_fetcher.py`, `stock_futures_oi_history`, composite-keyed `(source, symbol, date, expiry)`, scheduled daily, live-graded LOW-DATA) — see "Standing architecture facts" above. Not yet enough dates to verdict.
- Of 60 symbol+date tables audited 2026-08-11, only 9 have enough history to test anything at all; the other 35 start ~2026-06-30.
- **REGIME_WEIGHTS re-check, 2026-08-25**: `blend_walkforward.py` re-run across all 46 available sessions (up from ~8 at the time the trigger was set) — TILT alternative still fails its pre-declared bar (dIC −0.0003). Weights confirmed unchanged, again. This is a validation, not an improvement — do not cite it as one.
- **`technical_signals.date` is TEXT→DATE** (migration `20260825120000`, applied via a manual single-statement rerun after node-pg-migrate's sql-file runner silently executed only the file's first statement). Writers unaffected; `db/schema.postgres.sql` updated so new throwaway test schemas get DATE natively. A migration's ledger row proves execution of *a* statement, not necessarily the one you meant — verify the effect via `information_schema`, never the tool's exit code alone.
