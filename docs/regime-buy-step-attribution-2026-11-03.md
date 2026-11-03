# Task 5 report: regime step in Buy counts, and `nifty_regime`

Status: DONE_WITH_CONCERNS. Attribution complete. No code changed and no commit: the `nifty_regime` writer defect is real, but it contributes nothing to the Buy step, and either fix moves a score input, so its direction needs a user decision (section 4).

All SQL was read-only against `127.0.0.1:5433/bharat_intel`, run 2026-11-03. Scripts: `C:/Users/amitk/AppData/Local/Temp/claude/d--Github-bharat-stock-intelligence/cb76d7eb-22b4-4e9c-b80f-e6567b371a4d/scratchpad/t5/` (`lib.py`, `attr.py`, `nc.py`, `h.py`, `z.py`, `replay.py`).

## 1. Result

**Verified: the Buy step is the regime weights, about 105% of the move on both transitions.** Engine scores and vetoes/multipliers are the same size as same-regime daily noise.

| transition (run, UTC) | Buy+Strong Buy | regime weights | engine scores | multipliers + gates | sum |
|---|---|---|---|---|---|
| T1: 10-16 17:00 BEAR -> 10-19 17:00 HIGH_VOL | 307 -> 54 | **-265.1** | +0.4 | +11.7 | -253.0 |
| T2: 10-20 02:00 HIGH_VOL -> 10-21 17:00 BEAR | 46 -> 293 | **+258.5** | +6.4 | -17.8 | +247.0 |
| control: 10-15 -> 10-16, BEAR both | 312 -> 307 | 0 | -7.3 | +2.3 | -5.0 |
| control: 10-21 -> 10-22, BEAR both | 293 -> 283 | 0 | -3.5 | -6.5 | -10.0 |
| control: 10-13 -> 10-14, BEAR both | 297 -> 316 | 0 | +4.0 | +15.0 | +19.0 |
| control: 10-19 -> 10-20, HIGH_VOL both | 54 -> 46 | 0 | -7.9 | -0.1 | -8.0 |

Values are three-factor Shapley averages over all orderings, on the symbols present in both runs. No Buy sat outside that panel in any pair. Path dependence is small: the weights step alone is -264.1 to -265.1 on T1 and +246.4 to +268.2 on T2.

Thresholds are not a factor. `_classify` takes no regime, and no commit touched the 70/80/30/20 floors, the veto constants or the VIX floors between 10-10 and 10-27 (git log, 0 commits).

**Verified mechanism: `technical` ties plus the HIGH_VOL tilt put a ceiling below the Buy line.** 94-95% of names tie at `technical_score` about 47.5. After renormalising over the engines actually in the blend:

| era | regime | conf / tech / breakout share | best score for a tied name | lowest for a tied name |
|---|---|---|---|---|
| before 10-26 | BEAR | 0.62 / 0.31 / 0.07 | 83.5 | 15 |
| before 10-26 | HIGH_VOL | 0.30 / 0.59 / 0.11 | **69.0** | 28 |
| from 10-26 | BEAR | 0.66 / 0.34 / 0 | 82.4 | 16 |
| from 10-26 | HIGH_VOL | 0.33 / 0.67 / 0 | **65.0** | 32 |

So under HIGH_VOL a name without a positive pattern cannot reach 70, whatever its confluence score. Live check on the four HIGH_VOL runs tested: every Buy is above the tie (54/54, 46/46, 52/52, 74/74), and 0 are tied. The four BEAR runs tested carry 239-266 tied Buys. Only 101-123 names sit above the tie on any run, which is what bounds the count.

The Buy count on HIGH_VOL days is therefore a count of pattern names surviving the multipliers and gates, not a tighter cut of a ranked list. AF-20261026-50 keeps the ties deliberately. This does not argue against that, but nobody has measured this interaction as a selection rule.

Swap test on every run, same engine scores and multipliers, other regime's weights:

| runs | actual Buys | under the other regime |
|---|---|---|
| BEAR, 10-13..10-23 (8 runs) | 278-316 | 36-52 |
| HIGH_VOL, 10-19 and 10-20 | 54, 46 | 318, 314 |
| HIGH_VOL, 10-26..11-02 (post-breakout) | 52-74 | 363-397 |

## 2. Reproduction, read before trusting the counterfactuals

**Verified, score match:** recomputing `base blend x discrete multiplier` from `unified_recommendations_history` reproduces the published `unified_score` within 0.25 on 100.0% of rows, on all 16 runs from 10-13 to 11-02 (about 2,350 rows each, 37,572 total).

Negative control, multiplier match at tolerance 0.002 (share with multiplier exactly 1 in brackets):

| weights used | match |
|---|---|
| actual regime, actual era | **99.6-99.8%** (29-35%) |
| wrong regime | 16-22% (2-4%) |
| wrong era | 18-23% (2-4%) |
| `ml` forced into the blend | 17-19% (2-3%) |

What the replay needed:
- **Period weights, not lines 413-420.** The brief's lines hold the post-10-26 weights. Runs before e3708033 (10-26 13:15 IST) only reproduce with `e3708033^`'s weights, which include breakout at 0.05/0.10. T1 and T2 use those.
- **`ml` out of the blend.** Its stored sd is 0.02-0.55 against the 3.0 floor in `drop_zero_dispersion_engines`, so it is dropped on all 16 runs. `engine_coverage_count` agrees (99.9-100%).
- **Breakout percentile from `technical_signals` as of the run.** Two runs (10-14 01:41, 10-16 17:00) only reproduce with the previous session's `breakout_probability`, about 50-58% match otherwise. I chose that snapshot because it matched, so treat it as fitted. **Likely:** that session's scoring landed after the run.
- **Stored `s_conf` and `s_tech` are already percentiles,** over a wider symbol set than the tradeable universe, so they are used as stored.

**Limits:**
- n = 2 transitions on 4 runs, in one three-week stretch.
- This is a count attribution. It says nothing about which regime's Buys earn more.
- `unified_recommendations_history` holds every engine score the blend needs on these runs (a name absent from an engine is NULL, which matches coverage), but it stores no flag for the `actionable_without_plan`/no-screener gates. Plan fields are populated on Buy rows only (plan count equals Buy count on every run checked).
- So a name crossing 70 only in a counterfactual has an unknown gate. I applied that run's observed pass rate (0.84-0.98). The tight bounds are T1 at BEAR scores, HIGH_VOL weights: 41.9 [40, 42]; T2 at BEAR-era scores, HIGH_VOL weights: 46.6 [43, 47].
- The other direction (HIGH_VOL scores, BEAR weights) is 318 with a formal range of [54, 323], because 269 names have unknown gates.
- The label match reported by `attr.py` (99.96-100%) is partly circular, since known vetoes were read from the label. Only the score match is independent.
- Post-10-26 swap numbers must not be pooled with earlier runs (AF-20261026-44). T1 and T2 sit before that boundary.

## 3. Step 1: the two values

**Verified, who wrote what.** There are three writers, and no separate `UPDATE` of the column; the scan's upsert overwrites it on conflict (grep of `src/server` and `scripts`). Timestamps are `computed_at` as stored:

| date | writer (`signal_type`, `computed_at`) | rows | value |
|---|---|---|---|
| 2026-10-30 | `technicalSignalsService.ts` scan (NULL, 04:30-10:00) | 341 | BEAR |
| 2026-10-30 | `run_full_universe_today` GRID (single stamp 18:50) | 1,819 | HIGH_VOL |
| 2026-11-02 | scan (NULL, 05:43-10:00) | 320 | BEAR |
| 2026-11-02 | GRID (single stamp 18:50) | 1,838 | HIGH_VOL |

The symbol sets are disjoint by the `(symbol, date)` key with `ON CONFLICT DO NOTHING`. The third writer, the `get_regime` gap filler (line 199, `BACKFILL`), wrote nothing on these dates.

**Verified, two separate mechanisms:**
1. **Vocabulary.** The scan and `get_regime` collapse HIGH_VOL/CRASH to BEAR. `run_full_universe_today` (`backfill_technical_features.py`, the `regime = next(...)` block before line 417) stamps the raw 5-state label. 11 dates since 2026-08-10 read BEAR,HIGH_VOL.
2. **Timing.** `regime-detector` runs at 11:15 UTC, so the morning scan stamps T-1's label while GRID stamps T's. 2026-09-29 reads SIDEWAYS (scan) and BEAR (GRID) with no HIGH_VOL involved. 6 dates carry a pair the collapse cannot produce (5 BEAR,SIDEWAYS and 1 HIGH_VOL,SIDEWAYS); I traced only 09-29 by writer. A vocabulary fix alone would not make the field single-valued, and `bindings.py` documents it as "stamped at write time".

Not traced: scan rows read HIGH_VOL on 27 dates through 2026-08-07 despite the collapse commit of 07-21. The split starts 08-10.

**Meant to be market-wide: Verified** by the ledger (AF-20260927-19) and by `ml_calibration` treating it as a per-regime key. **But consumers are built on five values, not three:**
- `get_regime`'s comment and `collapse_regime5`'s docstring state a 3-state contract (2026-07-19).
- `ml_ensemble.REGIME_MAP` gained HIGH_VOL -0.5 and CRASH -2.0 on 2026-07-30 (Finding #19).
- `regime_edge_weight` deliberately reads HIGH_VOL's own row first since the 2026-08-10 bug fix, pinned by `test_regime_edge_weight_high_vol_and_crash_use_their_own_row_when_present`.

**What reads it and what the split changes:**

| reader | effect of the split | status |
|---|---|---|
| `unified_ranker._get_ml_scores`, edge gate | scan row w = 0.016 (BEAR slope), GRID row w = 0 (HIGH_VOL slope -0.106, clamped), both from the 11-02 `regime_edge_status` snapshot, which keeps no history. Blend effect **zero**: `ml` is dropped on all 16 runs | Verified |
| `unified_ranker._get_win_probabilities`, sizing | Scan names can get a tiny non-zero `ml_bet`; GRID names get exactly 0 | Likely, from code |
| `ml_calibration` isotonic fit | Same date, near-equal raw probability, different calibrated value: 10-30 scan raw 0.483 -> 0.262, GRID raw 0.488 -> 0.419 | Verified |
| `scoring_engine` Factor 3 | Reads `COALESCE(calibrated, win)`, so inherits that 16pp gap into `stock_scores` | Likely, from code |
| `ml_calibration` AUC/slope, `regime_edge_status` | BEAR sample holds 1,579 scan rows from HIGH_VOL days (3.5% of 44,894); HIGH_VOL sample is 43,117 rows, all stamped on HIGH_VOL days | Verified |
| `ml_ensemble` feature `regime` | HIGH_VOL -0.5 vs BEAR -1.0 on one date. Not in the active model's top 15 importances; its full weight is not checked | Likely |
| `ml_signal_scorer` | 3-class map, so HIGH_VOL falls to 0.0 (SIDEWAYS) | Verified, from code |
| `sectors.router.ts:554`, `strategySignalsService.ts:117` | `ORDER BY date DESC LIMIT 1` with no tie-break, so the label returned is arbitrary on split dates. `regimeSectorFilter` only acts on BULL, so it is unaffected today | Verified, from code |
| `computeSignalTypeStats`, `performance_tracker`, `reward_engine`, `backtester`, `exit_policy`, `ml.router`, `technicals.router` | Segment or display by the row's stamp, so the same date lands in two buckets | Verified, from code |

**Disconfirming check that the split caused the Buy step:** if it had, the replay without `ml` could not reach 100% on HIGH_VOL runs. It does, and forcing `ml` in drops the match to 17-19%. **Verified: the split contributes 0 Buys on these runs.**

## 4. Step 3: no fix, needs a decision

The brief's trigger is met: one market-wide field carries two values on one date from a writer difference. **I changed no code** because every fix moves a score input, which the global constraints forbid, and the broken state is enforcing something people asked for.

**Option A, collapse in GRID (the brief's candidate).**
- New GRID rows on HIGH_VOL days join BEAR's calibrator: on the 10-30 figures, about 0.42 -> 0.26 in `calibrated_win_probability` (Likely). That reaches `scoring_engine`.
- `ml_bet` turns non-zero for the roughly 42% of GRID rows above 0.5, changing sizing (Likely).
- HIGH_VOL's own sample freezes, while about 1,800 rows a day from HIGH_VOL periods enter BEAR's. That changes BEAR's slope and calibrator on BEAR days too.
- It reopens the 2026-08-10 bug by another route: HIGH_VOL rows borrowing BEAR's trust. While BEAR's slope is near 0 this is latent; it read 0.47 in the test's 2026-09 live snapshot.
- It leaves the timing split.

**Option B, stamp the raw label in the scan, keeping the collapsed value for its gating.**
- Keeps the 5-class consumers honest and cleans BEAR's sample.
- `computeSignalTypeStats` would bucket new scan rows under HIGH_VOL while `loadSignalWinRates`/`loadLearnedWeights` look up BEAR, so `signal_score` inputs drift unless that reader changes too.
- It also leaves the timing split, and it reverses a deliberate 07-19 decision.

**Option C, leave the writers, and add a tie-break to the two `LIMIT 1` readers.** No score moves. The calibration gap stays.

My recommendation is B or C, not A. Neither is urgent, since no option changes today's Buy counts. The brief asked for test-first work only if a fix is made, so no test exists.

## 5. Hysteresis verdict

**Verified: the label flips faster than its inputs justify.**
- **T2, 10-19 -> 10-20:** no new NIFTY session exists (`lastbar` 10-19 for as-of 10-20). `nifty_ret_21d` and `nifty_vol_21d` moved 0.00 scaled. The label went HIGH_VOL (p 0.886) -> BEAR (p 0.571), then BEAR at p 0.355 on 10-21. The 10-19 Viterbi path tagged its last 3 sessions HIGH_VOL; the 10-20 path tagged the same sessions BEAR. Buys went 307 -> 54 -> 46 -> 293 around it.
- **What did move was a revision of the same session.** Stored 10-19 inputs were A/D 0.585 and VIX 14.06; re-read today, the same bar is A/D 0.195 and VIX 14.77. **Likely:** `regime-detector` at 11:15 UTC reads breadth and VIX before they are final. Cause of the 1-session episode cannot be confirmed, because the model then in force is not archived.
- **Size of input move on flip days,** scaled by the model's scaler, L2 since 08-17 (n = 57, median 1.20, p75 1.60, p90 2.05):

| flip | L2 |
|---|---|
| 08-17 | 0.83 |
| 09-29 | 2.25 |
| 10-19 | 1.52 |
| 10-20 | 2.15 (the same-bar revision above) |
| 10-26 | 1.42 |

Three of five flips are ordinary days or quieter.
- **Duration:** 12 of 30 episodes in 2026 lasted 2 sessions or fewer, 9 of them 1 session (5 of those 9 are one-day SIDEWAYS rows on weekend dates, May-July).
- **There is no persistence rule anywhere on the path.** `_get_regime` takes the latest row; `_label_day` re-decodes the 120-day Viterbi path each day; `_effective_regime_for_weights` only applies the VIX floor (VIX was above 14 throughout).

**The 10-26 onset looks like a model swap, not the market. Likely.**
- `hmm_regime.pkl` was rewritten 2026-10-25 14:57. `hmm_state` for HIGH_VOL moved from 3 to 4 between the 10-19 and 10-26 labels.
- Replaying the current model read-only labels all 11 dates tested between 10-14 and 11-02 HIGH_VOL at p 0.98-1.00, including the rows stored as BEAR. Substituting the features as stored at the time gives HIGH_VOL for 10-19, 10-20 and 10-23.
- So the current model does not separate 10-23 from 10-26. The old model is not archived, so "old model on 10-26" cannot be run; that is why this stays Likely.
- Consequence: **about 50 vs about 300 Buys a day can follow a weekly HMM retrain with nothing changing in the market.**

No weight, threshold or label change is justified by any of this. It describes instability, not which label earns more.

## 6. What measurement would justify a change

Nothing here is a reason to change now. Each needs pre-registering first, per `measurement.md`.

1. **The HIGH_VOL tilt as a selection rule.** On HIGH_VOL runs, grade the displaced set (Buy under BEAR weights, not under HIGH_VOL; about 300 a day) against the kept set (46-74 a day).
   - Excess against the same-day, same-liquidity-decile MEAN, dated by `generated_at` in IST, next-session open-to-close and 5-session on disjoint windows, net of cost.
   - Change only if the displaced set's net excess is positive at t >= 2 in both halves on at least 20 independent periods. If the displaced set loses, the cap is doing useful work and should be kept.
   - Do not pool across the 10-26 boundary. HIGH_VOL's post-boundary count is 6 runs, so this is calendar-blocked (about 20 HIGH_VOL sessions at h=1, about 100 at h=5). The earlier population can be run separately on replayed scores using `lib.py`'s method.
2. **Label persistence.** Pre-register k-session confirmation (k = 2, 3) and a `regime_prob` floor. Replay on stored labels, reporting flips avoided and Buy-count swing, then the paired IC delta under the existing "both halves" rule. Archive each promoted HMM pickle first, because replay under the model then in force is impossible today.
3. **Final vs provisional inputs.** Re-label a date range with final A/D and VIX and count how many labels change. That sizes the 11:15 UTC timing question without touching any weight.
4. **The `nifty_regime` direction.** Replay A and B offline over the HIGH_VOL episodes and report the shift in `calibrated_win_probability`, `regime_edge_status` and `position_size_pct`, before the user picks.

## 7. Corrections and new items for the ledger

- **Brief's range:** BEAR Buys were 278-316, not 278-312 (316 on the 10-14 17:00 run). 46-74 on HIGH_VOL confirmed. The two-value counts for 10-30 and 11-02 confirmed.
- **Date naming:** the brief's dates are `generated_at` (UTC) dates. The same runs have `computed_at` 10-19, 10-21, 10-21 and 10-22. 10-20 is not a `computed_at` or `technical_signals` session at all.
- **Candidates to open, not opened by me:**
  - Regime inputs read before final (10-19 and 10-23 differ from the re-read: VIX +0.71/+1.10, A/D -0.39/-0.16, and FII +0.45 on 10-23).
  - HMM pickles not archived, and a retrain can step the Buy count by a factor of about 5.
  - Unordered `LIMIT 1` regime readers.
  - `.candidate` from 11-01 exists unpromoted: confirm before the next retrain that it would not flip the label.
