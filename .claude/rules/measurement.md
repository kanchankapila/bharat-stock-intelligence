# Measurement Discipline

Read before quoting, comparing, or acting on any accuracy, win-rate, IC, or backtest number.

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

## Snapshot (verified 2026-09-04)

Quick live SQL checks, not a full harness re-run — see "Standing architecture facts" and "Open /
pending" below for what each of these means and what's still needed.

- **`unified_score` is still no-edge** and `REGIME_WEIGHTS['screener']` is still 0.0 in every
  regime (`unified_ranker.py`, read live) — the third shrink from 2026-08-30 is holding, nobody
  has silently reverted it.
- **The active ensemble's CV is still 0.5305**, trained 2026-08-29 — no retrain has landed since
  (check `model_registry` before quoting a different number).
- **`factor_edge_history`'s last full persisted sweep is 2026-08-30 — 5 days old as of today.**
  Nobody has re-run the whole-platform harness since; individual columns below were spot-checked
  by direct SQL instead. If you're about to make a scoring change, this is the harness to re-run
  first, not a reason to distrust the numbers below (spot-checks match what a full sweep would
  read for date COUNTS; they don't replace a fresh IC/AUC computation).
- **Three populations cleared their date floor since they were last written up — all three are
  now gradeable and none has been graded yet. This is this file's most actionable finding today:**
  - `smart_money_score`: **21 non-zero dates** (was 14 on 2026-08-29, needed ~15-20). Past this
    file's own reliability floor for the first time. Run `factor_edge.py --table
    unified_recommendations --scores smart_money_score` before trusting the "still LOW-DATA"
    framing in "Already tested" below — that framing is now stale, the grading itself isn't done.
  - `technical_signals.ext_*` (11 MarketsMojo/Trading80/FII-DII vendor columns): **39 dates** (was
    4 on 2026-08-30, needed ~20). Cleared the floor by a wide margin. Ready for `factor_edge.py`.
  - `ccc_trend`: **82 dates, spanning 2026-05-16→2026-09-03** (previously framed as "just needs a
    second fiscal year"). It has one now. Ready for a YoY factor grading.
- **Two populations are closer but still under the floor** — correctly still LOW-DATA, not stale:
  `movement_probability` post-fix: ~11 dates (was 7 on 2026-08-29, floor ~20 — the exact count
  depends on which join you use, re-derive rather than trust this to the date); `stock_futures_oi_
  history` OI/basis/rollover columns: 9 dates (was ~3 on 2026-08-27, floor ~20).
- **The analyst-revision trio UNBLOCKED ON SCHEDULE, 2026-09-05 — and a bug was destroying the
  data on arrival.** This file predicted "unblocks ~2026-09-05" and that was exactly right: 1,052
  symbols now have a qualifying 90-day prior snapshot (`analyst_estimates_history` spans
  2026-06-21 to 2026-09-05, and the lookback window's lower edge only just reaches it). But
  `analyst_revision.py` crashed on every run with `bigint out of range` — pandas converts the
  script's `None`s to `NaN` in a float64 column, defeating its own skip guard, and
  `technical_signals.analyst_count_chg` is `bigint`, which cannot take a NaN. Fixed and
  live-verified 2026-09-05 (AF-20260905-20): 280 NaN eps + 1 NaN count now write as NULL, and
  1,036 of 1,052 rows match real `technical_signals` rows on a trading day.
  **Still ungraded** — the first real rows land Monday 2026-09-08, and ~20 dates are needed
  before `factor_edge.py` can say anything. Do not grade this before ~2026-10.

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
- **Grade every candidate factor against BOTH tails**, not just AUC-vs-winners — an AUC computed only against winners cannot tell "predicts winners" from "predicts volatility" (this codebase has been fooled by that exact statistic three times now, most recently 2026-09-04's screener-tenure result below). Report AUC vs the winning tail, AUC vs the losing tail, AUC of one tail against the other.

## Standing architecture facts (still true — dates below say when each was last checked)

- **The ML training label is `triple_barrier`** (`signal_excursions.tb_label`, a cost-aware López de Prado barrier), not the old `path_barrier`-derived `horizon` label that inflated CV to 0.7664 by measuring the label's easiness rather than skill — the honest label gives CV 0.5203 at the switch, and the incumbent trained 2026-08-29 reports 0.5305 (**verified still active, 2026-09-04**) — both matching live realized AUC (0.49–0.53). **Promotion gates on `factor_edge_history`, not just CV**: `model_promotion.py`'s `live_edge_verdict()`/`live_edge_is_unproven()` skip the CV-margin bar entirely when the label changed, and treat the incumbent's own realized `factor_edge_history` reading as the bar when it fails `|rank_IC|>=0.03 AND hit_AUC>=0.55`. A "never graded" column is NOT read as "no edge" (that would auto-override on zero evidence), and a reading under `MIN_DATES_RELIABLE=20` cannot override either.
- **`win_probability` has a real, small IC on a terminal-return grading, but it keeps decaying toward null as its panel grows, and AUC never clears 0.55** (last read: 2026-08-29, IC/AUC +0.020/0.500 @1d 57 dates, +0.065/0.510 @5d 53 dates, +0.084/0.523 @21d 37 dates — this itself is a decay from earlier reads, see `measurement-history.md`). Graded against its own real training label instead (`signal_outcomes`, `path_barrier`, decisive WIN/LOSS) it DOES clear `USABLE` at 1d/5d (AUC 0.617/0.600), but that is a same-shape base-rate artifact of the barrier construction, not proof of tradeable skill, and the cost/turnover-aware `factor_backtest.py` run still fails (5d/top-50/15bps: 7 periods, net +1.52%/period, t=1.54, not significant, 83.4% one-way turnover, 12.61%/yr cost drag). Two independent disqualifiers — do not trade this as scored today. Due for a fresh read (panel has likely grown past 60/56/40 dates by now — cheap to re-check, nobody has since 2026-08-29).
- **`ml_breakout_probability`** (a sub-engine feeding `confluence_ml_engine.py`, native label = `signal_outcomes` WIN/LOSS h=7) clears `USABLE` outright — IC +0.082, AUC 0.553, n=44 dates (**last read 2026-08-29**). The strongest previously-ungraded result measured on this platform; has zero downstream readers today (advisory only), and has not yet had the cost-aware `factor_backtest.py` follow-up `win_probability` got.
- **`breakout_probability`** (native label = fwd-10d max return ≥ +6%) reads IC +0.153/AUC 0.583 at 19 dates (**last read 2026-08-29**) — one date short of `MIN_DATES_RELIABLE` at the time; likely cleared it by now given ~1 trading date/day since — cheap re-check, not yet done.
- **`breakout_classifier.py`'s feature set was extended with delivery/sector/options candidates and measured live 2026-09-02** — both testable candidates came back null, so `FEATURE_COLS` was left unchanged (still the original 22). Sector-relative return moved purged-OOF AUC 0.6130→0.6131 and held-out test AUC 0.6399→0.6402 — noise. Delivery% moved OOF AUC not at all. Options OI was judged too sparse to measure. Reproducible via `--sector-ablation`/`--delivery-ablation` if the universe/regime mix changes materially.
- **`movement_probability`** had a real train/serve-skew bug (fixed 2026-08-20; every value written before that date is tainted). Post-fix population: **~11 dates as of 2026-09-04** (was 7 on 2026-08-29), still under the ~20-date floor. Re-check the exact count with a fresh join once you're about to grade it — the 11 above is a quick estimate, not the canonical method's output.
- **The IC-real-but-AUC-stalls-near-0.52 shape recurs across 7+ architecturally unrelated engines** (`win_probability`, `cs_score`, `ml_breakout_probability`, `prob_up_5d`@15d, the confluence composite, `engine_composite_scores`). Tested directly (Gaussian-copula simulation matched to each engine's measured IC): for most horizons the measured AUC is exactly what that IC mechanically implies — this is a property of the correlation magnitude at this sample size, not a fixable measurement artifact. Raising it needs IC ≥ ~0.15, not a better classifier or a different AUC threshold. The engines really are independent (max pairwise Spearman rho 0.29 on a z-scored panel) — the shared ceiling is not redundancy.
- **`_blend` normalizes all 8 engines onto the same 0–100 scale before averaging** (fixed 2026-08-22). `ZERO_DISPERSION_MIN_SD = 5.0` is calibrated for this 0–100 scale only — applying it to a raw 0–1 probability column (e.g. `win_probability`) will read nearly every engine as collapsed; this has already produced one confidently-wrong ablation result.
- **`calibrated_win_probability`'s 2–7 distinct-value collapse on days when the day's raw `win_probability` spread lands inside one isotonic step is NOT a defect — do not "fix" it.** Tested directly: tie-breaking within a collapsed band to restore raw ordering costs 23% of h=5 IC for +0.007 at h=21 — the collapse is the isotonic fit correctly discarding within-band ordering that doesn't predict at 5d. Monitored by `ur-engine-dispersion-collapse` (warns 60%/fails 80%) and `ur-engine-score-zero-not-null`. **Last read 2026-08-29**: `ml`'s collapse rate over the last 10 ranker dates was 80%, and `dq:check` reported WARN not FAIL. **Resolved 2026-09-05 — there was no discrepancy to chase:** the 80% "documented fail threshold" came from a STALE COMMENT in `dataQualityChecks.ts` (it claimed warn 60 / fail 80); `evaluate()` has always used **warn >= 75%, fail >= 90%**, so WARN at 80% was correct behaviour. The comment has been corrected; the code was deliberately left alone, since this same file establishes that `ml`'s collapse is the isotonic fit working as intended and must not be "fixed". Re-verified live 2026-09-05: still ml 80% / dl 0% / technical 0%, still WARN.
- **Two population boundaries apply to `unified_recommendations`' reporting `*_score` columns and must be filtered on, never pooled across:** `2026-08-18` (zero-vs-NULL fix — before this date a `0.0` in `ml_score`/`dl_score`/etc. could mean either "engine scored zero" or "engine never ran," pre-fix rows must NOT be repaired/backfilled); `2026-08-23` (trading-day calendar-cutoff fixes — before this date `dl_score` was silently zero on ~5 of 8 Mondays).
- **7 `technical_signals` columns have never been written, and none is a bug** — `fcf_yield`/`created_at` are droppable schema debris; `pledge_chg_90d` is calendar-blocked. **The analyst trio (`eps_revision_3m_pct`/`target_revision_3m_pct`/`analyst_count_chg`) is no longer in this list** — its calendar constraint cleared on 2026-09-05 exactly as predicted, and the writer bug that was discarding the data was fixed the same day (see the Snapshot above and AF-20260905-20). First rows land 2026-09-08. `ccc_trend` is no longer in this list — **it now has 82 dates and is ready to grade**, see the Snapshot above.
- **The DL BiLSTM's first real walk-forward AUC (0.6493, 2026-08-25) was rejected by the saturation guard** (`frac_saturated=0.536` > `MAX_SATURATION_FRAC=0.5`) — champion stays v3. The guard working as designed, not a bug. If saturation persists across future retrains, the next lever is label/loss-side calibration, not gate tampering. Check `model_registry` for a fresher BiLSTM row before quoting this as current — none had trained as of 2026-08-30 (a scheduler defect, since fixed).
- **`stock_futures_oi_history`** (F&O long/short buildup, rollover, basis) — `oi_change`/`oi_pct_change`/`oi_pcr`/`basis`/`rollover_pct` all still LOW-DATA at **9 dates as of 2026-09-04** (was ~3 on 2026-08-27). `oiBuildup` deliberately not graded — vendor text label. Re-check once ~20 dates accumulate.

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
- **`technical`'s next-session-entry directional call** (t=+2.13 at 1d on 12 dates as of the last check, under this file's own 20-date bar) — likely has more dates by now, cheap to re-check.
- **`earnings_beat_yoy`/`earnings_beat_qoq`, `screener_breadth`, the 3 named results screeners** — all underpowered (3–27 periods), genuinely calendar-blocked until ~12+ months of history exists in their source tables.
- **`cs_ranker`'s active model has a declining self-reported CV-AUC across 3 consecutive retrains** (0.176 active vs 0.161/0.161/0.133 rejected) — flagged, not confirmed as a bug (self-reported CV-AUC on a thin date-split holdout is exactly the kind of number this file warns not to trust blindly). Worth a dedicated look; check whether a 4th retrain has happened since.
- **`win_probability` sub-population split** (grid-scored vs. pattern-fired via `signals_json IS NOT NULL`) has never been explicitly re-graded to confirm the two sub-populations behave the same way — flagged, not measured.
- **`mc_fno_eligible`/`mc_del_acceleration`** are cheaply derivable but deliberately not built — the risk was a formula silently disagreeing with the fetcher's own definition. Revisit if prioritized.
- **`engine_composite_scores`'s producer runs weekly** (inside `processMlWeeklyRetrain`); check `job_heartbeat` for its current status before trusting the composite score is fresh — this row has had reliability problems before (see `measurement-history.md`).
- **`dl_score` in `unified_recommendations_history`** IS stored (migration `1787110000000`, applied 2026-08-21) with 100% non-null coverage from 2026-08-22 onward — any blend-decomposition analysis is unblocked for that window; don't re-derive that the column is missing.
- **`technical_signals.screener_momentum_score` reclassification effect** — the underlying column shows real signal under the OLD screener labels (21d clears USABLE: rank_IC 0.217, hit_AUC 0.552, 33 dates, measured 2026-08-29), but the 2026-08-29 screener reclassification's OWN effect is still genuinely calendar-blocked — needs ~20+ trading dates generated after 2026-08-29, which is only ~4 trading days old as of today. Re-run `factor_edge.py --table technical_signals --scores screener_momentum_score --entry open` once that accumulates, filtering to post-2026-08-29 dates only.

## Already tested — re-run any of these anytime; here's what the last run found

These were measured on the 5-year price panel with the panel spec above. Re-testing one is
usually a single command and costs minutes, not days — the bar for re-running isn't high, it's
just "have something changed" (more history, a different horizon, a different construction,
different code). State that in one line and go; you don't need permission. Full derivation for
any row: `docs/measurement-history.md`.

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
| `smart_money` (`unified_ranker.py`'s live insider+block-deal+institutional-deal composite input) | Live-verified 2026-08-29: rank_ic=-0.000/hit_auc=0.502 (h1, 14 dates), rank_ic=-0.020/hit_auc=0.484 (h5, 10 dates) — trending toward zero/negative rather than positive. **Superseded by the Snapshot above: the panel is now 21 non-zero dates, past the reliability floor for the first time — this row's verdict needs a fresh grading run, not another read of the 2026-08-29 numbers.** | **stale — ready to re-grade, see Snapshot** |
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
| **`mean_reversion_14`** (as a VETO on `momentum_12_1`'s pool instead — 2026-08-30, re-run same day against the full backfilled 2021-2026 `feature_store` history) | Same-dates paired, full history: 21d +0.27pp/period, paired t=1.50, n=54 (well-powered, down from a truncated-window t=1.75/n=17); 5d -0.01pp/period, t=-0.24, n=230 (no effect) | **NOT significant, CLOSED** — the earlier truncated-window "promising" reading was a regime-confounded artifact, not a real effect; do not re-test again without a genuinely new angle |

## Not testable — do not spend time here without a genuinely new angle

- **Fundamentals, analyst, ownership and earnings factors**: every one of those tables has ~30 distinct dates, all starting 2026-06-30 (1–2 independent quarterly observations). Calendar constraint, not engineering — elapsed time or a backfill fixes it, nothing else does.
- **FnO / positioning (long/short buildup, short covering)**: built (`mc_stock_futures_oi_fetcher.py`, `stock_futures_oi_history`, composite-keyed `(source, symbol, date, expiry)`, scheduled daily, live-graded LOW-DATA at 9 dates as of 2026-09-04) — see "Standing architecture facts" above. Not yet enough dates to verdict.
- Of 60 symbol+date tables audited 2026-08-11, only 9 have enough history to test anything at all; the other 35 start ~2026-06-30.
- **REGIME_WEIGHTS re-check, 2026-08-25**: `blend_walkforward.py` re-run across all 46 available sessions — TILT alternative still fails its pre-declared bar (dIC −0.0003). Weights confirmed unchanged. Live-reverified 2026-09-04 that `REGIME_WEIGHTS['screener']` is still 0.0 in every regime — a validation, not an improvement, do not cite it as one.
- **`technical_signals.date` is TEXT→DATE** (migration `20260825120000`, applied via a manual single-statement rerun after node-pg-migrate's sql-file runner silently executed only the file's first statement). Writers unaffected; `db/schema.postgres.sql` updated so new throwaway test schemas get DATE natively. A migration's ledger row proves execution of *a* statement, not necessarily the one you meant — verify the effect via `information_schema`, never the tool's exit code alone.
