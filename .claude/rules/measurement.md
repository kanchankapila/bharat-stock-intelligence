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

**Last full re-verification pass: 2026-09-10.** Every claim in the Snapshot, Standing
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

**The 2026-09-10 re-verification pass corrected six claims that had gone stale.** Each is marked
inline with `WAS ->` so the drift stays visible instead of being silently overwritten.

### The ranker

- **`unified_score` is NOT reading no-edge.** Do not quote the old "5d rank IC = 0.0001" figure —
  it was measured under the PRE-2026-08-30 weights. Measured 2026-09-10 (`factor_edge.py --table
  unified_recommendations --scores unified_score --date-col computed_at --entry open`):

      unified_score  ALL   5d   rank_IC +0.050  hit_AUC 0.522  n=37734  18 dates  LOW-DATA
      unified_score  ALL  10d   rank_IC +0.064  hit_AUC 0.529  n=27620  13 dates  LOW-DATA
      unified_score  ALL  21d   rank_IC +0.066  hit_AUC 0.531  n=4387    2 dates  LOW-DATA

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
  more sessions (**~2026-09-26/29**); (3) **no cost-aware `factor_backtest.py` pass has ever been
  run on `unified_score`.** An IC of 0.05 is not money — `win_probability` had a real IC too and
  still failed at 83.4% turnover.
- **`REGIME_WEIGHTS` re-read live 2026-09-10:** `screener`, `cs` and `smart_money` are **0.0 in all
  five regimes** (BULL / BEAR / HIGH_VOL / CRASH / SIDEWAYS). Nobody has silently reverted the
  shrinks.

### Models

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
  date-grouped `purged_cv` folds. **No honest DL number exists yet** — the first arrives from the
  next `dl-retrain-weekly`, and until then the correct statement is "ungraded", not any figure in
  `dl_model_config.json`. The active BiLSTM registration is dated 2026-08-10 and its `cv_roc_auc`
  is NULL (live 2026-09-10).
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
- **Two populations are still under the 20-date floor, but both grew:** `movement_probability`
  post-fix is at **15 dates** (WAS -> ~11 on 2026-09-04), spanning 2026-08-20..09-09;
  `stock_futures_oi_history`'s OI/basis/rollover columns at **14 dates** (WAS -> 9), spanning
  2026-08-21..09-09. Neither is gradeable yet.
- **`screener_momentum_score`'s post-reclassification panel is at 8 dates** (WAS -> "only ~4
  trading days old"). It needs ~20 dates generated after 2026-08-29, so ~late September —
  genuinely calendar-blocked, not neglected.

### Harness state

- **`factor_edge_history` is fresh:** latest `run_at` 2026-09-10T18:59 (this pass), 1,571 rows
  across 11 distinct `table_name` values. **Check the entry convention before reading any row** —
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
  engines, in its inverted form. **The remaining `feature_store` rows below (both
  `mean_reversion_14` arms, and the 23-column Bonferroni sweep) have NOT been individually
  re-run** — only these four representative columns were, so those rows keep their tags.

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

- **The ML training label is `triple_barrier`** (`signal_excursions.tb_label`, a cost-aware López de Prado barrier), not the old `path_barrier`-derived `horizon` label that inflated CV to 0.7664 by measuring the label's easiness rather than skill — the honest label gives CV 0.5203 at the switch, and the incumbent trained **2026-09-10 reports CV 0.5277** (`model_registry` id=322, **re-read live 2026-09-10**; supersedes the 0.5305/2026-08-29 figure this line carried, which had been overtaken by two retrains) — both matching live realized AUC (0.49–0.53). **Promotion gates on `factor_edge_history`, not just CV**: `model_promotion.py`'s `live_edge_verdict()`/`live_edge_is_unproven()` skip the CV-margin bar entirely when the label changed, and treat the incumbent's own realized `factor_edge_history` reading as the bar when it fails `|rank_IC|>=0.03 AND hit_AUC>=0.55`. A "never graded" column is NOT read as "no edge" (that would auto-override on zero evidence), and a reading under `MIN_DATES_RELIABLE=20` cannot override either.
- **`win_probability` has a real, small IC on a terminal-return grading, but it keeps decaying toward null as its panel grows, and AUC never clears 0.55** (last read: 2026-08-29, IC/AUC +0.020/0.500 @1d 57 dates, +0.065/0.510 @5d 53 dates, +0.084/0.523 @21d 37 dates — this itself is a decay from earlier reads, see `measurement-history.md`). Graded against its own real training label instead (`signal_outcomes`, `path_barrier`, decisive WIN/LOSS) it DOES clear `USABLE` at 1d/5d (AUC 0.617/0.600), but that is a same-shape base-rate artifact of the barrier construction, not proof of tradeable skill, and the cost/turnover-aware `factor_backtest.py` run still fails (5d/top-50/15bps: 7 periods, net +1.52%/period, t=1.54, not significant, 83.4% one-way turnover, 12.61%/yr cost drag). Two independent disqualifiers — do not trade this as scored today. **RE-GRADED 2026-09-10 (`--entry open`, persisted), and the decay continued: 5d rank_IC +0.056 / AUC 0.506 (64 dates), 10d +0.059 / 0.508 (59 dates), 21d +0.070 / 0.511 (48 dates) — `no edge` at every horizon.** The panel is now WELL-POWERED (all three horizons clear `MIN_DATES_RELIABLE=20`), so this is no longer a LOW-DATA caveat: it is a well-powered no-edge reading. Compare 2026-08-29: +0.065/0.510 @5d and +0.084/0.523 @21d — IC and AUC both fell again as dates were added, which is the same monotone decay this entry has recorded twice before.
- **`ml_breakout_probability`** (a sub-engine feeding `confluence_ml_engine.py`, native label = `signal_outcomes` WIN/LOSS h=7) clears `USABLE` outright — IC +0.082, AUC 0.553, n=44 dates (**last read 2026-08-29**). The strongest previously-ungraded result measured on this platform; has zero downstream readers today (advisory only), and has not yet had the cost-aware `factor_backtest.py` follow-up `win_probability` got. **The +0.082/0.553 figure is a NATIVE-LABEL reading and has NOT been refreshed since 2026-08-29.** A separate 2026-09-10 grading against the generic forward-return grid (`--entry open`, persisted — newly possible only because `factor_edge.py` could not read this table's `timestamptz` date column until that day's fix) reads **no edge at every horizon**: 5d +0.044/0.524 (48 dates), 10d +0.056/0.533 (43 dates), 21d +0.059/0.542 (32 dates), on a population that has grown to 73 dates / 5.88M rows. **These two readings do not contradict each other — they grade different targets**, and this file's own history records that grading an engine against the generic grid instead of its native label was the original first-pass mistake. The honest summary is: USABLE against its own label as of 2026-08-29, no edge against forward returns as of 2026-09-10.
- **`breakout_probability`** (native label = fwd-10d max return ≥ +6%) reads IC +0.153/AUC 0.583 at 19 dates against that native label (**last read 2026-08-29, still not refreshed**) — one date short of `MIN_DATES_RELIABLE` at the time. **Graded against the generic forward-return grid on 2026-09-10** (`--entry open`, persisted) it is now well-powered and reads **no edge**: 5d +0.001/0.505 (39 dates), 10d +0.023/0.506 (34 dates), 21d +0.024/0.516 (23 dates). Same caveat as `ml_breakout_probability` directly above — the native-label and generic-grid numbers measure different targets and neither refutes the other; what can be said is that nothing about this column predicts plain forward returns.
- **`breakout_classifier.py`'s feature set was extended with delivery/sector/options candidates and measured live 2026-09-02** — both testable candidates came back null, so `FEATURE_COLS` was left unchanged (still the original 22). Sector-relative return moved purged-OOF AUC 0.6130→0.6131 and held-out test AUC 0.6399→0.6402 — noise. Delivery% moved OOF AUC not at all. Options OI was judged too sparse to measure. Reproducible via `--sector-ablation`/`--delivery-ablation` if the universe/regime mix changes materially.
- **`movement_probability`** had a real train/serve-skew bug (fixed 2026-08-20; every value written before that date is tainted). Post-fix population: **15 dates as of 2026-09-10** (was ~11 on 2026-09-04, 7 on 2026-08-29), spanning 2026-08-20..2026-09-09 — still under the ~20-date floor, so still not gradeable. Re-check the exact count with a fresh join once you are about to grade it; the count above is a distinct-date read on the post-fix window, not the canonical harness's own matched-date output, which will be lower.
- **The IC-real-but-AUC-stalls-near-0.52 shape recurs across 7+ architecturally unrelated engines** (`win_probability`, `cs_score`, `ml_breakout_probability`, `prob_up_5d`@15d, the confluence composite, `engine_composite_scores`). Tested directly (Gaussian-copula simulation matched to each engine's measured IC): for most horizons the measured AUC is exactly what that IC mechanically implies — this is a property of the correlation magnitude at this sample size, not a fixable measurement artifact. Raising it needs IC ≥ ~0.15, not a better classifier or a different AUC threshold. The engines really are independent (max pairwise Spearman rho 0.29 on a z-scored panel) — the shared ceiling is not redundancy.
- **`_blend` normalizes all 8 engines onto the same 0–100 scale before averaging** (fixed 2026-08-22). `ZERO_DISPERSION_MIN_SD = 5.0` is calibrated for this 0–100 scale only — applying it to a raw 0–1 probability column (e.g. `win_probability`) will read nearly every engine as collapsed; this has already produced one confidently-wrong ablation result. **There is now also a per-engine override, `ZERO_DISPERSION_MIN_SD_BY_ENGINE = {"ml": 3.0}` (`unified_ranker.py:562`, read live 2026-09-10), which this file had never recorded** — so the global 5.0 is NOT the bar that applies to `ml`. Quoting 5.0 for `ml` inverts the verdict: ml's per-date sd over the last 10 ranker dates is 3.217-4.647, i.e. 10/10 collapsed at 5.0 and 0/10 at the live 3.0.
- **`calibrated_win_probability`'s 2–7 distinct-value collapse on days when the day's raw `win_probability` spread lands inside one isotonic step is NOT a defect — do not "fix" it.** Tested directly: tie-breaking within a collapsed band to restore raw ordering costs 23% of h=5 IC for +0.007 at h=21 — the collapse is the isotonic fit correctly discarding within-band ordering that doesn't predict at 5d. Monitored by `ur-engine-dispersion-collapse` (**warn >= 75%, fail >= 90%** — the "warns 60%/fails 80%" this line used to quote was itself the stale `dataQualityChecks.ts` comment corrected on 2026-09-05, contradicted three sentences later in this very bullet) and `ur-engine-score-zero-not-null`. **Last read 2026-08-29**: `ml`'s collapse rate over the last 10 ranker dates was 80%, and `dq:check` reported WARN not FAIL. **Resolved 2026-09-05 — there was no discrepancy to chase:** the 80% "documented fail threshold" came from a STALE COMMENT in `dataQualityChecks.ts` (it claimed warn 60 / fail 80); `evaluate()` has always used **warn >= 75%, fail >= 90%**, so WARN at 80% was correct behaviour. The comment has been corrected; the code was deliberately left alone, since this same file establishes that `ml`'s collapse is the isotonic fit working as intended and must not be "fixed". **SUPERSEDED 2026-09-10 — the check now PASSES at 0%.** Live read: *"ml 0%, dl 0%, technical 0% of last 10 dates (baseline 2026-08-22: dl 39%, ml 34%, technical 18%)"*, status `pass`. The change is not a change in ml's behaviour but in the bar applied to it — the per-engine `ZERO_DISPERSION_MIN_SD_BY_ENGINE = {"ml": 3.0}` override (see `_blend` entry above). ml's measured sd is 3.217-4.647, unchanged in character from the 2026-09-05 read; only the threshold moved. The substantive finding — that the banding is the isotonic fit working as intended and must not be "fixed" — is unaffected.
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
- **MEASURED 2026-09-10 — all four live engine scores graded together on `unified_recommendations` (`--entry open`, persisted). `confluence` is carrying the ranker and it is not close:**

      confluence_score   5d +0.084/0.542   10d +0.113/0.558   21d +0.168/0.583
      technical_score    5d +0.024/0.509   10d +0.017/0.506   21d +0.013/0.503
      ml_score           5d +0.021/0.503   10d +0.026/0.506   21d -0.013/0.500
      dl_score           5d +0.007/0.506   10d -0.008/0.496   21d -0.008/0.494

  **Every row is LOW-DATA** (18 dates at 5d, 13 at 10d, and only **2** at 21d — the 21d column is barely more than an anecdote and must not be quoted on its own). Two things worth noting and neither is yet actionable: `confluence_score` is both the strongest-reading engine AND already the highest-weighted one in `REGIME_WEIGHTS` (0.30-0.378), so this is consistent with the current weights rather than an argument to change them; and `dl_score` reads at or below zero at 10d/21d, which is expected given its walk-forward was only fixed on 2026-09-10 (AF-20260910-08) and no honestly-trained DL model has shipped yet. Re-run once the panel clears 20 dates under stable post-2026-08-31 weights (~2026-09-26/29) before drawing any reweighting conclusion. This supersedes the older "t=+2.13 at 1d on 12 dates" note for `technical`, which was never refreshed.
- **`earnings_beat_yoy`/`earnings_beat_qoq`, `screener_breadth`, the 3 named results screeners** — all underpowered (3–27 periods), genuinely calendar-blocked until ~12+ months of history exists in their source tables.
- **`cs_ranker` has had TWO further retrains since this was written, both REJECTED — and the metric this row quotes cannot be read out of `model_registry.cv_roc_auc` (checked live 2026-09-10).** The active `GradientBoosting Regressor Pair` is dated 2026-09-01 with `cv_roc_auc` **1.8021**; the two challengers since read 1.9981 (2026-09-06) and 2.1444 (2026-09-10), both `is_active = 0`. Those values are all **> 1, so they are not AUCs** — for this model type the column holds some error-style metric (lower better), which makes the rejections internally consistent (1.80 < 1.99 < 2.14) but means the "0.176 vs 0.161/0.161/0.133" figures in the original note came from somewhere else (they match the rho series recorded in `ml-model-bugs.md`, not this column). **Do not compare the two sets of numbers.** Still flagged, still not confirmed as a bug, and the underlying caution stands: a self-reported metric on a thin date-split holdout is exactly what this file says not to trust. 12 registrations exist in total.
- **`win_probability` sub-population split** (grid-scored vs. pattern-fired via `signals_json IS NOT NULL`) has never been explicitly re-graded to confirm the two sub-populations behave the same way — flagged, not measured.
- **`mc_fno_eligible`/`mc_del_acceleration`** are cheaply derivable but deliberately not built — the risk was a formula silently disagreeing with the fetcher's own definition. Revisit if prioritized.
- **`engine_composite_scores` is FRESH as of 2026-09-10** — 109,174 rows across **79 distinct dates**, most recent 2026-09-10. Its producer runs weekly (inside `processMlWeeklyRetrain`) and this row has had reliability problems before (see `measurement-history.md`), so the standing advice is unchanged — check `job_heartbeat` before trusting freshness — but as of this check there is nothing wrong with it.
- **`dl_score` in `unified_recommendations_history`** IS stored (migration `1787110000000`, applied 2026-08-21) — do not re-derive that the column is missing. **Coverage corrected 2026-09-10: it is 96.1%, not 100%** (50,494 of 52,555 rows), and the earliest row is **2026-08-24**, not 2026-08-22. Blend-decomposition analysis is still unblocked for that window, but a ~4% hole means you must filter `dl_score IS NOT NULL` explicitly rather than assuming completeness — and per this file's own population-boundary rule, a NULL here is "engine never ran", not "engine scored zero".
- **`technical_signals.screener_momentum_score` reclassification effect** — **RE-GRADED 2026-09-10 and it NO LONGER CLEARS `USABLE`** — 21d now reads rank_IC **+0.172** / hit_AUC **0.532** on **42 dates**, against 0.217 / 0.552 on 33 dates measured 2026-08-29. The IC still clears the `|rank_IC| >= 0.03` half of the bar but the AUC has fallen **below the 0.55 half**, so the verdict is now `no edge` at every horizon (1d +0.037/0.500 on 62 dates, 5d +0.084/0.517 on 58 dates). **Do not cite the old "clears USABLE" framing.** This is the same monotone decay-as-the-panel-grows that `win_probability`, `breakout_probability` and `ml_breakout_probability` all showed in the same pass — on this platform a promising LOW-DATA reading has, so far, never survived reaching full power, but the 2026-08-29 screener reclassification's OWN effect is still genuinely calendar-blocked — needs ~20+ trading dates generated after 2026-08-29, of which **8 exist as of 2026-09-10** (was ~4 on 2026-09-04) — so ~12 more sessions, i.e. ~late September. Re-run `factor_edge.py --table technical_signals --scores screener_momentum_score --entry open` once that accumulates, filtering to post-2026-08-29 dates only.

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
| **`mean_reversion_14`** (sign-flipped composite of the 14 negative feature_store factors, standalone long factor) | **⚠ MEASURED THROUGH A KNOWN DEFECT (AF-20260910-18) — re-grade before quoting.** Until 2026-09-10 `feature_store` stored per-symbol `RobustScaler` output, not raw values, so every reading below graded the SELF-NORMALIZED column. Rank IC is cross-sectional and a per-symbol affine transform reorders the cross-section. Columns rebuilt raw 2026-09-10; re-run pending. 278 periods/5.52yr: net excess +0.044%/period, **t=+0.64, NOT significant**, 2/6 years positive | Confirms this file's "combining/reweighting reduces performance" prior applies to this hypothesis too |
| **`mean_reversion_14`** (as a VETO on `momentum_12_1`'s pool instead — 2026-08-30, re-run same day against the full backfilled 2021-2026 `feature_store` history) | **⚠ MEASURED THROUGH A KNOWN DEFECT (AF-20260910-18) — re-grade before quoting.** Until 2026-09-10 `feature_store` stored per-symbol `RobustScaler` output, not raw values, so every reading below graded the SELF-NORMALIZED column. Rank IC is cross-sectional and a per-symbol affine transform reorders the cross-section. Columns rebuilt raw 2026-09-10; re-run pending. Same-dates paired, full history: 21d +0.27pp/period, paired t=1.50, n=54 (well-powered, down from a truncated-window t=1.75/n=17); 5d -0.01pp/period, t=-0.24, n=230 (no effect) | **NOT significant, CLOSED** — the earlier truncated-window "promising" reading was a regime-confounded artifact, not a real effect; do not re-test again without a genuinely new angle |

## Not testable — do not spend time here without a genuinely new angle

- **Fundamentals, analyst, ownership and earnings factors**: still calendar-constrained, but **re-counted live 2026-09-10 — `fundamentals_history` now holds 56 distinct dates (2026-06-30..2026-09-09) across 2,232 symbols, not the ~30 this line used to claim.** Still only 1-2 independent quarterly observations, so the constraint is unchanged in substance. **A backfill route now exists and is worth costing before waiting another quarter:** `trendlyne_pe_history` holds **4.16M rows back to 2013-12-24**, with **2,997 distinct dates across 1,940 symbols BEFORE `fundamentals_history` even begins** (`trendlyne_pb_history` is comparable at 4.21M rows). `_merge_fundamentals` already does a correct point-in-time `merge_asof`, so the machinery is in place. **The one thing to verify first:** vendor valuation history can be retrospectively restated, which would inject look-ahead into a point-in-time join — check a known historical snapshot against an independent source before building on it. This is the single largest available unblock in this section.
- **FnO / positioning (long/short buildup, short covering)**: built (`mc_stock_futures_oi_fetcher.py`, `stock_futures_oi_history`, composite-keyed `(source, symbol, date, expiry)`, scheduled daily, live-graded LOW-DATA at **14 dates as of 2026-09-10**, was 9 on 2026-09-04) — see "Standing architecture facts" above. Not yet enough dates to verdict; ~6 more sessions to the floor.
- Of 60 symbol+date tables audited 2026-08-11, only 9 have enough history to test anything at all; the other 35 start ~2026-06-30.
- **REGIME_WEIGHTS re-check, 2026-08-25**: `blend_walkforward.py` re-run across all 46 available sessions — TILT alternative still fails its pre-declared bar (dIC −0.0003). Weights confirmed unchanged. **Live-reverified again 2026-09-10**: `screener`, `cs` AND `smart_money` are all still 0.0 in every one of the five regimes — a validation, not an improvement, do not cite it as one.
- **`technical_signals.date` is TEXT→DATE** (migration `20260825120000`, applied via a manual single-statement rerun after node-pg-migrate's sql-file runner silently executed only the file's first statement). Writers unaffected; `db/schema.postgres.sql` updated so new throwaway test schemas get DATE natively. A migration's ledger row proves execution of *a* statement, not necessarily the one you meant — verify the effect via `information_schema`, never the tool's exit code alone.
