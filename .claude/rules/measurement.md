# Measurement Discipline

Read before quoting, comparing, or acting on any accuracy, win-rate, IC, or backtest number.
Full incident narrative and investigation detail behind every claim below:
`docs/measurement-history.md` (split out 2026-08-12 for length — this file is the rules and
current verdicts you need before acting; that one is the derivation, read on demand).

> ## ⚠ `factor_backtest.py` had two benchmark bugs — both FIXED 2026-08-12, factor table re-measured
>
> Exit accounting wrote off any eligible-but-unpriced name at −100% (conflating "no bar today"
> with "delisted"), and a separate bug made `--rebalance 1` runs use a benchmark wrong by ~35pp/yr.
> Both fixed (`index_last_alive()`, keyed on `next_open`). Universe is now near-invariant to
> rebalance: **+26.13%/yr @ rebalance-1, +23.30%/yr @ 5, +20.31%/yr @ 21**. Full diagnosis, the
> reconstructed drag arithmetic, and the regression test: `docs/measurement-history.md`.
>
> **Re-measured, 26 factors, monthly rebalance, top-50, 25bps: exactly 1 of 26 is positive and
> significant (`insider_net`, t=+2.05), and it does not clear the ~t=3.0 a 26-factor Bonferroni
> needs.** `value_book_to_price` and `momentum_12_1` — the two factors previously read as
> positive — both dropped below significance (t 2.67→1.99 and t 2.08→1.10) once the exit-pricing
> bug was fixed. **Current correct statement: no factor in this harness has a credible positive
> edge.** The negative results were unaffected by either bug and remain the reliable part
> (high_vol t=−6.09, reversal_21d −3.77, screener_oversold −3.50, and the oversold/near-52w-low/
> below-lower-BB family all significantly negative).
>
> **`insider_net`'s t=+2.05 does not reproduce — re-run live 2026-08-12, same command
> (`--rebalance 21 --top-k 50 --cost-bps 25`), gives net excess +0.29%/period, t=1.73.** Not
> significant either way. This line had also drifted internally inconsistent with itself: the
> "Known state of the edge" section below independently called `insider_net` "null-to-negative"
> while this banner called it the one significant survivor — both were wrong, and neither had been
> re-run since the harness fix that this very banner announced. **So: zero of 26 factors are
> positive and significant, not one.** Filing coverage grew (23,360 filings / 717 symbols at
> re-run vs. whatever it was when t=2.05 was recorded), which is consistent with the original
> reading being a false positive that diluted toward null as more data arrived — the expected
> behaviour of noise, not of a real factor. Re-run any load-bearing number here before trusting it;
> this harness's own numbers go stale as the panel grows.

## Accuracy comes from realized returns, never a proxy

- **Accuracy and win-rate must always be computed from actual realized returns vs. the actual system-generated signal — never from a proxy metric (a job's "success" status, a promotion gate's CV/AUC number, a model's self-reported test score).** This project's own incident history is full of proxies that looked fine while the real outcome was wrong — a leak-inflated CV score blocking honest retrains forever, a "success" heartbeat on a step that silently wrote nothing, `unified_recommendations` classifying `Sell` on a stock that then rallied 15%+. The only check that catches this class of bug is joining the signal table (`unified_recommendations`/`unified_signals`/`intraday_recommendations`) against what the underlying instrument actually did afterward (`stock_ohlcv`/`intraday_ohlcv`, or the already-graded `signal_outcomes`/`intraday_recommendation_outcomes` tables) and computing win rate as `WIN / (WIN + LOSS)` — decisive outcomes only, NEUTRAL/PENDING excluded — plus average realized return, not a single blended percentage. **Before trusting or comparing any win-rate number, check its `label_definition`** — this table has at least two structurally different label conventions in production right now (`signal_outcomes.label_definition`: `terminal_pct2`, a strict fixed ±2% terminal-return barrier, vs `path_barrier`, a path-based max-favorable-excursion rule) and they are NOT comparable: live-measured 2026-08-06, `technical`-sourced h5/h15 outcomes (path_barrier) showed an 88–91% win rate while `confluence`-sourced h7/h14 outcomes (terminal_pct2, the exact same calendar window) showed 41–44% — the gap is almost entirely the label definition, not real skill. See [[topgainers_reverse_engineering_practice]] for the full methodology this rule is extracted from.

## Reverse-engineer against what actually happened

- **Always take a reverse-engineering approach to validate the correctness of logic, models, and code — not a code-only review.** Trace the claim against what actually happened: pull real top gainers/losers from `stock_ohlcv` and check whether the system's own pre-move signal called it correctly (see [[topgainers_reverse_engineering_practice]]); for a model, grade its stored predictions against realized outcomes rather than trusting its own reported CV/test metric; for a fix, re-run the affected code path against live production data and query the result back, rather than stopping at `tsc --noEmit`/a green test suite. This project has repeatedly found real, currently-active bugs this way that a code-only review missed entirely — e.g. the 2026-08-06 session that found `unified_ranker`'s RL gate had silently excluded 825 symbols platform-wide (43% of them on fewer than 5 historical samples) purely by tracing one specific symbol's absence through the live pipeline step by step, something no amount of reading `unified_ranker.py` in isolation would have surfaced. A plausible-sounding lead from code-reading alone (e.g. "market_cap is NULL for this symbol, that's probably it") is a hypothesis, not a finding, until it's actually traced end to end against live data — the same session's own first-pass KECL lead turned out to be entirely wrong once traced properly.

## The panel spec (use this exact recipe, every time)

Any cross-sectional forward-return measurement on this data:

- **Per-date, then average. Never pooled.** Pooling has flipped or inflated a conclusion three separate times here (`cs_ranker._mean_daily_ic`, the screener-direction measurement, the RL-gate counterfactual — a pooled +0.798% became a per-date +0.098%, t=1.22). If a dramatic pooled number disagrees with per-date numbers, the pooled number is wrong.
- **Winsorise.** Raw means on `stock_ohlcv` are void: a +127,900% RELIANCE bar once produced an 850%-annualised phantom edge. Raw mean 5d return 6.49% vs 0.00% median vs 0.65% winsorised.
- **Filter `is_suspect = 1`.** ~425 quarantined bars; `ohlcv_quality.py` owns the flag.
- **Liquidity floor ≥ ₹1cr ADT.** Without it you are measuring microcaps you cannot trade.
- **Next-day OPEN entry.** Signals computed off a close cannot be bought at that close.
- **Check `label_definition` before comparing any two win rates.** `terminal_pct2` (fixed ±2% terminal) and `path_barrier` (path-based MFE) are not comparable — same calendar window, 41–44% vs 88–91%, and the gap is almost entirely the label.
- **Check `signal_source` before joining `signal_outcomes`.** Three writers share that table.
- **Decompose a "% of rows affected" figure by liquidity before believing it.** A defect reading 42% of rows read ~100% of the *tradeable* slice.
- **Judge any datasource by dates PER SYMBOL and by its DENSE span, never by raw `min(date)`/`count(DISTINCT date)` over the whole table.** Both have misled this repo — a table can report years of span while being 4-5 rows per symbol, or "5 years" while dense coverage only starts 2 years in. Run both: `SELECT min(n), median(n), max(n) FROM (SELECT symbol, count(DISTINCT date) n FROM t GROUP BY 1)` and `SELECT extract(year FROM date), count(DISTINCT date) FROM t GROUP BY 1 ORDER BY 1`. Full incident: `docs/measurement-history.md`.
- **Grade every candidate factor against BOTH tails**, not just AUC-vs-winners — an AUC computed only against winners cannot tell "predicts winners" from "predicts volatility" (this codebase has been fooled by that exact statistic twice; full writeup in history). Report three numbers: AUC vs the winning tail, AUC vs the losing tail, AUC of one tail against the other.

## Known state of the edge (as measured, not assumed)

`unified_score` 5d rank IC ≈ 0.0001 (t=0.02). Short-horizon momentum is negative at three horizons. Bullish screener consensus is significantly negative (t=−2.36), and screener sentiment labels are themselves inverted (bullish minus bearish = −0.11pp, t=−4.61) because they're keyword-classified off the screener name, never validated against an outcome. `insider_net` re-runs mildly positive but not significant (t=1.73, see banner); `delivery_spike`, `ticket_size` are null-to-negative. No individual screener (0 of 552 tested) survives FDR or Bonferroni. The common bullish setups (Gap Up ≥2%, breakout>20d-high, volume shocker) are inverted at 1-day. **The "Gap Down is the one significantly positive setup" line here was retracted 2026-08-13** — it was a same-day descriptive screener-membership reading, not a tradeable one (see the "Screeners are DESCRIPTIVE, not predictive" finding in `measurement-history.md`); reconstructed from price and run through the real turnover/cost-aware harness (`factor_backtest.py --factor gap_down`), it is significantly NEGATIVE net of costs at every rebalance tested (21d t=−3.54, 5d t=−9.0), same magnitude and sign as `gap_up` (21d t=−3.55) — both directions are a turnover trap (~90-93% one-way turnover every period; almost no persistence in which names gapped) rather than an edge in either direction. See the "already tested" table. Sector-neutralising a factor destroys its edge here (opposite of the published US result) — see the "already tested" table. FnO/positioning factors (long/short buildup) cannot be reconstructed at all — no fetcher on this platform captures per-stock futures OI.

**Consequence: reweighting the existing engines is not a fix.** There is no incumbent factor to beat — see the banner above. Combining reduced performance in every case tested (12-1 alone +0.86% vs +2 exclusions −1.25%; long-only +0.86% vs long/short +0.49%; the 8-engine blend at IC 0.0001).

### Grading the live signals directly (2026-08-12) — no significant directional edge either way

Everything above grades *factors*. This grades what the platform actually emitted: entry at the
`signal_date` open, restricted to signals provably written before that open, `is_suspect`
filtered, ≥₹1cr ADT, **per-date then averaged**. Signed return = realized return × direction, so
negative means the call was backwards.

**Anchor the provenance filter on `created_at`, NOT `signal_generated_at`.** Until the fix in
migration `1786920000000`, `signal_generated_at` was refreshed on every re-run and is a
last-seen time, not a generation time (see `recurring-bugs.md`).

| Horizon | Signals | Dates | Per-date signed return | t | Win rate |
|---|---|---|---|---|---|
| 1d | 1,569 | 17 | −0.64% | −1.28 | 42.8% |
| 5d | 961 | 14 | −0.63% | −1.25 | 46.7% |
| 21d | 882 | 9 | −3.05% | −2.40 | 40.0% |

**Only the 21d row is significant, and it does not survive a 3-horizon correction.** By source at
21d the sign is not shared: `AI` −4.67% (34% win) against `TECHNICAL` **+0.94%** (50% win) — the
negative aggregate is the AI path, not the technical scanner.

⚠ **A previous version of this section reported h=1 at −0.84%, t=−3.44, and called the live
signals "significantly wrong-way". That was wrong and is retracted.** It anchored on
`signal_generated_at`, which admitted only the 2.4% of rows that had never been re-run — a
biased slice, not a random one. Re-anchored on `created_at` the sample grows 7.5× (1,320 → 9,931
rows; 356 → 1,569 tradeable at h=1) and the t-stat collapses from −3.44 to −1.28. This is the
"dramatic number from a small filtered subsample" failure the panel spec exists to prevent, and
it was produced by this repo's own review process on the first run — check what your provenance
filter is actually selecting before believing the result it gives you.

Recall, same method: **1 of 110 top-10 daily gainers flagged bullish pre-market, against ~5.2
expected by chance** (Σ top_n × signals/universe). At or below chance, and far too thin to
separate skill from noise.

Re-measured weekly by the `signal-accuracy-review-weekly` scheduled task.

### The canonical ranker is not gradeable yet — and the clock started 2026-08-12

`unified_recommendations` holds 37 distinct `computed_at` dates and **exactly one** is provably
pre-market (2026-08-12, generated 03:00 UTC). `generated_at` was only populated from 2026-08-10,
and the 08-10 (18:23 UTC) and 08-11 (20:02 UTC) batches were both generated *after* that day's
close. The cause was not missing data: the table is keyed `(symbol, computed_at)` on a bare DATE,
so **every re-run overwrote the previous run's ranking**.

Fixed 2026-08-12 by `unified_recommendations_history` (migration `1786940000000`), an append-only
snapshot keyed `(symbol, generated_at)` written by `unified_ranker.py` alongside its upsert. Every
run is now preserved; the 3 runs that had a `generated_at` were seeded into it (6,591 rows).

**Consequence for anyone reading this: do not quote a ranker accuracy number yet.** Grade against
`unified_recommendations_history` filtered to `generated_at < computed_at 03:45 UTC`, and expect
~30 pre-market dates to be needed before a t-stat means anything. That is a calendar constraint —
roughly six trading weeks from 2026-08-12 — not an engineering one. Anything computed from the
live `unified_recommendations` table alone is grading a post-close re-run against its own day.

**First real grading pass, 2026-08-13 (n=2 dates: 2026-08-12, 2026-08-13 — do not treat any of this
as significant, it's a preview of the method, not a verdict).** Every non-Hold pre-market call
joined to same-session realized return, liquidity ≥₹1cr ADT, `is_suspect` excluded, per-date:

| Date (market direction) | Buy n / win% / avg | Sell n / win% / avg | Strong Sell n / win% / avg |
|---|---|---|---|
| 2026-08-12 (down day, Hold avg -0.24%) | 10 / 50% / +0.06% | 147 / 66.7% / **-0.45%** | 33 / 57.6% / **+0.26%** (wrong-direction avg) |
| 2026-08-13 (up day, Hold avg +0.30%) | 11 / 54.5% / +0.22% | 142 / 45.8% / **+0.39%** (wrong-direction avg) | 33 / 42.4% / **+0.66%** (wrong-direction avg) |

Two things stand out even at n=2: (1) the Sell bucket's win rate flips with the day's overall
market direction (66.7% on a down day, 45.8% on an up day) — consistent with the standing
zero-IC finding, i.e. it looks like beta exposure to that day's broad tape, not stock-specific
skill; (2) **Strong Sell (S_ELITE) underperforms plain Sell (A_HIGH) on BOTH dates** — the
opposite of what conviction should mean. Traced, not guessed: this is NOT a recurrence of the
2026-08-10 conviction-ladder-direction bug (`_directional_strength`/`_conviction` in
`unified_ranker.py` are still correct — verified by reading the code). It traces instead to
`recurring-bugs.md`'s newly-added neutral-tag-as-bearish bug in `scoring_engine.py`: the most
extreme (near-0) `unified_score`s concentrate in illiquid/thin-coverage names whose `stock_scores`
component is artificially floored by miscounted neutral screener tags, not by genuine bearish
evidence — extremity of a corrupted score doesn't predict direction. Top-15
gainers/losers cross-check (see `recurring-bugs.md` for the traced misses): of 4 non-Hold calls
on real double-digit movers, 2 correct (KERNEX Sell -9.08%, RMC Sell -11.52%) and 2 wrong-direction
at high conviction (PNGSREVA Strong Sell/S_ELITE +10.77%, MOREPENLAB Sell/A_HIGH +10.11% — the
latter directly traced to the neutral-tag bug, `quant_scores` had it at Strong Buy/85.4 the same
day). 3 real movers had no `unified_recommendations` row at all (TIIL, SENCO, SGIL) — not traced
further this pass. n=2 dates is far too thin to draw a verdict; re-check once ~30 pre-market dates
accumulate per the calendar constraint above.

**A second, unrelated `scoring_engine.py` touch same day (2026-08-13) is explicitly NOT a scoring
change and doesn't need a `factor_backtest.py` run.** `_log_recommendations`'s batched price/ATR
lookup wrapped `quant_scores.rank_composite` in a bogus `ORDER BY qs.date DESC LIMIT 1`
(`quant_scores` has no `date` column — see `recurring-bugs.md`'s "column referenced in SQL that
doesn't exist" entry, third occurrence). Because it's a single 5-column `SELECT`, the resulting
`UndefinedColumn` error aborted the whole statement, silently nulling `entry_price`/`target_1-3`/
`stop_loss`/`news_sentiment_score`/`quant_score` for every `recommendation_log` row from
`scoring_engine` — a **data-completeness bug in a downstream logging table, not a change to any
score, weight, or classification formula**. `factor_backtest.py` tests price-panel factor edge
(momentum, value, etc.) and has no code path that reads `recommendation_log`'s enrichment columns
at all, so running it here would measure something unconnected to the diff — the kind of
evidence-shaped-but-meaningless artifact `recurring-bugs.md`'s "fabricated backtest" entry warns
about, not genuine verification. The real, applicable measurement is a direct before/after
population count, done live 2026-08-13: `recommendation_log` rows for the day went from 0/1,584
to **1,492/1,584 (94%) with `entry_price`/`quant_score` populated** after the fix and a live
`process_scoring()` re-run. No factor's measured edge in this file changed as a result of this fix.

**A `unified_ranker.py` touch (2026-08-14, cross-writer-collision-audit) is the same shape:
explicitly NOT a scoring change, no `factor_backtest.py` run warranted.** `seed_screener_catalog()`
wrote `row['source']` into `screener_catalog` verbatim from `screener_scoring_v2.csv`, uncontrolled
case — other writers of the same table (`screener_catalog_enricher.py`, `trendlyne_screener_
discovery.py`) already normalize to lowercase, and `screener_catalog`'s PK is `(screener_id,
source)`, so a differently-cased reseed could silently create a second row for a screener that
already existed, rather than the `ON CONFLICT` upsert hitting the same row. Changed to
`.strip().lower()` to match the existing convention. **Traced, not assumed, that this cannot
currently affect any live score:** `seed_screener_catalog()` only runs when `SELECT COUNT(*) FROM
screener_catalog` is 0 (`unified_ranker.py:1933-1934`); live-checked 2026-08-14, the table holds
2,539 rows, so this function is dormant in production today and the fix has zero live effect —
it only prevents the casing-duplicate bug on a future reseed-from-empty. Separately, every
downstream reader of `screener_catalog.source` in this same file already matches case-insensitively
(`LOWER(sc.source) = 'trendlyne'` etc., lines 1257-1260), so even when this function last ran, the
write-time casing didn't change which rows a query matched — only whether a reseed correctly
upserted onto an existing row versus silently duplicating it. `factor_backtest.py` has no code
path that reads `screener_catalog` at all (it operates on the price panel), so running it would
measure something unconnected to this diff, same reasoning as the `_log_recommendations` entry
above.

**A fourth `unified_ranker.py` touch (2026-08-16, `_get_unified_signals_latest_map`) is NOT a
scoring change either — it widened a direction filter, and the widening was measured before it
was made, not after.** The method's fallback query read `WHERE signal_type = 'BUY'`. Its own
comment explains why a filter is needed: `_get_entry_targets` only ever attaches this result to
a long-entry-style setup, so a short row's inverted stop/target would manufacture a nonsense
plan. That property is about **direction**, not about the literal string `'BUY'` — and
`unified_signals` has no single `signal_type` vocabulary (`technical_analysis_engine.py`, the
largest writer, spells a long `'Bullish'`; see `recurring-bugs.md`'s enum-vocabulary entries).
The filter was therefore excluding the biggest source of valid long rows.

**Widened to `IN ('BUY', 'Bullish')` only after checking the geometry empirically**, by counting
rows on where the target sits relative to the stop:

| signal_type | rows | long-style | short-style |
|---|---|---|---|
| `BUY` | 33,772 | 32,512 | **0** |
| `Bullish` | 13,192 | **13,192** | **0** |
| `Bearish` | 11,211 | 1,705 | 9,496 |
| `SELL` | 451 | 0 | 451 |

`Bullish` is exactly as safe as `BUY` — 100% long-style, no exceptions. **`Bearish` is
deliberately NOT included**: 15% of its rows carry long-style geometry, so it fails the very
test `Bullish` passes, and adding it would be the exact bug the original filter existed to
prevent. Measured coverage effect: symbols with a usable row in this fallback tier go
**2,335 → 2,393**.

**`factor_backtest.py` was deliberately NOT run, for the same reason as the three entries
below.** No score, weight, threshold or classification is touched — this changes which
`entry_price`/`target`/`stop_loss` values enrich a recommendation, and `factor_backtest.py`
operates on the price panel with no code path reading `unified_signals`' levels at all. Running
it would measure something unconnected to the diff, the "evidence-shaped but meaningless
artifact" `recurring-bugs.md` warns about. The applicable measurement is the geometry table
above, taken from live production. **Unrelated finding worth its own look, recorded here so it
is not lost: those 1,705 long-style `Bearish` rows are an internal inconsistency in
`technical_analysis_engine.py`'s own output** (its `Bearish` branch calls
`compute_atr_barriers(..., 'short')`, which cannot produce a target above the stop) — not
traced further this pass.

**A third `unified_ranker.py` touch (2026-08-15, `_next_generated_at`) is again NOT a scoring
change — but unlike the two above it fixed a real, silent evidence-loss bug, so read this one.**
`run()` stamped `generated_at = datetime.now(timezone.utc)`. That reads the SYSTEM CLOCK TICK,
not the microseconds its ISO output implies: measured on this machine,
`time.get_clock_info('time').resolution` is **0.015625 s** and 2,000 back-to-back
`datetime.now(timezone.utc)` calls returned **exactly one distinct value**. Since
`unified_recommendations_history` is `PRIMARY KEY (symbol, generated_at)` with
`ON CONFLICT DO NOTHING`, two runs completing inside one 15.6 ms tick share a timestamp and the
**second run's entire snapshot is silently discarded** — no error, no warning, no row-count
change. That is the exact evidence loss this table was created to prevent (see "The canonical
ranker is not gradeable yet" above: re-runs overwriting each other left exactly ONE provably
pre-market date). Fixed by making the stamp strictly increasing within a process (bump 1µs on
collision), which keeps it a true wall-clock value — it must stay one, because the pre-market
provenance filter depends on it. **No score, weight, threshold or classification is touched, so
`factor_backtest.py` measures nothing connected to this diff**; the applicable verification is
the direct one, done: the previously-"flaky"
`test_history_snapshot_is_append_only_across_reruns` now passes under the exact condition that
deterministically failed it (full suite + one added test file), and two new negative-controlled
tests in `test_sql_translate.py` fail against the bare `datetime.now()` form. **Production
exposure is smaller than dev's but not zero** — Linux has ~1 ns clock resolution, so the live
pm2 ranker is unlikely to have lost snapshots this way; the defect was that a snapshot table's
uniqueness guarantee rested on the host's clock granularity at all. Worth re-reading if a future
grading pass finds fewer `generated_at` values than there were runs.

## Already tested — do not re-run without a reason

Each of these was measured on the 5-year price panel with the spec above. Re-testing them costs days and returns the same answer. If you think one deserves another look, state what changed (more history, a different horizon, a different construction) before spending the time. Full derivation for any row: `docs/measurement-history.md`.

| Factor | Result | Verdict |
|---|---|---|
| `momentum_12_1` | +0.53%/mo, t=1.10 (post-fix) | not significant |
| `value_book_to_price` | +0.78%/mo, t=1.99 (post-fix) | not significant; vendor history may be retrospectively restated |
| `insider_net` | net excess +0.29%/period, t=1.73 (re-run 2026-08-12, superseding the earlier +0.48%/t=2.05 which did not reproduce) | not significant |
| `momentum_21d` / `63d` / `reversal_21d` | negative, t up to −3.96 | dead |
| `high_vol` / `low_vol` | both negative (−1.21, −1.66) | **both tails lose**; the middle outperforms |
| `delivery_spike` / `delivery_trend` | t=−1.08 / −1.43 | dead |
| **`delivery_pct` (raw level, NOT the derived spike/trend above)** | quintile spread +0.19pp/day, t=+7.82 — but **long-only top-50 net excess −1.04%/period at 21d/25bps and −0.15%/period at 5d/15bps, t=−1.48 both** | **dead as a long-only factor** despite a real directional signal in the spread |
| `ticket_size` (institutional proxy) | −0.67%, t=−2.36 | significantly **inverted** |
| `smart_money` (`unified_ranker.py`'s live insider+block-deal+institutional-deal composite input, flat 0.05 weight, stored as `unified_recommendations.smart_money_score`) | **CORRECTED 2026-08-18 — the "never backtested" line below was stale.** `queues.ts`'s `factor_edge.py --table unified_recommendations --scores ...,smart_money_score,...` job (the "same discipline applied to our OWN 8 unified_ranker.py engines" step) already runs on schedule and DOES cover it — checked live: latest run `2026-08-17T19:05:22`, rank_ic=+0.0671, hit_auc=0.5087, n=275, **but only 1 distinct date**, verdict `LOW-DATA`. | **not unmeasured — genuinely too thin to verdict yet**, same calendar-constraint shape as `screener_breadth`/`earnings_beat_*` elsewhere in this file, not an engineering gap. `load_engine_edge_verdicts()` already reads this table and would apply an `ENGINE_EDGE_SHRINK` (0.5x) to `smart_money`'s weight the moment it clears `LOW-DATA` with a negative verdict — the infrastructure to act on a real result already exists and is live (gated behind `engine_edge_adjustment_enabled`, currently off by default). Re-check `factor_edge_history WHERE score_col='smart_money_score'` for a `dates` count once ~15-20+ has accumulated; until then the closest measured analogue, `ticket_size`, is significantly inverted (row above) and is the better prior. Original incident context, still accurate: a 2026-08-12 incoming commit fabricated a "Sharpe 1.38 / 64.5% win rate" backtest for a "Smart Money Veto" concept that does not exist in the live ranker and was deleted, not evidence of anything. **Separately, a real (non-fabricated) "Smart Money Override" DID land in the live ranker the same day (`ae3e369`)** — bypassed the significantly-negative `high_vol` veto (t=−6.09, see banner) for any symbol scoring `sm_score>=80` on this same input, zero test coverage, zero backtest. Live exposure quantified 2026-08-12: 21 real symbols cleared the threshold via the institutional-deal-signals channel alone in the trailing 14 days. Reverted same day (`unified_ranker.py:2077`) — re-add only once `smart_money_score`'s own `factor_edge_history` verdict clears `LOW-DATA` and is positive. |
| screener bullish consensus | IC −0.027, t=−2.36 | significantly negative; cleaning the labels made it *more* negative |
| `screener_breadth` (multi-screener persistence — count of independent screeners currently flagging a name, sentiment-agnostic) | 5d/15bps top-50: −0.11%/period, t=−0.45; top-25/0bps: −0.23%, t=−0.73. Both **negative point estimates**, both far from significant. 21d gives 1 period (uninterpretable, disregarded). | **not significant, and low-power** (only 9 periods — `screener_appearances` spans just ~2.5 months). No evidence of edge; also no evidence it's dead the way the negative-and-significant rows above are. Re-test only once the table has enough history for a real 21d-rebalance read (needs ~12+ months). See `_add_screener_breadth` in `factor_backtest.py` for the construction. |
| **every individual screener** (1,563, one at a time) | **0 survive FDR or Bonferroni** | population direction is negative, sentiment labels inverted |
| 3 named "upcoming/recent results" screeners (`upcoming-results-with-rising-delivery-volumes`, `results-in-the-last-two-days-with-yoy-and-qoq-net-profit-growth`, `potential-outperformers:-...-in-the-previous-quarter`) — tested 2026-08-13 after a user question about whether KERNEX's pre-results move was flagged by any of these | 5d excess-vs-liquid-universe, per-date then averaged, winsorized, `is_suspect` excluded, ≥₹1cr ADT, computed fresh from `screener_appearances` × `stock_ohlcv` (not the platform's own `screener_reliability`/`screener_performance_v2` tables, which are a proxy and were not trusted blindly — see below): rising-delivery +0.83%/period t=1.76 (15/23 dates won); net-profit-growth +0.01%/period t=0.02 (11/21); potential-outperformers +0.34%/period t=0.59 (15/27). | **not significant, any of the three** — none clears a single-test bar (max t=1.76), let alone a 3-way correction. All three point estimates are positive but weak; no evidence of edge, and (same caveat as `screener_breadth`) too few dates (21-27, `screener_appearances`' full ~2.5-month history) to rule dead either. 20d horizon has almost no resolved observations yet (recent appearances haven't aged 20 sessions) — not measurable, same constraint as `screener_breadth`. **The platform's own precomputed `screener_reliability`/`screener_performance_v2` reported `win_rate_5d=1.0`/`wr_10d=1.0` for rising-delivery** — did not survive contact with a from-scratch measurement (65% of dates positive, not 100%); almost certainly a thin-denominator artifact on the internal table, not a genuine signal — another instance of not trusting this platform's own self-reported reliability score over a direct measurement. |
| **`feature_store`** (23 candidate technical/fundamental/news columns not already in `FACTORS`, wired into `factor_backtest.py` via `_add_feature_store`/`FEATURE_STORE_FACTORS`, 5d/15bps top-50, live re-run 2026-08-12 against Postgres) | **14 of 23 clear a 23-factor Bonferroni (\|t\|≳3.15) — all 14 negative.** Worst: `stoch_d` t=−9.28, `williams_r` t=−9.02, `stoch_k` t=−9.00, `cci` t=−7.57, `di_plus` t=−7.34, `dist_sma20_pct` t=−6.40, `vwap_dist_pct` t=−5.78, `volume_ratio_20d` t=−5.75, `obv_slope` t=−4.98, `atr_pct` t=−4.81, `volume_ratio_5d` t=−4.71, `macd_hist` t=−3.92, `mtf_alignment_score` t=−3.38, `bb_width` t=−3.15. Not significant either way: `di_minus` (+1.34 — does **not** reproduce the 2026-08-11 ad hoc IC test's t=+7.70), `adx`, `dist_sma200_pct`, `debt_to_equity`, `roe`, `op_margins`, `piotroski_f`, `news_sentiment_score`, `news_impact_count`. **`rev_growth`/`eps_growth` are 100% NULL** (never written by `feature_engineering.py`) — dead schema, same shape as the known `pcr_oi`/`pcr_vol` NULL pair. | **no new factor; every clean-trend/overbought/high-volume reading is inverted — reconfirms the platform's dominant 5d mean-reversion finding, this time via the full turnover/cost-aware portfolio harness rather than a raw IC.** `feature_store` no longer belongs on any "untested" list. |
| news sentiment | same-day +0.13 IC, next-day −0.03 | real but not tradeable — the move is over by the first entry you can take |
| `near_52w_high`, `low_beta`, `low_idio_vol` | insignificant | US-published factors that did not transfer |
| `low_max_ret` (lottery demand) | t=−3.12 | significantly **inverted** vs the published result |
| intraday (23 days, 256 configs) | best net at 15bps = −0.004% | edge exists in sign, smaller than costs |
| **`mojo_indigraph`** (MarketsMojo's own composite bullish/bearish call) | −0.08 to −0.14%/period, t=−0.15 to −1.26 | **no edge** — a vendor's standing directional call is not better than this platform's own |
| **sector-neutral (industry-relative) value & momentum** | **every one worse than its raw parent; B/P +0.82→+0.46%/mo, t 2.08→1.12** | **rejected** — confound (smaller universe) ruled out with a registered control |
| `gap_down` (reconstructed from price, top-50/25bps/21d rebal.) | net excess −1.33%/period, t=−3.54, 1/6 years positive; at 5d/15bps: −0.73%/period, t=−9.0, 0/6 years | **significantly negative net of costs** — ~90-93% one-way turnover every rebalance (gap-movers barely persist) drives 5.6-13.7%/yr cost drag that eats the gross edge. Supersedes the "Gap Down is the one positive setup" screener-membership reading (same-day descriptive, not tradeable — see `measurement-history.md`) |
| `gap_up` (same construction, control) | net excess −1.45%/period, t=−3.55, 0/6 years positive | **significantly negative net of costs**, same magnitude/sign as `gap_down` — both directions are a turnover trap, not an edge either way |
| **`earnings_beat_yoy`/`earnings_beat_qoq`** (PEAD-style post-earnings drift, `earnings_category_yoy`/`_qoq` from `mc_earnings_fetcher.py`'s `_backfill_rapid_features`, BP=+2/PT=+1/LR=0/WP=-1/NT=-2, wired into `factor_backtest.py` 2026-08-13) | 21d rebalance: **0 completed periods** — no result, insufficient runway. 5d/top-50/15bps (the shortest feasible horizon): 3 periods (0.06 years), net excess −0.78%/period, t=−1.79. | **NOT significant, and severely underpowered** — 3 periods is worse than `screener_breadth`'s already-flagged-as-low-power 9. Calendar-constrained: `earnings_category_yoy` has only 19 trading days of real depth (2026-07-20→2026-08-13) — the column is a recent addition, not deep history. Re-test only once it has ~12+ months, same bar as `screener_breadth`. **⚠ CORRECTED 2026-08-20 — the line below calling `pead_model.py` dead was wrong and stale, and its own inputs have since (or already did) populate for real.** Checked live: `eps_growth_yoy`/`eps_growth_qoq` are populated on 2,483/2,522 rows in the last 14 days alone (not 0), and `pead_score` itself has real depth — 34,756 rows / 1,673 symbols / **37 dates** (2026-06-30→08-19), ~1,655-1,661 symbols on most weekdays. Graded properly via `factor_edge.py` rather than left unmeasured: 1d IC +0.029/AUC 0.505, 5d IC +0.026/AUC 0.517, 10d IC +0.027/AUC 0.521, 21d IC +0.027/AUC 0.520 (LOW-DATA, 16 dates) — **no edge at any horizon**, but a real, well-powered, honestly-measured null, not a dead/never-runs claim. Separately confirmed `pead_score` has **zero downstream readers** anywhere in the codebase (grep, not assumed) — real, correctly-functioning, measured-null output that nothing consumes is still pure waste, just not for the reason originally claimed. Retired the nightly schedule entry (`queues.ts`, was `pead_model.py` in `ml-daily-ops`) on that combined basis — no-edge AND unconsumed — 2026-08-20. (Original wrong claim, kept for the record: "`pead_model.py`'s own `compute_pead_score()` is unusable regardless of history depth — its two required inputs are ~100% NULL... populated on 0 symbols except the 2 most recent dates." Do not repeat this without re-checking live — same lesson as this file's own MASTER RULE.) `earnings_category_yoy`/`_qoq` remain the earnings-surprise columns actually wired into `factor_backtest.py`'s cost-aware harness above; `pead_score` was graded via the faster `factor_edge.py` screen only, matching the bar every other previously-ungraded engine got this session. |
| **`win_probability`** (ML ensemble's own win-odds score, `technical_signals.win_probability`, wired into `factor_backtest.py` 2026-08-20 as `_add_win_probability`) | 21d rebalance: **fails outright**, only 59 eligible sessions (need ≥63) — same calendar constraint as `earnings_beat_yoy`. 5d/top-50/15bps (shortest feasible): 7 periods (0.14 years), net excess +1.52%/period, t=+1.54, 83.4% one-way turnover, 12.61%/yr cost drag. | **NOT significant** — full detail and the preceding `factor_edge.py` IC/AUC read (real IC, hit_AUC never clears 0.55) in this file's dedicated `win_probability` section above. Two independent disqualifiers point the same way: weak classification power AND a real turnover-cost drag, on a factor with only 7 periods of runway. Re-test once ~12+ months of history has accumulated, same bar as `earnings_beat_yoy`/`screener_breadth`. |
| **`breakout_classifier.py` / `movement_predictor.py` / `cs_ranker.py` / `confluence_ml_engine.py`** (the 4 previously-ungraded `unified_ranker.py` engines) | **CORRECTED same day** — first pass graded 3 of 4 against the wrong target (generic 1/5/21d terminal return); re-graded against each model's own native label 2026-08-20T12:15: `breakout_probability` (native fwd-10d MFE≥6%) IC +0.153/AUC 0.583 at 19 dates (LOW-DATA, 1 short); `ml_breakout_probability` (native `signal_outcomes` WIN/LOSS h=7) IC +0.082/AUC 0.553 at 44 dates — **clears USABLE**; `movement_probability` (native same-day top-decile day-range) IC +0.410/AUC 0.894 traced to a real train/serve-skew bug in `score()` (fixed, all pre-fix values tainted, re-measure once ~20 fresh dates accumulate); `cs_score` (native 5d cross-sectional, correctly tested on the first pass) stands at no edge. | `ml_breakout_probability` is the strongest previously-ungraded result in this file and is next in line for the same cost-aware `factor_backtest.py` pass `win_probability` got. `breakout_probability` re-check in a few trading days once past 20 dates — do not downweight it in `unified_ranker.py`'s blend on the superseded first-pass verdict. Full detail, the leak-bug trace, and consumption footprint in this file's dedicated correction section above. |
| **`screener_combo_finder.py --tier1`'s "capitulation" triple (`gap_down` AND `open_eq_low` AND `top_loser`, next-session open→close, single day, not a rebalanced hold)** | Reviewed 2026-08-13 (`/measurement-integrity-review`): reproduced live, 425 days / 651 signal-rows, spread +0.53%/day net of 15bps, t=+3.61, p=0.0003, clears the 41-combination Bonferroni bar. **Robust**: winsorizing at 1/2/5% *strengthens* it (t 3.69–3.94); dropping the single most extreme day still gives t=3.49; dropping the top 3 most extreme days still gives t=3.25, p=0.0013. **6/6 years positive** (2021–2026), 3 of 6 individually significant. | **Not a contradiction of the `gap_down`/`gap_up` rows above** — different construct entirely: those rank/hold the top-K gapped names for a 21d rebalance and eat turnover-drag costs; this is a same-next-session open→close return on a much narrower, rarer AND'd condition (real capitulation — gapped down, opened at the low, AND already among the day's biggest losers — not just "gapped down"). Reads as a genuine short-horizon reversal/bounce off a panic day, not a continuation trade. **Two real gaps found, neither changes the verdict**: (1) the script has no winsorization step despite the panel spec requiring one — checked live, doesn't matter here, but should still be added for consistency; (2) `run_tier1`'s verdict logic (`is_edge = spread_pct > 0`) only ever surfaces the best *positive*-direction combo — the single most significant combo in the full 41-row table is actually negative-direction (`gap_down,open_eq_high`, t=−4.12, spread=−0.53%, stronger than the "winning" positive one), which the console output/verdict never highlights. Low signal density (~1.5 signals/day when it fires, ~651 stock-days across 5.5y) means this is thin — narrow enough to watch, not yet enough to call it capacity-proven at scale. `live_capitulation_screener.py`'s docstring says "See measurement.md" — this row is that entry. **Re-confirmed 2026-08-20** (`screener_combo_finder.py --tier1` re-run live, production-grade-hardening §4): 430 days / 658 signal-rows (5 more days accumulated since the 2026-08-13 read), spread +0.5064%/day net of 0.15% round-trip cost, t=+3.48, p=0.0005 — same combo still wins, magnitude and significance essentially unchanged (t 3.61→3.48), and the negative-direction `gap_down,open_eq_high` combo the earlier review flagged as unhighlighted-but-stronger is *still* the single most significant row in the table (t=−4.05 this run, vs −4.12 previously). Cost accounting for this construct was already adequate at first measurement — it's a single next-session open→close round-trip, not a multi-period rebalance, so `gap_down`/`gap_up`'s turnover-drag concern (which is about *holding* a rebalanced position) doesn't apply the same way here; re-running under the exact same harness with a few more weeks of data was the right bar to clear, and it cleared it. **Done 2026-08-20** — both items closed, reusing the real signal-construction functions (not reimplemented): **per-year breakdown corrects the earlier "6/6 years positive" claim to 5/6.** 2021 t=+2.09, 2022 t=+0.67, 2023 t=+0.91, 2024 t=+1.99, 2025 t=+2.35 (all positive), **2026 YTD (50 days) is NEGATIVE, mean spread −0.13%/day, t=−0.49** — not significant either way (thin partial year, not a reversal, but the "6/6" line was wrong and is corrected here). **Capacity is genuinely small.** Per-signal ADTV: median ₹16.6cr, p10 ₹6.0cr (barely above the ₹5cr floor), p90 ₹108.4cr — these are real but modest-liquidity names, not blue chips. At a conservative 2% of ADTV per name (standard single-session-impact convention), median deployable capital is only **₹0.46cr/signal-day** (p90 ₹3.54cr); even a generous 10% of ADTV cap only reaches median ₹2.31cr/day (p90 ₹17.69cr). Signals cluster: median 1/day, mean 1.53/day, but a max of 28 on one day (301 of 430 days have exactly 1 signal). **Verdict: this is a real edge at a small-to-mid personal/prop-trading scale, not a strategy that scales to meaningful AUM** — capacity is the binding constraint here, not signal quality. Any live sizing should cap per-name exposure at a single-digit % of that day's ADTV and expect most days to offer exactly one qualifying name. |

| **`mean_reversion_14`** (sign-flipped, equal-weighted z-score composite of the 14 Bonferroni-clearing `feature_store` columns above — go long the LOWEST/most-oversold readings instead of the highest, tested 2026-08-20 as the natural long-only-compatible construction; no short-selling infrastructure required) | `factor_backtest.py --factor mean_reversion_14 --rebalance 5 --top-k 50 --cost-bps 15`, live production, 278 periods / 5.52 years: net excess **+0.044%/period, t=+0.64 — NOT significant.** Only **2/6 years positive** (2025 +0.624%, 2026 +0.157%; 2021 −0.041%, 2022 −0.149%, 2023 −0.142%, 2024 −0.149%). Sharpe 1.02, CAGR 21.98% — indistinguishable from the universe benchmark's own 22.2%. | **The individual 14 factors' negative tail is real and strong (t=−3.15 to −9.28 each) — the naive mirror-image "buy the opposite" composite is NOT.** Same shape this file already documents for `high_vol`/`low_vol` ("both tails lose; the middle outperforms") — avoiding extreme overbought readings may be real, but actively buying extreme oversold readings does not symmetrically work; oversold-and-flat is not the same population as oversold-and-about-to-revert, and equal-weighting 14 heavily-correlated technical oscillators (stoch_k/stoch_d/williams_r/cci all measure closely related things) is closer to repeating one signal fourteen times than combining independent ones. **This is a fresh, direct confirmation of this file's own standing finding that combining/reweighting reduces performance in every case tested** — now true for this specific hypothesis too, not just the ones already in the table. **Deliberately NOT built into a live short-side sleeve or exclusion veto on this result** — building production code around a factor that just failed its own first honest test would repeat the exact build-first-measure-later pattern this file exists to prevent. The more promising, still-unbuilt next step, flagged not attempted: test whether EXCLUDING the top-decile-overbought names from the existing long-only buy pool (an avoid/veto, same shape as the already-validated `HIGH_VOL_VETO`) improves the platform's actual best factors, rather than trying to buy the opposite tail outright. |

### The `sql_translate` two-arg `date()`/`datetime()` fix (2026-08-16) changes NOTHING in the training data — measured before/after, not argued

`map_sqlite_functions()` only handled the `'now'` literal forms. Every other two-argument form was
broken: `date(d, '-30 days')` fell through to the SINGLE-argument rule, which swallowed the whole
argument list and emitted `(d,'-30 days')::date` — a row-expression cast that is **not** a
translation-time error and reads as plausible SQL; the all-literal form was left untranslated and
reached the server as `function date(unknown, unknown) does not exist`. Fixed and
negative-controlled (`test_maps_two_arg_date_and_datetime_over_a_column_or_literal`).

**This looked scoring-relevant and had to be checked, because `ml_ensemble.py` uses the broken form
in four places** — lines 1332, 1477, 1482, 1493, inside `load_training_data()`, which builds the
ML training matrix. A silently-mistranslated date window there would change every model's inputs.

**Measured, not reasoned about.** `load_training_data()` run against a full 23 GB replica of
production, with and without the fix:

| | rows | cols | `cr_upgrades` | `cr_downgrades` | `news_sentiment_score` |
|---|---|---|---|---|---|
| before fix | 48,344 | 318 | sum 175 / nonzero 126 / max 2 | sum 23 / nonzero 23 | sum 951.3999950797606 / nonzero 20,056 |
| after fix | 48,344 | 318 | sum 175 / nonzero 126 / max 2 | sum 23 / nonzero 23 | sum 951.3999950797606 / nonzero 20,056 |

**Byte-identical, to the last float.** Mechanism confirmed rather than assumed: all four call sites
sit under the `else:` of an `if use_postgres():` (nearest enclosing branch at ml_ensemble.py:1306
and :1348), i.e. the **SQLite half**, which is dead in production — `use_postgres()` returns True
unconditionally for every real process since 2026-08-15. The fix only ever affects code paths that
production does not execute; it matters for the decommission (those branches are being deleted) and
for the pytest suite now running on Postgres, not for any score.

**`factor_backtest.py` was deliberately NOT run**, same reasoning as the four entries below: it
measures price-panel factor edge and has no code path reading `technical_signals`' ML columns or
`load_training_data()`'s output. The applicable measurement is the before/after table above, taken
against real production data. No factor's measured edge changed.

### The drift haircut on `win_probability` — mechanism fixed 2026-08-15, NOT a factor-edge change

`scoring_engine.py`'s drift haircut multiplied a **calibrated** probability by a constant
(`wp * 0.85`). Two defects, both measured live before changing anything:

1. `calibrated_win_probability` is an isotonic fit whose entire purpose is that 0.60 means a 60%
   empirical win rate (`ml_calibration.py`). Scaling it by a constant is miscalibration **by
   construction**, not a judgment call.
2. Below 0.5 the old form was directionally backwards: `0.30 * 0.85 = 0.255` is *further* from
   neutral, i.e. MORE confident the name loses, when a drift haircut should mean less confidence.
   Measured over the full live history (73,563 rows / 68 dates): **1,448 rows (1.97%) sit below
   0.5** and were being made more extreme.

Fixed to `0.5 + m*(wp-0.5)` — shrink toward the neutral point, identical in shape to the
already-present `ml_calibration.edge_adjusted_probability`, which answers the same question and
whose docstring already argues the case for this codebase's bands.

**Measured impact, honest and small.** The band gates (`apply_ml_score_adjustment`, 0.55/0.40/0.30)
barely move: **50 of 73,563 symbol-days (0.07%)** change band, because `ml_ensemble`'s
cross-sectional rank-scaling compresses `win_probability` into a ±7.5% band around each day's
median (live distribution: mean 0.775, std 0.071, 5th pct 0.664). The real, systematic difference
is in the **continuous** consumer, `ml_alignment_points` (`int(wp*24)`, Factor 3 of 20 points):

| haircut in force | mean pts lost, MULTIPLY (old) | mean pts lost, SHRINK (new) | gap |
|---|---|---|---|
| m=0.93 | 1.63 / 20 | 0.63 / 20 | 1.00 pt on every symbol |
| m=0.85 | 2.82 / 20 | 0.91 / 20 | 1.92 pts on every symbol |

Blast radius is further reduced by the same-day `drift_detector.py` recalibration: the multiplier
is now 1.0 on ~75% of days (it was <1.0 on 100% of days before, permanently).

**`factor_backtest.py` was deliberately NOT run, and that is not an omission.** It measures
price-panel factor edge (momentum, value, …) and has no code path that reads `win_probability`,
`technical_signals`' ML columns, or `recommendation_log` — running it here would measure something
unconnected to the diff, the "evidence-shaped but meaningless artifact" `recurring-bugs.md` warns
about. Same reasoning as this file's `_log_recommendations` and `seed_screener_catalog` entries.
The applicable measurement is the before/after impact table above, taken from live production.

### The news-sentiment fallback magnitude (2026-08-16) — a dormant path, measured before changing

`scoring_engine.py`'s news load reads `news_sentiment_items` and, on **any** exception, fell back
to legacy `news_articles` with `sentiment_score = 1.0` and `impact = 'MEDIUM'`.

**Measured live before touching it, and the measurement is what makes this safe:**

1. **The fallback is dormant in production today.** All 7 columns the primary query needs
   (`symbols_json`, `sentiment`, `sentiment_score`, `impact`, `title`, `source`, `published_at`)
   exist on `news_sentiment_items`, which holds 55,432 rows. The `try` branch succeeds, so this
   fix has **zero live effect on any current score** — same shape as this file's
   `seed_screener_catalog` entry, and the reason no `factor_backtest.py` run applies (it reads
   the price panel and has no code path touching `news_sentiment_items` at all).
2. **But the constant was wrong by the full width of the scale.** Sampled 20,000 rows live:
   `sentiment_score` runs **[-1, +1]**, mean |score| **0.404**, median |score| **0.000**. The
   consumer takes `abs(...)` as a magnitude, so `1.0` scored every fallback article at the
   **maximum possible confidence — ~2.5× the average real article**. `news_articles` carries a
   direction and no magnitude, so the honest stand-in is an average-magnitude article: changed to
   **0.4**, the measured mean. Direction is untouched (the consumer's `mult` reads `sentiment`).
3. **The bare `except Exception` was narrowed to `SQLAlchemyError` and now logs.** Previously any
   failure — including a transient connection blip — silently swapped in the degraded path with
   no log line, so a real outage was indistinguishable from normal operation. That silence is why
   nobody could have noticed if the fallback ever *did* fire.

No score, weight, threshold or classification formula changed; a dormant constant was corrected
and a swallowed error made visible.

### `win_probability` re-measured 2026-08-20, properly powered — real IC, but does not clear this repo's own USABLE bar

Production-grade-hardening §4's "next step, in order" was: verify write-timing provenance (done
2026-08-15 via `win_probability_scored_at`) → re-run h=1 non-overlapping → cost/turnover-aware
portfolio run. This is the middle step, done live via `factor_edge.py` (the same harness already
scheduled for `unified_ranker.py`'s own engine scores, e.g. `smart_money_score` above) rather than
a hand-rolled query, so the result is directly comparable to every other row measured that way.

`factor_edge.py --table technical_signals --scores win_probability --horizons 1,5,21`, live
production, 2026-08-20T09:02 IST — **well-powered this time**, not the 1-date `LOW-DATA` reads
seen elsewhere in this file: 80,496 rows / 2,269 symbols / 72 dates spanning 2026-05-16→08-20,
75,558 rows matched to forward prices across 53/49/33 dates per horizon.

| horizon | rank_IC | hit_AUC | n | dates | verdict |
|---|---|---|---|---|---|
| 1d | +0.044 | 0.492 | 73,368 | 53 | no edge |
| 5d | +0.077 | 0.513 | 64,597 | 49 | no edge |
| 21d | +0.103 | 0.537 | 29,483 | 33 | no edge |

Top-decile-minus-bottom-decile quantile spread at 1d: **+0.17%** (Q4 mean fwd +0.12% vs Q0 −0.05%),
same direction as the 2026-08-15 preliminary read.

**Read this precisely, not as a flat "no edge."** `_verdict()` requires BOTH `abs(rank_IC) >= 0.03`
AND `hit_AUC >= 0.55` to call anything `USABLE`. Every horizon here clears the IC bar — cleanly,
and IC *grows* with horizon (0.044→0.077→0.103), the opposite of a decaying artifact — but AUC
never clears 0.55, topping out at 0.537 on 21d. This is exactly the "AUC can be excellent and
useless" class this file already warns about, inverted: here IC says something real is happening
directionally, but AUC says the binary win/lose classification power is too weak to act on. The
raw h=1 IC (+0.044) is close in magnitude to the original 2026-08-15 preliminary read
(+0.0364, t=+2.58, 41 dates) — it replicates in sign and rough size with 53 dates instead of 41
and a properly non-overlapping, provenance-verified sample, which is meaningful corroboration
rather than a fresh coincidence. Persisted to `factor_edge_history` (`run_at=2026-08-20T09:02:32`).

**Verdict for this repo's purposes: a real, small, well-powered directional signal that is not
tradeable as scored today** — same shape as `delivery_pct`'s "real spread, dead net of costs"
finding above, except here the disqualifier is classification power rather than cost.

**Cost/turnover-aware portfolio run — done 2026-08-20, confirms the inference above as a real
measurement, not just an educated guess.** Wired `win_probability` into `factor_backtest.py`
(`_add_win_probability`, same point-in-time convention as `_add_earnings_category` — plain
`(symbol, date)` merge, write-timing separately verified via `win_probability_scored_at`: ~14h
after that date's UTC midnight, i.e. the same IST evening, well before the next-open entry this
harness uses). 21d rebalance fails outright — `only 59 eligible sessions; need >= 63`, the same
calendar constraint `earnings_beat_yoy` hit (this column's history only starts 2026-05-16, ~3
months deep). At the shortest workable horizon, 5d/top-50/15bps:

| periods | years | net excess/period | t-stat | annual cost drag | verdict |
|---|---|---|---|---|---|
| 7 | 0.14 | +1.52% | **1.54** | 12.61%/yr | **NOT significant (|t|<2). Do not trade this.** |

83.4% one-way turnover per period — `win_probability` reshuffles which names rank highest fast
enough that it's expensive to hold, same shape as `gap_down`/`gap_up`'s turnover-trap finding
above, layered on top of the AUC weakness already found. **Both disqualifiers point the same
way**: weak classification power (hit_AUC 0.492-0.537) AND a real cost/turnover drag, on top of
only 7 periods of runway — even the +1.52%/period point estimate, if it held up with more data,
would need to survive a >12%/yr cost headwind it isn't currently clearing. Re-test only once
`win_probability` has ~12+ months of history, same bar this file already applies to
`screener_breadth`/`earnings_beat_*`. Re-check via the historical saga below only if trying to
understand *why* the write-timing/provenance question needed resolving before this could be
trusted at all.

### ⚠ SUPERSEDED same day, see the correction section immediately below — wrong grading horizon for 3 of 4

### The 4 previously-ungraded `unified_ranker.py` engines — graded 2026-08-20, none clear USABLE

Prompted by a "which of the ~30 models actually earn their runtime cost" review:
`breakout_classifier.py`, `movement_predictor.py`, `confluence_ml_engine.py`, and `cs_ranker.py`
had never been run through `factor_edge.py` or `factor_backtest.py` — no net-of-cost verdict, no
IC/AUC read, anywhere in this repo. Graded the same way `win_probability` just was, live
production 2026-08-20T12:03-12:05 IST.

`factor_edge.py --table technical_signals --scores breakout_probability,movement_probability,cs_score --horizons 1,5,21 --persist`
(80,517 rows / 2,269 symbols / 72 dates, 75,558 matched to forward prices):

| score | horizon | rank_IC | hit_AUC | n | dates | verdict |
|---|---|---|---|---|---|---|
| `breakout_probability` | 1d | +0.008 | 0.486 | 59,020 | 28 | no edge |
| `breakout_probability` | 5d | −0.007 | 0.496 | 50,249 | 24 | no edge |
| `breakout_probability` | 21d | −0.013 | 0.492 | 15,261 | 8 | LOW-DATA |
| `movement_probability` | 1d | −0.030 | 0.486 | 48,108 | 22 | no edge |
| `movement_probability` | 5d | −0.031 | 0.489 | 39,339 | 18 | LOW-DATA |
| `movement_probability` | 21d | −0.048 | 0.474 | 4,355 | 2 | LOW-DATA |
| `cs_score` | 1d | +0.047 | 0.505 | 73,368 | 53 | no edge |
| `cs_score` | 5d | +0.062 | 0.512 | 64,597 | 49 | no edge |
| `cs_score` | 21d | +0.015 | 0.508 | 29,483 | 33 | no edge |

`confluence_ml_engine.py`'s `ml_breakout_probability` lives in `confluence_signals`, a 30-min-cadence
intraday table (4.49M rows / 52 dates, not one-row-per-symbol-per-day like `technical_signals`), so
`factor_edge.py`'s `--table` CLI can't be pointed at it directly without either double-counting
same-day snapshots or picking a look-ahead-biased entry point. Reduced to the EARLIEST
`computed_at` per `(symbol, date)` — the most conservative, earliest-tradeable read — via a one-off
script that imported `factor_edge.py`'s own `_forward_returns`/`_metrics`/`_verdict` rather than
reimplementing the IC/AUC math, then persisted to `factor_edge_history` under
`table_name='confluence_signals_daily_first'` so it's flagged as a different measurement shape than
the other rows, deleted after the run (not a shipped tool):

| score | horizon | rank_IC | hit_AUC | n | dates | verdict |
|---|---|---|---|---|---|---|
| `ml_breakout_probability` | 1d | +0.016 | 0.511 | 83,527 | 37 | no edge |
| `ml_breakout_probability` | 5d | +0.040 | 0.526 | 74,140 | 33 | no edge |
| `ml_breakout_probability` | 21d | +0.022 | 0.521 | 36,584 | 17 | LOW-DATA |

**None of the four clear `USABLE` (needs `abs(rank_IC) >= 0.03` AND `hit_AUC >= 0.55`).** Two
data points worth reading precisely rather than as a flat zero: `cs_score` (5d IC +0.062) and
`ml_breakout_probability` (5d IC +0.040) both clear the IC bar alone — same "IC says something real,
AUC says it's not classifiable" shape `win_probability` showed above, just weaker (AUC 0.512/0.526
vs win_probability's 0.513/0.537). Three independent engines now show this identical ceiling
(win_probability, cs_score, ml_breakout_probability), which strengthens rather than weakens the
existing hypothesis that the AUC ceiling is a **label/target construction** problem shared across
this codebase's ML pipeline, not a property of any one model. `movement_probability` and
`breakout_probability` are flat negative/near-zero on both metrics — no directional signal at all,
not even the weak kind.

**Consumption check — this is the part that makes the finding actionable, not just descriptive.**
Grepped `unified_ranker.py` for all four:
- **`cs_score` and `breakout_probability` ARE live-blended** into `unified_score` today (`engine_scores['cs']`/`engine_scores['breakout']`, unified_ranker.py:2065-2092,2221) — i.e. two inputs to the canonical Buy/Sell call that every dashboard shell ultimately reads now have an external, well-powered (24-53 dates) "no edge" verdict.
- **`movement_probability` is advisory-only by its own inline comment** (queues.ts:1102, "Advisory-only for now") — never read by `unified_ranker.py` at all. It trains, scores, and writes on a 30-min job for a value nothing downstream ever consumes beyond a freshness-coverage check (`dataQualityChecks.ts`) and a NEVER_FILL list (`densify_feature_matrix.py`). Pure runtime cost, zero output.
- **`ml_breakout_probability` has no reader anywhere outside `confluence_ml_engine.py` itself** — not `unified_ranker.py`, not any other file. Same shape, fully inert.

**Does not contradict `load_engine_edge_verdicts()`'s existing gate.** `unified_ranker.py`'s live
`ENGINE_EDGE_SHRINK` mechanism (line 681 area) reads `factor_edge_history` filtered to
`table_name='unified_recommendations'` — i.e. the ranker's OWN blended reporting columns
(`cs_score`/`breakout_score` on `unified_recommendations`), not the raw `technical_signals` values
graded above. Checked live: that table's own grading run (`run_at=2026-08-17T19:05:22`) is stuck at
**1 date** for both (`LOW-DATA`) — same calendar-constraint shape as `smart_money_score`'s existing
entry below, because `unified_recommendations_history` still only has a handful of provably
pre-market dates. So the live auto-shrink gate has nothing to act on yet regardless. **The grading
above is a different, much better-powered read of the same underlying question** (24-53 dates vs 1)
— it measures whether the raw engine output has any signal at all, upstream of the ranker's own
regime multipliers and crowding discount, and at this sample size it's a more decisive answer than
the gate's own input currently can give.

**Not escalated to a `factor_backtest.py` cost/turnover-aware run.** Unlike `win_probability`
(real, *growing* IC that justified the extra cost-aware pass), none of these four clear even the
fast IC+AUC screen — the two closest (`cs_score`, `ml_breakout_probability`) are weaker than
`win_probability`'s already-tested-and-rejected 5d read. Per this file's own "already tested, do
not re-run without a reason" discipline, spending a full cost-aware backtest on a result already
below a rejected bar isn't warranted.

### ⚠ CORRECTED 2026-08-20 — the section above graded 3 of 4 engines against the wrong target entirely

The user's own instinct to check ("make sure it's configured properly, full potential of data,
before verdict and decommission") caught a real methodology error, same session, before anything
was decommissioned. `factor_edge.py`'s generic 1/5/21d terminal-return grid is the right tool for
a factor with no native target of its own — it is the WRONG tool for a model with a specific,
different trained target, and 3 of the 4 graded above have one:

- `breakout_classifier.py`'s label is `forward-10-day MAX return >= +6%` (`HORIZON=10`,
  `RET_THRESHOLD=0.06`, a path-based MFE event, defined in `build_breakout_labels`) — not a
  1/5/21d terminal-return question.
- `movement_predictor.py`'s label is `build_movement_labels`'s "was TODAY's day-range in the
  top decile cross-sectionally" — a SAME-DAY volatility classification, not a forward return
  question at all.
- `confluence_ml_engine.py`'s label is `signal_outcomes`' own 7-day WIN/LOSS for
  `signal_source='confluence'` — not the generic grid either.
- `cs_ranker.py` is the one exception: `HORIZON_DAYS_LABEL=5`, a 5-day-forward cross-sectional
  rank percentile vs NIFTY50 — genuinely matched by `factor_edge.py`'s 5d cross-sectional-excess
  test. **Its "no edge" verdict above stands, correctly configured on the first pass.**

Re-graded the other three against their actual native label, reusing each source file's own
label-construction function (`build_breakout_labels`, `build_movement_labels`,
`signal_outcomes` directly) rather than reimplementing the logic — live production,
2026-08-20T12:15 IST:

| score | native target | rank_IC | hit_AUC | n | dates | verdict |
|---|---|---|---|---|---|---|
| `breakout_probability` | fwd-10d max return ≥ +6% | +0.153 | 0.583 | 37,969 | 19 | LOW-DATA (1 date short of the 20-date reliability bar) |
| `movement_probability` | same-day top-decile day-range | +0.410 | **0.894** | 31,611 | 23 | **USABLE by the numbers — but see the leak finding below, do not trust this AUC yet** |
| `ml_breakout_probability` | `signal_outcomes` WIN/LOSS, h=7, source=confluence | +0.082 | 0.553 | 52,583 | 44 | **USABLE**, real and well-powered though weak |

**Two of three flip completely once graded against the right target — this is a materially
different picture than "0 of 4 have anything."** `breakout_probability` shows a real, large IC
(+0.153) and AUC (0.583) at its own horizon, one date short of reliable. `ml_breakout_probability`
clears `USABLE` outright with 44 dates behind it — genuinely the strongest previously-ungraded
result in this file, and it deserves the same cost-aware `factor_backtest.py` follow-up
`win_probability` got, which the superseded section above explicitly (and, per this correction,
wrongly) declined to run.

**`movement_probability`'s AUC=0.894 is NOT real — traced to an actual bug in the live scoring
path, not a modeling success, and the fix is what makes this section's numbers trustworthy.**
`load_training_data()` (`movement_predictor.py`) correctly applies `_lag_by_symbol()` before
merging features against the same-day `moved` label — a row labelled date d carries date d-1's
raw feature values, so training predicts "will today be a big-range day, using only what was
knowable before today opened" — a legitimate, leak-free, one-day-ahead forecast. **`score()`, the
live production path that actually populates `technical_signals.movement_probability`, called
`compute_ohlcv_features(ohlcv)` directly and skipped the lag** — so the column live in production
for all 23 dates measured above was generated using each day's OWN just-closed OHLCV bar to
"predict" that same day's own range classification. That is a same-day leak, and it fully explains
an AUC (0.894) implausibly higher than any other engine graded anywhere in this file — it is the
train/serve-skew bug class this repo's `recurring-bugs.md` already tracks (`"Grouping training
rows by day when scoring reads one snapshot is train/serve skew"`), just discovered here via the
inverse route: not a low test score exposing a skew, but an impossibly HIGH one.

**Fixed** (`movement_predictor.py`, `score()`): now composes `_lag_by_symbol(compute_ohlcv_features(ohlcv), ...)`
identically to `load_training_data()`, so the live column is generated the same way the model was
trained and validated. Negative-controlled (`test_movement_predictor.py::TestScoreUsesLaggedFeatures`
— fails against the pre-fix raw-feature composition, confirmed by hand before landing). **Every
`movement_probability` value written before this fix (all 23 dates, 2026-07-16→08-19) is tainted
and must not be used to judge this model** — the column needs to accumulate fresh, correctly-lagged
scores post-fix before a real verdict is possible. Re-check once ~20+ fresh dates have written
under the fixed code path; until then this engine's true native-target AUC is unknown, not 0.894
and not "no edge" — genuinely ungraded again, honestly this time.

**Consumption reminder, unchanged by this correction:** `movement_probability` remains
advisory-only (queues.ts:1102, zero readers in `unified_ranker.py`) and `ml_breakout_probability`
still has zero readers outside its own writer — neither is live-blended into `unified_score`, so
none of this changes what a user sees today. `cs_score`/`breakout_probability` ARE live-blended;
`cs_score`'s no-edge verdict is unchanged and correctly configured, and `breakout_probability`'s
new LOW-DATA-but-promising read means it should NOT be downweighted on the strength of the
superseded section above — re-check in a few trading days once it crosses 20 dates.

### The remaining 3 unified_ranker.py engines with no individual verdict — graded 2026-08-20

The correction above only covered the 4 engines already flagged "ungraded" in an earlier pass.
`unified_ranker.py` blends **8** engines total (`ENGINE_TO_SCORE_COL`); `screener`/`ml`/`cs`/
`smart_money`/`breakout` all had a verdict somewhere in this file already — `confluence`,
`technical`, and `dl` did not, checked by reading `_get_confluence_scores`/`_get_technical_scores`/
`_get_dl_scores` directly for what table/column/formula each actually reads, live production:

- **`dl` → `deep_learning_predictions.prob_up_5d`** (a BiLSTM, `dl_engine.py`). Native label is
  explicit and unambiguous in the source (`target_ret_5d > 0` — a plain 5d terminal-return
  direction; the table also carries `prob_up_1d`/`prob_up_15d` heads with matching `target_ret_1d`/
  `target_ret_15d` labels), so no horizon-mismatch risk here — graded each head at its own native
  horizon directly, 94,851 rows / 40 dates / 06-17→08-20:

  | score | native horizon | rank_IC | hit_AUC | n | dates | verdict |
  |---|---|---|---|---|---|---|
  | `prob_up_1d` | 1d | −0.010 | 0.483 | 55,913 | 24 | no edge |
  | `prob_up_5d` | 5d | +0.047 | 0.518 | 46,246 | 20 | no edge (marginal — right at both the IC and date-reliability boundary) |
  | `prob_up_15d` | 15d | +0.018 | 0.509 | 31,752 | 14 | LOW-DATA |

  `prob_up_5d` read at 15d (off its native horizon, for context only): IC +0.090, AUC 0.543,
  14 dates — the same "IC grows with horizon" shape seen in `win_probability`/`ml_breakout_probability`
  below, but too thin to verdict. **No native-target mismatch to correct here** — `dl_engine.py`
  was, unusually for this file's history, built with its own graders in mind (3 explicit horizon
  heads, each with a matching return-direction label) — the "no edge" verdict is on a properly
  configured test.

- **`technical` → `technical_signals.signal_score`** (trailing-3-day average of a 0-10 rule-based
  composite, not an ML model with its own trained target — so the generic 1/5/21d grid IS the
  right test, no mismatch risk). 80,519 rows / 72 dates / 05-16→08-20 — the best data depth of
  any engine graded in this file:

  | horizon | rank_IC | hit_AUC | n | dates | verdict |
  |---|---|---|---|---|---|
  | 1d | −0.003 | 0.499 | 73,368 | 53 | no edge |
  | 5d | +0.012 | 0.501 | 64,597 | 49 | no edge |
  | 21d | +0.029 | 0.506 | 29,483 | 33 | no edge |

  Clean no-edge, well-powered at every horizon, right up against chance (AUC 0.499-0.506).

- **`confluence` → the "non-screener" composite** (`trend_alignment_score + volume_score +
  sector_strength_score + fundamental_score`, computed inline in `_get_confluence_scores` — not a
  stored column, and NOT the same thing as `ml_breakout_probability` graded above or the raw
  `confluence_score` the standalone Confluence page/`intraday_ranker.py` still use, which include
  the screener component this engine deliberately drops per the 2026-08-05 decorrelation fix).
  Also rule-based, no native-target mismatch risk. Replicated the exact SQL formula from
  `unified_ranker.py:1531-1538` against the earliest daily snapshot per symbol (same shape as
  `ml_breakout_probability`'s grading): 194,834 rows / 52 dates / 06-30→08-20:

  | horizon | rank_IC | hit_AUC | n | dates | verdict |
  |---|---|---|---|---|---|
  | 1d | +0.019 | 0.511 | 83,693 | 37 | no edge |
  | 5d | +0.056 | 0.533 | 74,306 | 33 | no edge |
  | 21d | +0.067 | 0.543 | 36,750 | 17 | LOW-DATA |

  Same shape again: IC and AUC both climbing with horizon, still short of `USABLE`, thinning out
  past 5d.

**`cs_score`/`technical_score` re-reviewed 2026-08-20 for a configuration/data cause behind
"no edge" before accepting it** — same discipline that found real bugs behind `movement_probability`'s
and `win_probability`'s prior verdicts. Neither turned one up:
- `cs_ranker`'s active model (`model_registry` id 228, trained 2026-08-09) has correctly survived
  3 consecutive retrains (08-16, 08-16, 08-17) that each came back with a LOWER self-reported CV
  ROC-AUC (0.176 active vs 0.161/0.161/0.133 rejected) — `clears_promotion_bar`/`staleness_override_applies`
  working as designed (needs `age_days>=7` AND `rejections>=10`; only 3 rejections logged, so no
  stale-baseline deadlock). The `cs_score` grading above tested the best model the gate has ever
  had available, not a stale one. **The declining trend across retrains is a real, unexplained
  observation worth a future look** — not confirmed as a bug (self-reported CV-AUC on a thin,
  5-day-forward, date-split holdout set is exactly the kind of metric this file already warns
  never to trust blindly), just flagged rather than silently dropped.
- `signal_score`'s inputs (`signal_type_stats`/`signal_type_weights`, read via `loadSignalWinRates`/
  `loadLearnedWeights` in `technicalSignalsService.ts`) are genuinely populated and varied, live-checked:
  312 stat rows across 20 signal types (win rates 0–91.7%), 858 weight rows across 21 types
  (0.3×–2.0×, avg 0.91×) — not constants, not defaults, not the `mf_*`-style degenerate-input
  shape that caused the factor-crowding bug elsewhere in this file.

**Conclusion: leave both at their current `unified_ranker.py` weights.** Unlike `screener`
(confirmed negative by two independent measurements), `cs_score`/`technical_score` are confirmed
null with no configuration issue behind it — the existing `ENGINE_EDGE_SHRINK` gate is the right
mechanism for them once their own `unified_recommendations`-level verdict clears LOW-DATA, same
bar every other null-verdict engine in this file is held to.

**All 8 `unified_ranker.py` engines now have an individual verdict somewhere in this file** —
`screener_stock_score` via the extensive screener-testing work elsewhere in this file (0 of 1,563
individual screeners survive correction; bullish consensus significantly negative), `ml_score` via
`win_probability`'s dedicated section, `cs`/`breakout`/`smart_money`/`confluence`/`technical`/`dl`
above. **None clears `USABLE` outright** except `ml_breakout_probability` (a ninth, sub-engine
signal feeding `confluence_ml_engine.py`, not itself one of the 8 blended keys). The repeated
IC-grows-with-horizon-but-AUC-stalls-near-0.52 shape now appears in five independent, architecturally
different engines (`win_probability`'s LGBM ensemble, `cs_score`'s cross-sectional ranker,
`ml_breakout_probability`'s classifier, `prob_up_5d`'s BiLSTM at 15d, the confluence composite at
21d) — that consistency across unrelated model families is itself evidence worth weighing: it reads
less like "eight separate weak models" and more like a shared ceiling, most plausibly the
class of the label itself (short-horizon Indian-equity forward direction is close to
efficiently-priced at this universe's liquidity floor) or a shared calendar constraint (every
longer-horizon read in this list is also the thinnest-data read, so LOW-DATA and "genuinely weaker
long-horizon edge" are still confounded and not yet separable with the history available).

### `factor_edge.py` grades close-to-close, but the panel spec mandates next-day OPEN entry — measured 2026-08-22, every IC in `factor_edge_history` is optimistic

This file's own panel spec says, without qualification: **"Next-day OPEN entry. Signals computed
off a close cannot be bought at that close."** `factor_edge.py` — the harness that produces every
`factor_edge_history` verdict, and the one the "CORRECTION, same day" section immediately below
calls "the read that counts" — does not do this. `_forward_returns()` selects only
`symbol, date, close` from `stock_ohlcv` and computes `fwd_N = close.shift(-N) / close - 1`.
There is no `open` in the query at all. So the measured return starts at the close of date *d*,
a price no one holding a signal generated that evening could have transacted at.

**This is not a look-ahead bug and the verdicts are not fabricated.** Write timing was checked
live: `engine_composite_scores` rows for date *d* are stamped ~20:00 IST on *d*, i.e. after the
15:30 close, so the score genuinely exists before the return window opens. The defect is
narrower and entirely about *tradeability*: the harness credits a strategy with the overnight
gap between *d*'s close and *d+1*'s open, which is exactly the move a next-day-open entry
cannot capture. Mean absolute overnight gap on this universe, last 90 days, `is_suspect`
excluded, gaps >25% dropped: **0.94%** — large next to a 5d IC of +0.083.

**Measured directly on `engine_composite_scores` (82,402 rows, per-date then averaged,
cross-sectional excess, same construction both ways — only the entry/exit price changes):**

| horizon | IC close→close (what `factor_edge` reports) | IC next-open→open (panel spec) | delta | dates |
|---|---|---|---|---|
| 1d | +0.0451 | **+0.0210** | **−0.0241** | 49 |
| 5d | +0.0839 | +0.0793 | −0.0046 | 45 |
| 21d | +0.0800 | +0.0685 | −0.0115 | 29 |

**Every horizon is overstated, and h=1 is overstated by more than half its value.** That is the
expected shape: a fixed ~0.94% untradeable gap is a large fraction of a 1-day return and a small
fraction of a 21-day one. The 5d reading — the headline "+0.083, highest on the platform" — is
the most robust of the three, losing only 0.005.

**Consequence, stated precisely, because it is easy to over-read.** No verdict in
`factor_edge_history` flips on this: the composite is `no edge` under both conventions (the
binding constraint there is AUC ~0.53, not IC), and every "no edge" engine graded by this
harness is *more* firmly no-edge under the honest convention, not less. What changes is that
**every IC number this harness has ever produced should be read as an upper bound**, and any
future factor that clears a bar by a hair at short horizons must be re-checked at next-open
before the verdict is believed. The h=1 column is the one to distrust most.

**Deliberately NOT fixed in this pass.** Changing `_forward_returns()` rewrites the meaning of
every historical row in `factor_edge_history`, so the correct sequence is to add an
`--entry open` mode, re-grade in parallel, and record both — not to silently mutate a table
whose earlier rows would then be incomparable with its later ones. Same discipline as this
file's own "a bug in the measurement tooling is worse than no measurement, because it looks like
evidence" entry: the fix to a harness needs at least as much care as the thing it measures.

### ⚠ CORRECTION, same day — the "USABLE" claim below does NOT survive the standard harness

Written before the composite was persisted and re-graded through `factor_edge.py` itself. Once
it was (`engine_composite_scores`, 82,402 rows / 66 dates / span 2026-05-23..08-21, i.e. a
LONGER window and MORE dates than the ad hoc run below):

| horizon | rank_IC | hit_AUC | n | dates | verdict |
|---|---|---|---|---|---|
| 1d | +0.044 | 0.511 | 76,266 | 50 | no edge |
| 5d | **+0.083** | 0.526 | 67,493 | 46 | no edge |
| 21d | +0.077 | **0.540** | 32,407 | **30** | **no edge** |

**The IC reproduces exactly (+0.077 at 21d). The AUC does not: 0.540 on 30 dates versus 0.558
on 25.** 0.55 is the bar, so the verdict is `no edge`, not `USABLE`. The ad hoc run below
computed its cross-sectional excess over a slightly different matched universe and started a
week later; the harness read is better powered and is the one that counts. **Treat every
"USABLE" in the section below as retracted** — the numbers there are otherwise accurate and the
ensemble reasoning still stands, but the verdict does not.

What survives, and it is still the strongest cross-sectional result in this file:
**5d rank IC +0.083 over 46 dates is the highest 5d IC measured on this platform** — roughly 7x
`unified_score`'s +0.012 on comparable data, and above every individual engine. So the ensemble
effect is real; what it does not do is clear the classification bar.

This is the SAME "IC says something real, AUC stalls near 0.52-0.54" shape this file already
documents across five architecturally unrelated engines (`win_probability`, `cs_score`,
`ml_breakout_probability`, `prob_up_5d`, the confluence composite). The composite inherits the
ceiling rather than escaping it — which is evidence FOR the shared-label-ceiling hypothesis in
the section further below, not against it: combining six independent signals raised IC
substantially and moved AUC barely at all.

**Consequence: nothing changes about what is safe to trade.** It was already not wired into
`unified_ranker.py`; it stays not wired in. `engine_composite.py` persists it daily so it keeps
accumulating and can be re-graded honestly, which is the whole point of persisting it.
**Lesson, and it is the reason this correction exists: a result computed in a one-off script
must be re-run through the shipped harness before it is written down as a verdict.** The IC
agreed to three decimals and the AUC still crossed the threshold in the other direction.

### `_blend` was averaging engines on different scales — fixed 2026-08-22, and the fix is a CORRECTNESS change with a NULL measured effect on IC

Read the verdict before the diagnosis: **the defect below is real, directly measured, and was
silently making `REGIME_WEIGHTS` meaningless. The fix does NOT produce a measurable forward-IC
improvement, and it does not fix the coverage artifact it was partly aimed at.** Shipped as a
correctness fix on that basis, not as an accuracy gain. Do not cite it as one.

**The defect.** Four engines (`screener`/`cs`/`confluence`/`technical`) are percentile-rank
normalized inside their getters; the four probability engines (`ml`/`dl`/`breakout`/
`smart_money`) return raw `probability*100` and were not. `_blend` is a weighted AVERAGE, so it
was averaging incomparable scales. Live, 2026-08-24 snapshot, 2,075 symbols:

| engine | live range | mean | weight (BULL) | **effective ranking share** |
|---|---|---|---|---|
| `confluence_score` | 0–100 | 67.6 | 0.172 | 23.7% |
| `screener_stock_score` | 0–100 | 55.8 | 0.150 | 21.0% |
| `technical_score` | 0.1–99.9 | 50.3 | 0.137 | 14.2% |
| `dl_score` | 0–98.6 | 31.2 | 0.092 | 12.7% |
| `smart_money_score` | 0–100 | 27.6 | 0.064 | **10.9%** (403/2,075 coverage) |
| `cs_score` | 0.1–99.8 | 51.7 | 0.064 | 8.5% |
| `breakout_score` | 0.8–77.2 | 44.8 | 0.150 | 8.0% |
| **`ml_score`** | **69.1–74.1** | 73.2 | **0.172** | **1.1%** |

Influence is proportional to weight × dispersion, so **a weight was not an influence share**.
`ml` was the joint-heaviest engine contributing 1.1% of the ranking; `smart_money` — unmeasured,
19% coverage, nearest analogue significantly inverted — drew 10.9% off a 0.064 weight purely for
having the widest raw spread. **Consequence for this file's own history: the 2026-08-20
re-derivation of `REGIME_WEIGHTS` (the screener shrink, the breakout ceiling pinning) was tuning
numbers that did not control what it believed they controlled.** That does not invalidate the
screener finding itself — which rests on two independent measurements, not on the weight table —
but any future weight tuning is only meaningful after this fix.

`ml`'s collapse is episodic, not permanent, and it is not new: `_get_ml_scores` reads
`calibrated_win_probability`, whose isotonic calibrator correctly flattens in a no-edge regime.
Per-(engine, date) stddev over 38 ranker-days (2026-06-01..08-24, 138 engine-days) is bimodal —
31 observations under sd 2, the healthy mass from ~10 up, a sparse valley between — and
`ml` sits under 5 on **13 of 38 days**, `dl` 15, `technical` 7.

**The fix**, two coupled parts (`unified_ranker.py`):
1. `engine_maps_blend = {name: _normalize_to_100(m) ...}` — blend view only. `engine_maps_all`
   stays raw so the persisted `*_score` columns remain diagnostic and `breakout`'s raw
   probability still drives position sizing against its own p80/p90 thresholds.
2. `ZERO_DISPERSION_MIN_SD = 5.0` added to `drop_zero_dispersion_engines`, which previously
   tested for `<= 1e-9` range, i.e. only a PERFECTLY flat engine. **This is required BY part 1,
   not an independent tightening**: `_normalize_to_100` re-spreads any input to a uniform 0–100,
   so a collapsed engine that used to contribute a harmless 1.1% offset would, normalized,
   contribute 17.2% of pure noise. Threshold sits in the measured valley above.

**The measurement — an A/B on IDENTICAL rows, and it is a null.** Both arms reconstructed from
the stored per-engine `*_score` columns using `unified_ranker`'s own `_blend`/
`_normalize_to_100`/`drop_zero_dispersion_engines` and graded with `factor_edge.py`'s own
`_forward_returns`/`_metrics`/`_verdict`. 72,030 rows / 38 dates / 2,406 symbols; 69,687 matched
to forward prices.

| arm | h=1 IC / AUC | h=5 IC / AUC | h=21 IC / AUC | verdict |
|---|---|---|---|---|
| `OLD_prod` (eps guard, raw scales) | 0.0178 / 0.510 | 0.0434 / 0.519 | 0.0571 / 0.521 | no edge |
| `sd_only` (sd guard, raw scales) | 0.0177 / 0.512 | 0.0435 / 0.522 | 0.0570 / 0.534 | no edge |
| `norm_only` (eps guard, normalized) | 0.0172 / 0.517 | 0.0438 / 0.532 | 0.0600 / 0.539 | no edge |
| **`NEW` (both — shipped)** | 0.0177 / **0.518** | 0.0438 / **0.532** | 0.0595 / **0.539** | **no edge** |

**Rank IC is flat across all four arms**, and the paired per-date sign test says nothing:
h=1 norm wins 15/36 dates (p=0.41), h=5 16/32 (p=1.00), h=21 12/20 (p=0.50). AUC rises
consistently at every horizon (+0.008 / +0.013 / +0.018) and both parts contribute — the sd
floor carries most of the h=21 gain, normalization most of h=5 — but **nothing clears the 0.55
bar**, so `_verdict()` reads `no edge` before and after. This is the same
IC-real-but-AUC-stalls shape this file documents across six other engines.

**Three caveats that bound what the A/B can claim, stated rather than buried:**
1. **Reconstruction fidelity is only 0.5665** (Spearman, reconstructed `OLD_prod` vs the stored
   `unified_score`, 2,075 rows). Expected to be below 1.0 — `quality_gate`, `RED_FLAG_VETO`,
   `HIGH_VOL_VETO` and `factor_crowding` all multiply AFTER the blend, and the RL gate and
   tradeable-universe restriction drop rows — but 0.57 means **this graded the blend in
   isolation, not the final ranking.** The multipliers reorder heavily enough that a blend-level
   improvement need not survive to `unified_score`.
2. `base_weights` can be edge-adjusted at runtime (`edge_adjusted_weights`, flag-gated, default
   off); the A/B used raw `REGIME_WEIGHTS` for both arms. Valid as a relative comparison.
3. Only 20 dates resolve at h=21 — at this file's own `MIN_DATES_RELIABLE` boundary.

**The coverage artifact was NOT fixed, and the original claim is corrected here.** The
mean-offset effect is real: engine means ran 27.6 to 73.2, and symbols with 3 engines averaged
28.31 with 91 Sell / 0 Buy while the bottom-100 by `unified_score` averaged 4.94 engines against
6.75 universe-wide. But normalization does not remove it. Measured both ways on the same
snapshot: bottom-100 average coverage improves 4.02 → 4.84 (less extreme), while **the rank
correlation between engine coverage and score gets WORSE, +0.2163 → +0.2799.** Normalizing makes
every engine mean-50 *over its own coverage universe*, which does not make a symbol scored on 3
sub-universes comparable to one scored on 7 — and a blend over fewer engines has higher variance
either way. **The real residual is cross-universe comparability, which this fix does not
address**, and the 3-engine cohort still averages 31.08 (vs 35.59 before). Anyone picking this
up next: that, not the scale mismatch, is what is left.

**Net: ship it for correctness, do not quote it as accuracy.** Weights now mean what they say,
which is a precondition for any future tuning being interpretable; the measured forward effect
is null on IC and sub-threshold on AUC. Re-grade against live `unified_recommendations` via
`factor_edge.py` once ~20 post-fix dates accumulate (roughly late September 2026), which is the
only way to see whether the AUC drift survives the multiplier stack.

### An equal-weight composite of RAW engines is the first thing here to clear USABLE — 2026-08-21

The best result measured on this platform to date, and the reason it is worth reading carefully
rather than acting on immediately. Built from the **raw** engine outputs (not
`unified_recommendations`' stored/normalized copies, which behave differently — `cs_score` is
+0.061 raw vs −0.012 stored, `confluence` +0.055 raw vs −0.067 stored, i.e. the ranker's own
normalization is degrading its inputs before it blends them).

**Deliberately NO FITTING**, so this cannot be an in-sample artifact: per-date cross-sectional
RANK z-score of each engine, **equal** weights, signs fixed a priori from documented direction.
Weighting by measured IC on the same panel would be the in-sample trap this file warns about.
Graded with `factor_edge.py`'s own `_metrics`/`_verdict`.

| score | 1d IC / AUC | 5d IC / AUC | 21d IC / AUC | dates (1/5/21) | 21d verdict |
|---|---|---|---|---|---|
| `win_probability` | +0.035 / 0.495 | +0.078 / 0.529 | +0.126 / 0.541 | 45/41/25 | no edge (AUC) |
| `confluence_ns` | +0.018 / 0.517 | +0.059 / 0.548 | +0.069 / **0.556** | 39/35/19 | LOW-DATA |
| `prob_up_5d` | +0.017 / 0.495 | +0.042 / 0.516 | +0.084 / 0.533 | 26/22/14 | LOW-DATA |
| `cs_score` | +0.021 / 0.510 | +0.030 / 0.514 | +0.020 / 0.507 | 45/41/25 | no edge |
| `signal_score` | −0.000 / 0.504 | +0.005 / 0.505 | +0.014 / 0.512 | 45/41/25 | no edge |
| `breakout_probability` | −0.005 / 0.506 | −0.006 / 0.521 | −0.014 / 0.525 | 30/26/10 | LOW-DATA |
| **`composite_all`** (all 6, no selection) | +0.021 / 0.521 | +0.054 / 0.546 | **+0.081 / 0.562** | 45/41/**25** | **USABLE** |
| `composite_pos` (the 4 positive ones) | +0.025 / 0.519 | +0.061 / 0.544 | **+0.088 / 0.561** | 45/41/25 | **USABLE** |

**Lead with `composite_all`, not `composite_pos`.** `composite_pos` selects the 4 engines that
scored positive *on this same panel*, which is a mild selection effect; `composite_all` takes all
six with no selection at all and still clears the bar. That the unselected version works is the
stronger claim.

**Why it works, checked rather than assumed — the engines really are independent.** Pairwise
Spearman on the z-scored panel: max |rho| = **0.293** (`cs_score`/`breakout_probability`), next
0.281, 0.273; most pairs under 0.1; `prob_up_5d` is under 0.05 against everything. Uncorrelated
signals with individually positive IC are exactly the case where equal-weighting should beat any
component, and here it does: the composite clears AUC 0.55 at 21d, which **no single engine
does** (`win_probability` has the highest IC of any component, +0.126, and still fails on AUC at
0.541). This is a genuine ensemble effect, not a restatement of the best member.

**Head-to-head vs `unified_score` is directionally strong but NOT yet significant**, and the
reason is `unified_recommendations_history`'s short pre-market history, not the composite:
paired on identical rows, `composite_all` beat `unified_score` on 3/3 dates at h=5 (mean IC delta
**+0.045**, sign-test p=0.125) and 5/7 at h=1 (p=0.227). Only 3-7 comparable dates exist. Re-run
once ~20 accumulate.

**⚠ This is IC, NOT a tradeable edge, and this file has been fooled by exactly that before**
(`delivery_pct`: quintile spread t=+7.82 and still **dead** long-only net of costs). Turnover
measured, not guessed: **91% one-way per 21d rebalance** (96%/86% on the two observable
transitions, top-50, ≥₹1cr ADT20) — high, the same churn shape as the `gap_down`/`gap_up`
turnover trap, but at a 21d cadence that annualizes to only **3.28%/yr @15bps and 5.46%/yr
@25bps**, versus gap_down's 5.6-13.7%/yr at faster rebalances. So the drag is plausibly
survivable here where it was not there — *plausibly*, because the gross number to compare it
against has not been computed.

**The binding constraint is calendar, and it is severe: only 2-3 NON-OVERLAPPING 21d periods
exist** (46 usable dates). The 25-date 21d reading above is on **overlapping** windows, so its
observations are autocorrelated and any t-stat from it is optimistic — same caveat this file
already applies to every h=5 overlapping read. A real `factor_backtest.py` cost-aware run needs
≥63 eligible sessions and cannot run yet, exactly as `win_probability` and `earnings_beat_yoy`
hit the same wall.

**Consequently NOT wired into `unified_ranker.py`, and that is deliberate.** Building production
scoring on a factor that has never survived a cost-aware test is the precise build-first-measure-
later pattern this file exists to prevent — and the reverted "Smart Money Override" is the
in-repo precedent for what that costs. The correct next step is to let it accumulate and grade it
through the cost-aware harness at ~12 months (roughly 2027-06), then decide. Until then the
honest status is: **the most promising signal measured on this platform, and still unproven.**

### The ML training label switched to a cost-aware triple barrier, and promotion now gates on realized forward IC — 2026-08-21

Three coupled changes, in the order they had to happen. Every number below is measured live.

**1. `ml_ensemble.py` was training on a label that could not mean money.** The default was
`label='horizon'` → `signal_outcomes.outcome`, which for `signal_source='technical'` is 100%
`label_definition='path_barrier'` — the max-favourable-excursion rule this file already warns is
not comparable to a terminal return. Its properties are disqualifying on their own:

| label | training rows | base rate | median `return_pct` | mean `return_pct` |
|---|---|---|---|---|
| `horizon` (path_barrier / MFE) | 54,211 | **0.7165** | +3.69% | +61.72% |
| **`triple_barrier`** (`signal_excursions.tb_label`) | **180,849** | **0.4007** | **0.00%** | +15.70% |

A 71.65% base rate with a **+3.69% median "return" on a WIN/LOSS label** is the tell: it books a
win for a name that merely traded through a level intraday and gave it all back. `signal_outcomes`
at h=15 reads 18,096 WIN / 2,476 LOSS (88%) at an average "return" of +18.8%. **A model trained on
that predicts volatility, not profit.**

**Nothing had to be built.** `exit_labeler.py` has written a López de Prado triple-barrier label
(`tb_label`) all along — vol-scaled asymmetric barriers (`TB_K_UP=2.0` / `TB_K_DN=1.0`, i.e. 2:1
reward:risk on ±ATR) with a `TB_COST_FRAC=0.15·atr_pct` neutral band, so a "win" is a trade that
cleared its stop AND its costs — and `ml_ensemble.py` already accepted `--label triple_barrier`. It
was populated on **294,518 of 333,177 `signal_excursions` rows** and had simply never been
selected: `queues.ts:1318` ran `--train --tune --score` with no `--label`, taking the `'horizon'`
default. Flipped the default and pinned it explicitly at both `queues.ts` call sites rather than
writing anything new.

Contamination checked before trusting the label, not after: `signal_excursions.horizon_close_pct`
maxes at **+27,400%** (RNAVAL, from a stale `entry_price` of 2.30 in `signal_outcomes`). That is
**183 of 333,177 rows = 0.055%**, and `tb_label` is an ordinal barrier-touch label, so magnitude
outliers cannot move it. Usable as-is; the `entry_price` defect is real but separate and untouched.

**2. The honest label's CV lands exactly on the incumbent's live grade — that is the whole point.**
Trained live (`--train --dry-run --label triple_barrier`, 180,849 samples):

| | CV (purged-OOF) | held-out test | live realized `hit_auc` |
|---|---|---|---|
| `horizon` incumbent (`model_registry` id=220) | **0.7664** | 0.6767 | **0.493 / 0.512 / 0.535** @ 1/5/21d |
| **`triple_barrier` (new)** | **0.5203** | **0.5384** | not yet deployed |

**0.7664 was the best CV of all 59 registered ensemble candidates, and it was measuring the
label's easiness.** The new 0.5203 reproduces the live number `factor_edge.py` has been reporting
all along. This does not make the model better — it was always this good — it makes the reported
number true, which is the precondition for any promotion gate to mean anything.

**3. The gate could not have adopted the new label, so it had to be fixed in the same change.**
`promote_or_register()` gates on `cv_roc_auc` vs the active baseline + `PROMOTION_MARGIN`. A
`triple_barrier` candidate at 0.52 can never clear a `horizon` baseline at 0.7664 — **not on merit,
by construction**, because the two numbers grade different targets. Left alone, flipping the label
would have frozen promotion permanently and looked exactly like "accuracy is stuck".
`staleness_override_applies()` cannot break it either: that needs `age_days>=7` AND
`rejections>=10`, and a model that keeps winning on CV never accumulates rejections.

Two "the baseline's CV is not evidence" overrides added (`model_promotion.py`'s
`live_edge_verdict()` / `live_edge_is_unproven()`, deliberately the same shape as the existing
staleness valve):

- **label changed** — CV is only comparable within one target, so the CV bar is not applied.
- **live edge unproven** — the incumbent's own realized forward reading in `factor_edge_history`
  fails `|rank_IC| >= 0.03 AND hit_AUC >= 0.55`. Those thresholds are `factor_edge.py`'s own
  `_verdict()` bar, reused rather than re-picked, so this gate and this file can never disagree
  about whether something has an edge.

Conservative in three tested ways: a **never-graded** column returns "not unproven" (unmeasured is
not measured-and-bad); a reading under **20 dates** (`MIN_DATES_RELIABLE`) cannot override; and a
**NaN candidate `cv_auc` never rides either override** — with the CV comparison bypassed nothing
else would catch it, and `float(nan or 0.0)` is NaN, not 0.0 (this repo's own `float(x or 0)`
trap). The reading takes `MAX` over horizons, i.e. it is generous to the incumbent, so an override
fires only when even its best horizon fails.

**4. `mc_pricefeed_daily` wired in as an as-of fallback — 14 features go from 100% NULL to real.**
`technical_signals`' `mc_*` copies land on roughly 1 date in 20; `mc_pricefeed_daily` carries the
same MoneyControl fields for **2,243 symbols on every trading date** (40 dates, indexed
`(symbol, date DESC)`). COALESCEd so the `ts` copy still wins where it has a value, on the same
`<= signal_date` + 7-day-floor PIT convention as the sibling `technical_signals` LATERAL, applied
to the training AND scoring queries in one edit. Measured over the 180,849 training rows:

| columns | before | after |
|---|---|---|
| `mc_del_pct_3d/5d/20d`, `mc_ind_pe`, `mc_pe_vs_ind`, `mc_price_cash`, `mc_consensus_eps/pe/pb`, `mc_eps_vs_cons`, `mc_pe_fwd_discount`, `mc_circuit_dist_pct`, `mc_cagr_3y/5y/10y` — **14 cols** | **0.00%** | **41.7–76.1%** |
| `mc_ma30/50/150/200_dist_pct`, `mc_52w_high/low_dist_pct`, `mc_days_from_52wh`, `mc_vol_ratio`, `mc_3d_return`, `mc_ytd_return` — 11 cols | 87.5–92.8% | 91.4–95.7% |

⚠ **This is a coverage measurement, NOT an edge claim.** Nothing has graded the retrained model
yet, and this file's own standing findings are that a real feature is not a tradeable one. The
honest expected effect is small — see the sweep below for why.

**5. What is actually limiting cross-sectional AUC, swept rather than assumed.** Of the **421
features** in the live training matrix, **116 carry no usable stock-ranking information**:

- **36 globally constant** — one value for every stock on every date, pure dead weight. Three
  clusters, and none is a new bug: the options block (`iv_skew`, `call_wall_dist_pct`,
  `put_wall_dist_pct`, `near_expiry_gamma`, `near_call_wall`, `near_put_wall`, `nt_near_max_pain`,
  `nt_oi_x_score`, `cheap_opts_rs`, `iv_near_results`, `index_bull_gex` — options cover only ~210
  F&O names, so they vanish in a 2,200-symbol join); the analyst-revision block (`eps_rev_3m`,
  `target_rev_3m`, `analyst_chg`, `eps_rev_x_score`, `eps_rev_x_rs`, `analyst_x_score` — the
  calendar constraint this file already documents, needing ~76d of `analyst_estimates_history`);
  and `is_nifty50`/`is_nifty100`, `pledge_chg_90d`/`pledge_deleveraging`/`pledge_distress`,
  `wc_good`/`wc_bad`/`ccc_trend_norm`, `mc_cp_*`, `mc_del_acceleration`, `mc_fno_eligible`,
  `positive_turnaround`, `pead_confirmed`, `eps_miss_after_run`, `mmi_extreme_fear`.
- **28 with zero cross-sectional variance on ≥99% of dates** — `india_10y`, `usdinr_ret`,
  `nikkei_ret`, `hangseng_ret`, `fii_net_today`, `nifty_basis`, `results_season`, `mmi_norm`,
  `days_to_fno_expiry`, … These are **market-wide by design and are NOT bugs**, but AUC and
  rank-IC are purely cross-sectional, so they cannot move either metric even in principle. ~7% of
  the feature budget is spent describing the regime, not ranking stocks.
- **52 flat on 80–99% of dates** — the genuinely fixable class: `eps_ttm`/`pe_ttm`/
  `pe_pct_rank_252d`/`pb_pct_rank_252d`/`div_yield_ttm` (flat on 93.1% of dates), the `*_tl`
  Trendlyne block (`adx_tl`, `mfi_tl`, `ret_1m/3m/6m/1y_tl`, … 95.8%), and
  `roe_annual`/`roce_annual`/`ebitda_margin`/`np_margin`/`rev_growth_yoy_q`/`np_growth_yoy_q`/
  `analyst_upside_pct`/`analyst_count_log`/`analyst_buy_pct_tl` at **nunique=2, flat on 98.6%**.

**Consequence, and the useful conclusion of this pass: the ceiling is not a missing data source.**
Adding features to a matrix where 116 of 421 already cannot rank anything is not the lever — which
is consistent with this file's standing "combining/reweighting reduced performance in every case
tested" finding, and with the shared-AUC-ceiling result recorded above. Two cheap follow-ups
identified but **deliberately not built**: `mc_fno_eligible` is now derivable from
`mc_pricefeed_daily.fno_lot_size > 0`, and `mc_del_acceleration` from the newly-populated
`del_pct_3d`/`del_pct_20d` — the second was skipped because deriving it here with a formula that
might disagree with the fetcher's own definition trades a dead feature for a silent inconsistency.

**No `factor_backtest.py` run applies to this diff, and that is not an omission** — it measures
price-panel factor edge and has no code path reading `ml_ensemble`'s label, `technical_signals`'
ML columns, or `model_registry`, so it would measure something unconnected (the "evidence-shaped
but meaningless artifact" `recurring-bugs.md` warns about). The applicable measurements are the
four tables above, all from live production. **The real verification is still pending and is a
calendar constraint:** the retrained model has to be promoted, score live, and then be re-graded
via `factor_edge.py` against `technical_signals.win_probability` once ~20 fresh dates accumulate
(roughly late September 2026). Until then the honest status is: **the reported number is now
trustworthy, and the model's quality is unchanged.**

### Decomposing the blend on IDENTICAL rows — 2026-08-21, underpowered, one real blocker found

Follow-up to the "highest-value next step" the shared-ceiling section below flags: what does the
non-linear assembly do to inputs that individually aren't zero. Measured, not argued, on
`unified_recommendations_history` pre-market snapshots only (`EXTRACT(hour FROM generated_at) <
3.75`, earliest run per `(symbol, date)` — the most conservative entry), reusing `factor_edge.py`'s
own `_forward_returns`/`_metrics`/`_verdict` and `unified_ranker.py`'s own `_normalize_to_100`/
`_blend`/`REGIME_WEIGHTS` rather than reimplementing either. 17,150 rows / 2,248 symbols / 8 dates;
15,081 matched to forward prices.

| score (same rows) | h=1 rank IC | h=1 AUC | dates | h=5 rank IC | dates |
|---|---|---|---|---|---|
| `confluence_score` | **+0.0365** | 0.527 | 6 | **+0.1245** | 2 |
| `technical_score` | +0.0051 | 0.501 | 6 | +0.0473 | 2 |
| `ml_score` | −0.0040 | 0.488 | 6 | +0.0376 | 2 |
| `screener_stock_score` | +0.0131 | 0.507 | 6 | +0.0174 | 2 |
| `breakout_score` | −0.0003 | 0.515 | 6 | +0.0258 | 2 |
| `cs_score` | −0.0135 | 0.508 | 6 | +0.0135 | 2 |
| `smart_money_score` | −0.0021 | 0.496 | 6 | −0.0509 | 2 |
| reconstructed 7-engine blend | +0.0180 | 0.515 | 6 | +0.0818 | 2 |
| **stored `unified_score`** | **+0.0127** | 0.507 | 6 | **+0.0294** | 2 |

**Read the power before the point estimates: h=5 has only TWO dates and must not be quoted.**
Everything below rests on h=1's 6 dates, which is itself well under this file's own 20-date bar.

**The one result that clears a real test: `confluence_score`'s per-date rank IC is POSITIVE on
6 of 6 dates** (+0.0184, +0.0290, +0.0534, +0.0866, +0.0118, +0.0199) — sign test p=0.016, and it
is the single strongest component at both horizons. It also beat `unified_score` on 5 of those 6
dates (p=0.11, not significant). Consistent in direction with the confluence composite's existing
entry below (+0.019/+0.056/+0.067 at 1/5/21d).

**The blend-vs-unified delta did NOT reproduce as a real effect and is explicitly NOT claimed.**
Mean IC looks damning (+0.0818 → +0.0294 at h=5), but per-date the reconstructed blend beat
`unified_score` on only **3 of 6** dates at h=1 (sign test p=0.66). The mean-IC gap is carried by
two dates, not by a consistent mechanism. The multiplier stack's own rank IC vs forward return is
**+0.0017** at h=1 — i.e. it carries essentially no return information — which is *consistent* with
the "variance injected into the ranking" hypothesis but does not establish it at this sample size.

⚠ **The reconstruction is a 7-engine blend against a live 8-engine one, and that is a real
blocker, not a caveat to wave through: `unified_recommendations_history` does not store
`dl_score`.** `unified_recommendations` has all 9 score columns; its append-only history twin has
8 (no `dl_score`, plus a `fundamental_score` that is not an engine). `dl` carries 0.137 weight in
HIGH_VOL and 0.093 in SIDEWAYS, so omitting it changes `_blend`'s renormalization — which is why
the implied multiplier `unified_score / reconstructed_blend` has **p90 = 1.287 and p95 = 1.618**
when every multiplier in `unified_ranker.py` is ≤ 1.0 (`quality_gate` ≤1, `RED_FLAG_VETO_MULT`
0.5, `HIGH_VOL_VETO_MULT` 0.7, `FACTOR_CROWDING_DISCOUNT` 0.9). A ratio above 1 is arithmetically
impossible for the real multiplier stack and is proof the reconstruction is incomplete, not
evidence about the ranker. **Consequence: the ranker's own append-only audit table cannot
reconstruct the ranker's own blend.** Until `dl_score` is added to
`unified_recommendations_history`, this decomposition cannot be done cleanly by anyone, at any
sample size — fix that before re-running this, and treat the delta numbers above as
unattributable in the meantime.

**Nothing was changed in any scoring path on the strength of this** — no weight, threshold,
classification or veto was touched, so no `factor_backtest.py` run applies (same reasoning as the
`_log_recommendations`/`seed_screener_catalog` entries above). Re-run once `dl_score` is captured
and ~20 pre-market dates have accumulated (roughly mid-September 2026 on the current cadence).

### The shared-ceiling pattern, tested rather than argued — 2026-08-20

The paragraph above raised two live hypotheses (shared calendar confound vs. a real market-
efficiency ceiling) without settling either. Tested both directly, plus a third that wasn't yet
considered, live production 2026-08-20T12:5x IST.

**H1 — are the 5 engines actually independent, or 5 restatements of the same underlying
technical signal?** If redundant, their agreement is unsurprising (correlated tests of a null
look correlated). Pulled all 5 raw scores onto shared `(symbol, date)` rows (58,363 rows / 36
dates with all 5 present) and computed Spearman correlation between every pair:

| pair | rho |
|---|---|
| `win_probability` vs `cs_score` | +0.004 |
| `win_probability` vs `signal_score` | −0.128 |
| `win_probability` vs `prob_up_5d` | +0.244 (the strongest pair in the matrix) |
| `win_probability` vs `ml_breakout_probability` | +0.060 |
| `cs_score` vs `signal_score` | −0.022 |
| `cs_score` vs `ml_breakout_probability` | +0.014 |
| `signal_score` vs `ml_breakout_probability` | +0.142 |

**H1 is refuted, and refuted in the direction that makes the original finding STRONGER, not
weaker.** True redundancy would show rho well above 0.5; instead every pair is near zero, one
pair is weakly negative, and the strongest link (`win_probability`↔`prob_up_5d`, two of the most
architecturally different engines here — a gradient-boosted ensemble and a BiLSTM) is still only
+0.244. These are five genuinely independent attempts at the same prediction problem, not one
signal counted five times.

**H2 — was the ~3-month measurement window (2026-05-16→08-20) an unusually low-dispersion,
rangebound stretch that would mechanically cap every model's AUC regardless of true skill?**
Computed daily cross-sectional std of 1d returns across the liquid universe, measurement window
vs. the prior 16 months (2025-01-01→2026-05-15, `is_suspect`-excluded):

- Measurement window: mean **3.284%**, median 2.551% (n=69 trading days)
- Prior 16 months: mean **2.957%**, median 2.481% (n=340 trading days)
- Ratio: **1.111** — the measurement window had MORE cross-sectional dispersion than the prior
  16 months, not less.

**H2 is refuted.** If anything there was more signal to find during this window than usual, not
less — a low-dispersion-window explanation would need the ratio well below 1, and it's above.

**H3 — is the observed AUC (~0.51–0.55) mechanically what a Spearman IC of ~0.05–0.10 always
looks like through a binary-classification lens, or is something in the live data suppressing
AUC specifically, beyond what the IC alone implies?** Simulated paired (score, forward-return)
data via a Gaussian copula at each engine's measured Spearman IC and matched sample size, built
the same `xs_N > 0` binary label `factor_edge.py`'s `_metrics()` uses, and compared simulated AUC
to what was actually measured:

| engine (horizon) | measured IC | measured AUC | simulated AUC (mean, 5–95% range) |
|---|---|---|---|
| `win_probability` (1d) | 0.044 | 0.492 | 0.521 [0.514, 0.527] — **measured below range** |
| `win_probability` (5d) | 0.077 | 0.513 | 0.537 [0.530, 0.544] — **measured below range** |
| `win_probability` (21d) | 0.103 | 0.537 | 0.549 [0.542, 0.557] — within range |
| `cs_score` (5d) | 0.062 | 0.512 | 0.530 [0.524, 0.536] — **measured below range** |
| `ml_breakout_probability` (native h7) | 0.082 | 0.553 | 0.539 [0.532, 0.546] — within range |
| `prob_up_5d` (native 5d) | 0.047 | 0.518 | 0.522 [0.516, 0.529] — within range |
| `confluence_non_screener` (21d) | 0.067 | 0.543 | 0.532 [0.526, 0.539] — within range |

**H3 is mostly confirmed, with one real secondary finding.** For 4 of 7 reads (all the 21d/native
non-1d/5d horizons), the measured AUC is exactly what a Gaussian-copula relationship predicts
given that IC — **not a separate phenomenon at all.** A Spearman IC of 0.05–0.10 mechanically
caps AUC around 0.52–0.55 for data this size; that ceiling is a property of the correlation
magnitude itself, not a fixable measurement artifact, and no amount of tuning the AUC threshold
or classification approach changes it — the fix would have to raise the IC itself (need roughly
IC ≥ 0.15 before AUC durably clears 0.55–0.57 at this sample size). **The 3 reads that undershoot
even the idealized simulation are all the SHORT-horizon ones (`win_probability` 1d/5d, `cs_score`
5d)** — consistent with real short-horizon Indian-equity returns being more fat-tailed/skewed
than a Gaussian copula assumes, making binary classification specifically (not rank correlation)
harder at 1-5d than at 21d, where returns are closer to Gaussian by aggregation. A modest,
genuine effect, not a bug.

**The finding that actually matters most for what to do next didn't come from any of the three
hypotheses above — it came from comparing the individual engines to `unified_score` itself.**
Each of the 5 independently-built, uncorrelated engines carries real, positive, nonzero IC
(0.044–0.103 depending on engine/horizon). `unified_score` — `unified_ranker.py`'s blend of all
of them plus more — has 5d rank IC **≈ 0.0001** (the platform's own long-standing headline
number, top of this file). **A sensible combination of several independent, weakly-positive,
uncorrelated signals should show IC at least as good as its best component, typically better**
(classic ensemble variance-reduction) — instead the blended output is indistinguishable from
noise while its own ingredients individually are not. This does not contradict the existing
"reweighting reduced performance in every case tested" finding elsewhere in this file — that
finding is about adjusting the LINEAR weights, and the weights are not the only thing standing
between the components and the blend. `unified_ranker.py` layers multiple non-linear steps on
top of the linear weighted sum before `unified_score` is finalized — the crowding-discount
multiplier (`factor_crowding_multiplier`, fired on 98.6% of the universe when `mf_*` inputs went
constant, per `recurring-bugs.md`), regime-conditional multipliers, and veto/override logic
(the reverted "Smart Money Override" that bypassed the `high_vol` veto, also in `recurring-bugs.md`)
are exactly the kind of machinery that can take several individually-real weak signals and wash
them out to zero without any single linear weight being wrong. **This is the next concrete
research question this analysis surfaces**: not "do we need a better model" (five independent,
real, if weak, ones already exist) but "what is the non-linear assembly logic between the
component engines and `unified_score` doing to a set of inputs that individually aren't zero."
Tracing that is a scoped, debuggable engineering question, not a market-efficiency dead end —
not attempted in this pass; flagged here as the highest-value next step.

### `screener`'s weight traced and shrunk 2026-08-20 — root cause of most of the gap, not all of it

Traced the "highest-value next step" above rather than leaving it flagged. Read `unified_ranker.py`'s
actual blend end to end: `REGIME_WEIGHTS` gives `screener` 0.20-0.40 in every regime — the single
HEAVIEST-weighted engine of all 8, always. Two decisive tests, live production, same session:

1. **A natural experiment already built into the schema.** `confluence_signals.confluence_score`
   (raw, still used by the standalone Confluence page/`intraday_ranker.py`) is `screenerComponent
   (0-60) + trend(0-15) + volume(0-10) + sector(0-8) + fundamental(0-12)` — the SAME four
   non-screener sub-scores already graded above (the "confluence_non_screener" row), PLUS the
   screener component `_get_confluence_scores` deliberately strips out. Grading the raw,
   screener-included version against the stripped version, same construction, same dates:
   screener-included is worse at every horizon (1d +0.019→+0.012, 5d +0.056→+0.040, 21d
   +0.067→+0.044 rank IC) — direct, controlled evidence the screener component is actively
   harmful, not just redundant, corroborating the existing "screener bullish consensus IC
   -0.027, t=-2.36" finding from a completely different construction.
2. **A from-scratch reconstruction of the linear blend itself.** Replicated `_normalize_to_100`
   (percentile rank) and `_blend` (per-symbol renormalization over present engines) exactly,
   using the 6 historically-reconstructable engines (`ml`/`cs`/`confluence`/`technical`/`dl`/
   `breakout`, screener and smart_money excluded — no historical reconstruction available for
   either) at BULL regime weights: **IC +0.037/+0.081/+0.100 at 1d/5d/21d, AUC up to 0.555 —
   clears `USABLE` at 21d.** Dramatically higher than `unified_score`'s own live headline number
   (5d rank IC ~=0.0001). This is what proved the components genuinely combine into something
   real, and motivated tracing screener's weight specifically rather than concluding the blend
   can't work at all.

**Fixed**: applied this platform's own existing `ENGINE_EDGE_SHRINK = 0.5` policy (already used
by `edge_adjusted_weights`/`load_engine_edge_verdicts` for exactly this situation, just gated on
a `factor_edge_history` verdict against `unified_recommendations` that's stuck at 1 date and
can't fire yet) directly to `screener`'s weight in every regime, redistributing the freed weight
proportionally over the other 6 non-pinned engines. `breakout` deliberately excluded from the
redistribution and pinned at its exact prior value in every regime — it has its own independent,
audit-derived weight ceiling (`TestBreakoutWeightCeiling`, `scripts/check_load_bearing_
constraints.py`'s `BREAKOUT_WEIGHT_CEILING`) for an unrelated reason (momentum measured
net-negative after costs, mom21 -0.53%/5d t=-3.21), and a naive proportional scale-up would have
silently pushed it above that ceiling in all 5 regimes. New weights, per regime:

| regime | screener (was) | ml | cs | confluence | technical | dl | breakout (pinned) | smart_money |
|---|---|---|---|---|---|---|---|---|
| BULL | 0.15 (0.30) | 0.172 | 0.064 | 0.172 | 0.137 | 0.092 | 0.15 | 0.064 |
| BEAR | 0.175 (0.35) | 0.214 | 0.065 | 0.214 | 0.109 | 0.109 | 0.05 | 0.065 |
| HIGH_VOL | 0.10 (0.20) | 0.137 | 0.057 | 0.137 | 0.274 | 0.137 | 0.10 | 0.057 |
| CRASH | 0.20 (0.40) | 0.221 | 0.068 | 0.172 | 0.110 | 0.110 | 0.05 | 0.068 |
| SIDEWAYS | 0.16 (0.32) | 0.186 | 0.065 | 0.186 | 0.116 | 0.093 | 0.13 | 0.065 |

Full derivation, exact reconstruction methodology, and both test scripts (deleted after use, per
this file's convention): see `unified_ranker.py`'s `REGIME_WEIGHTS` comment block, which carries
the same citation. Negative-controlled: the one test asserting the old screener weights
(`test_regime_weights_sum_to_one`) was updated to the new values and a fixture riding a
razor's-edge score (~70.02 under the old weights, discovered because it broke under the new
ones) was strengthened to a genuinely unambiguous case rather than patched to merely pass again.
173 tests across the unified-ranker test files pass under the new weights.

**What this does NOT claim**: the reconstructed 6-engine blend (+0.037 to +0.100 IC) is still
well short of proving `screener` alone explains the full gap down to `unified_score`'s live
~0.0001 — the natural experiment showed a real but moderate drag (roughly 25-30% relative,
not annihilation), and `screener` at its full 20-40% live weight is more dominant than its ~57%
share of `confluence_score`'s internal composition, but the arithmetic wasn't carried that far.
`quality_gate`/`RED_FLAG_VETO`/`HIGH_VOL_VETO` (the latter independently validated, t=-3.00, the
platform's single most robust finding) sit downstream of the blend and were read but not
individually measured for their effect on rank-IC specifically in this pass — they're selective,
economically-defensible demotions rather than screener's broad, established-negative one, so
they were deprioritized, not ruled out. **This could not be validated retroactively** — past
`unified_recommendations` rows were generated under the old weights, so the real test is a fresh
live `unified_ranker.py` run once deployed, re-graded via `factor_edge.py` against
`unified_recommendations` the same way `win_probability`/`smart_money_score` were, once ~20+
dates have accumulated. Re-check then, and read the veto/gate layers next if the gap remains
larger than screener's traced share of it.

### `win_probability`'s "AUC never clears 0.55" finding was itself a mismatched-target artifact — 2026-08-20

Every grading of `win_probability` in this file so far — the original preliminary read, the
2026-08-20 re-measurement, and the cross-engine "shared ceiling" H3 test above — tested it
against **terminal cross-sectional excess return** (`factor_edge.py`'s standard construction).
Read `ml_ensemble.py`'s `load_training_data()` to check what it's actually trained to predict,
prompted by the same "verify the target before trusting the grade" instinct that already
corrected `breakout_classifier`/`movement_predictor`/`confluence_ml_engine` earlier today. The
default label is `so.outcome` (WIN/LOSS/STOP_LOSS) filtered to `signal_source = 'technical'` —
checked live, **100% of that slice is `label_definition = 'path_barrier'`**, the path-based
max-favorable-excursion rule this file's own panel-spec section already warns is structurally
different from a terminal return (see "Accuracy comes from realized returns" section: technical-
sourced path_barrier outcomes showed 88-91% win rate against confluence-sourced terminal_pct2's
41-44%, same calendar window). `win_probability` was never trained to predict a terminal h-day
return — grading it that way is the identical native-target mismatch already found and fixed for
three other engines today.

Re-graded against its own real training label — joining `technical_signals.win_probability` to
`signal_outcomes.outcome` (`signal_source='technical'`, `label_definition='path_barrier'`,
decisive WIN/LOSS only, same exclusion convention this file already applies), live production:

| horizon | rank_IC (vs own label) | hit_AUC (vs own label) | n | dates | win rate overall | win rate top-decile-by-score |
|---|---|---|---|---|---|---|
| 1d | 0.120 | **0.617** | 10,145 | 60 | 39.5% | 55.9% |
| 5d | 0.107 | **0.600** | 15,568 | 63 | 75.1% | 69.2% |
| 15d | 0.106 | 0.552 | 19,715 | 60 | 87.9% | 89.7% |

**1d and 5d both clear `USABLE` cleanly** (needs `|IC|>=0.03` AND `AUC>=0.55`) — a materially
different result than every prior reading of this column, and the strongest classification power
measured for any engine in this file. AUC is class-balance-invariant in principle, so this is a
real, meaningful discriminative signal against what the model actually learned, not an artifact
of the label's own skewed base rate.

**Read this precisely — it does NOT reverse the "don't trade `win_probability`" verdict, and one
number in the table above is a genuine caveat, not just color.** Three things:

1. **The h=5d top-decile win rate (69.2%) is LOWER than the overall win rate (75.1%).** A
   genuinely well-behaved predictor should show top-decile-by-score win rate strictly above the
   base rate at every horizon; it does at 1d (55.9% vs 39.5%) and roughly at 15d (89.7% vs
   87.9%, barely), but inverts at 5d. Consistent with a real but non-monotonic relationship, or
   the model doing most of its work distinguishing the middle of the distribution rather than
   cleanly separating the top decile — not investigated further this pass, but it means "AUC
   0.60 at 5d" should not be read as "top-scored names win 60%+ of the time," which it doesn't.
2. **`path_barrier`'s own base rate (75-88% "win" at 5d/15d) is itself inflated by the barrier
   construction**, per this file's own already-established finding on that exact label
   definition — a wide-target/tight-stop asymmetry can make "WIN" easy to achieve independent of
   real predictive skill. A genuinely unskilled score could still show positive AUC against its
   own easy-to-satisfy barrier if the barrier's resolution correlates with something the score
   also picks up (e.g. volatility) without that translating into real money.
3. **The already-completed cost/turnover-aware `factor_backtest.py` run stands, unaffected by
   this correction**, because it graded real portfolio returns net of real costs, not the
   path_barrier label: 5d/top-50/15bps, 7 periods, net excess +1.52%/period, t=+1.54 — **still
   not significant**, 83.4% one-way turnover, 12.61%/yr cost drag. This correction changes "how
   good is the model at its own question" (materially better than previously measured), not
   "does trading on it make money after costs" (still no, on the evidence that already exists).

**Net effect on this file's "shared ceiling" analysis above**: that H1/H2/H3 investigation
correctly tested whether the measured terminal-return AUC/IC pairs were internally consistent
with each other and with a Gaussian-copula relationship — that finding stands on its own terms
(it was explicitly about the terminal-return readings). What changes is the standing
characterization of `win_probability` specifically as "AUC ceiling 0.537, never above" — it can
clear 0.55+ against the right target, and this repo's own dominant failure mode (grade first,
question the label second) applied to its own flagship model exactly as it did to three others
today. Same lesson, same day, fourth instance: check the native label before trusting a "no
edge"/"weak AUC" verdict on any model with its own training target, not just factors with none.

### ⚠ RETRACTION WITHDRAWN 2026-08-15 — the retraction itself was wrong. Result stands, preliminary.

**Read this whole block before citing anything here; this finding flipped twice in one session.**

The retraction below claimed two defects. **Both are false**, and the error was mine:

1. *"--score runs only weekly."* **Wrong.** `ml_ensemble.py --score` is not the only scoring path.
   `queues.ts:1037` runs `T.run('ml-ensemble-score', () => pythonApi.scorePending())` **daily**
   inside ml-daily-ops — an HTTP call to the ml-api service, which is why a grep for `--score`
   missed it. `python_api.py`'s handler is `ml_ensemble.run(do_train=False, do_score=True)`.
   Confirmed in data: `unscored = 0` on every recent date (08-10 … 08-14); a weekly cadence would
   leave a visible backlog. `dataQualityChecks.ts:653` already documented this in a comment —
   *"win_probability is written by ml-ensemble-score … which runs once in the evening, AFTER
   technical-scan has written that day's rows (8:30am-4pm IST)"* — i.e. the answer was written
   down in this repo and I concluded the opposite without reading it.
2. *"Train-on-test leakage."* **Wrong for the live path.** The daily scorer passes
   `do_train=False`; it scores with the pickled model from the *previous* weekly retrain, which
   predates the rows being scored. The weekly `--train --tune --score` does train-then-score, but
   by the time it runs, daily scoring has already filled those rows, so its `WHERE
   win_probability IS NULL` matches ~nothing. Not a live leakage path.

**So the numbers stand** — raw h=1d rank IC **+0.0364, t=+2.58** (41 dates), h=5d +0.0763,
t=+3.58; top-decile excess +0.183%/day; the day's 10 biggest gainers at mean percentile 0.550.
Rows are written the evening of date *d*, so they are knowable before *d+1*'s open, and the
next-open entry used in the grading is legitimate.

**The caveats that remain genuinely valid, unchanged:**
- **IC is not a tradeable edge.** No cost or turnover analysis was run. `delivery_pct` in the
  table above had spread t=+7.82 and was still **dead** long-only net of costs.
- **h=5 windows overlap** across consecutive dates, so those observations are autocorrelated and
  t=+3.58 is optimistic. **h=1 (t=+2.58) is the honest read.**
- **41 dates is thin**, and `win_probability` history only starts 2026-05-16.

**Provenance is now measured rather than inferred.** Migration `1787050000000` added
`win_probability_scored_at`, stamped by the scorer itself, and check `win-probability-scored-in-time`
watches the lag. From the next daily run the real cadence is a number in the data instead of
something reconstructed from the scheduler — which is what should have settled this the first time.
**Note:** the 1.41d lag observed on 2026-08-15 is an artifact of a manual test write, NOT the real
cadence; expect ~0.2-0.5d once the daily scorer stamps a full batch.

### (superseded — the retraction that was itself wrong, kept for the record)

**The provenance trace that the entry below listed as its own #2 caveat was carried out
2026-08-15 and it invalidates the result.** Two independent, structural defects, either one
sufficient on its own:

1. **The value does not exist at the entry time it was graded against.** `ml_ensemble.py --score`
   appears in exactly ONE scheduled place (`queues.ts:1290`), inside the **weekly** retrain job
   (`--train --tune --score`, "weekly retrain continues"). It scores `WHERE ts.win_probability IS
   NULL`, i.e. the whole backlog since the last weekly run. So a Monday row's `win_probability` is
   typically written the FOLLOWING weekend — days after the Tuesday open the grading used as its
   entry. Nobody could have traded on it. `technical_signals.created_at`/`updated_at` are 100%
   NULL (dead columns), which is why this had to be traced through the scheduler rather than read
   off the row; `computed_at` (100% populated) records only when the row was CREATED, a lower
   bound, and it correctly shows same-day creation — which is what made the setup *look* clean.
2. **Train-on-test leakage.** In the same invocation `run()` executes `if do_train:` first —
   `load_training_data()` pulls every resolved `signal_outcomes` row with no cutoff excluding the
   week about to be scored — and only then scores that week's rows. **The model is fitted on the
   outcomes of the very rows it subsequently scores.** A positive IC is the expected artifact.

**Retracted numbers** (raw h=1d IC +0.0364 t=+2.58; h=5d +0.0763 t=+3.58; calibrated +0.0472 /
+0.1007; top-decile excess +0.183%/day; gainers at percentile 0.550). Grading the raw column
separately did rule out *calibration* leakage specifically — but not this, which sits upstream of
both columns and contaminates raw and calibrated alike. **`unified_score`'s IC ≈ 0.0001 remains
this platform's honest headline; nothing has displaced it.**

**Separate, real finding worth keeping — `win_probability` is not fit to be a live signal as
currently produced.** It feeds `scoring_engine`'s Factor 3 (`ml_alignment_points`, 0-20 pts, ~18/20
mean) and the 0.55/0.40/0.30 bands, yet it is (i) written only weekly, so it is stale by up to
~5 trading days for most rows, and (ii) produced by a train-then-score-in-one-invocation job, so
it can never be graded as a forward signal without first separating those steps. Fixing it means
scoring on a daily cadence with a model trained strictly on data preceding each scored date —
until then, no measurement of this column can be trusted, in either direction.

### (superseded, kept for the record) PRELIMINARY — `win_probability` grades POSITIVE

Graded 2026-08-15 against realized returns, full panel spec (per-date then averaged, winsorised
1/99 on observed values, `is_suspect` excluded, ≥₹1cr ADT20, **next-day OPEN entry**):

| column | h=1d rank IC | h=5d rank IC |
|---|---|---|
| **raw `win_probability`** (model output, never fitted on outcomes) | **+0.0364, t=+2.58** (41 dates) | **+0.0763, t=+3.58** (38 dates) |
| `calibrated_win_probability` (isotonic fit ON realized outcomes) | +0.0472, t=+3.41 (36) | +0.1007, t=+4.15 (33) |

Top-decile-by-`win_probability` excess vs the day's own universe: **+0.183%/day (t=+2.56)** at
h=1, **+0.886%/period (t=+3.24)** at h=5. The day's 10 biggest real gainers sat at a mean
`win_probability` percentile of **0.550** vs 0.500 for chance.

**Leakage was tested for, not assumed.** `calibrated_win_probability` is produced by
`ml_calibration.py` fitting isotonic on realized `signal_outcomes` — i.e. potentially on the very
outcomes being graded. Grading the **raw** column separately isolates that: raw is independently
positive, so this is **not purely a leakage artifact**. That calibrated is consistently stronger
than raw is nonetheless consistent with *some* leakage in the calibrated column, and it should not
be quoted as the headline number.

**Why this does NOT contradict this file's "no edge" headline:** that verdict is about
`unified_score` (5d rank IC ≈ 0.0001, t=0.02) and the 26 `FACTORS`. `win_probability` is a
different, previously-ungraded column — the LGBM ensemble's own output. This is new information,
not a reversal.

**Four reasons this is NOT yet a tradeable edge, and must not be treated as one:**
1. **IC is not edge, and this platform has been burned by exactly that.** See `delivery_pct` in
   the table above: quintile spread t=+7.82, yet **dead** as a long-only factor net of costs
   (−1.04%/period at 21d/25bps). Nothing here is cost- or turnover-aware. A real
   `factor_backtest.py`-style net-of-cost run is required before any claim of tradeability.
2. **Provenance is unverified.** It is assumed, not proven, that a date-`d` `win_probability` is
   written before `d+1`'s open. `ml_ensemble --score` only fills `WHERE win_probability IS NULL`
   (so it does not rewrite history), but the write *timing* was not traced. This repo has already
   had one confident, wrong result from exactly this class (`signal_generated_at`, t=−3.44 → −1.28
   once re-anchored) — treat the provenance filter as unchecked until someone traces it.
3. **h=5 windows overlap** on consecutive dates, so those 38 observations are autocorrelated and
   the t-stat is optimistic. h=1 (t=+2.58 raw) is the cleaner read.
4. **Only 41 dates** (`win_probability` history starts 2026-05-16). Thin, and the same span that
   this file elsewhere calls insufficient for a verdict.

**Next step, in order:** trace write-timing provenance → re-run h=1 only, non-overlapping →
cost/turnover-aware portfolio run. If it survives all three, it is the first genuinely positive
signal measured on this platform and belongs in the "already tested" table with a real entry.
Until then it stays here, flagged preliminary.

## The 7 permanently-NULL `technical_signals` columns are NOT broken writers (checked 2026-08-16)

A NULL-column sweep of `technical_signals` flagged 15 columns as fully NULL on the last
completed trading day. **That count was itself mostly an artifact, and the residue is not what
it looked like** — the same false-positive shape as the earlier "25 dead columns" that turned
out to be the wrong measurement date. Corrected breakdown, each traced individually:

- **6 are not dead at all** — `delivery_pct` (38 distinct dates of history), `iv_hv_ratio` (51),
  `days_to_next_results` (34), `sector_global_corr_21d` (10), `sector_benchmark` (3),
  `delivery_trend_30d` (2). All last populated `2026-08-13` against a max grid date of
  `2026-08-14`: they are **enrichment columns that lag the scan by a day**. Judging them on
  `max(date)` reads a one-day lag as death. Use "distinct dates ever populated", not "NULL
  today".
- **2 are deliberate** — `flyer_probability` and `pead_score` are model outputs in
  `densify_feature_matrix.NEVER_FILL`, pinned by `test_generated_at_and_never_fill.py`. NULL on
  a day their producer did not run is the intended behaviour, not a gap.
- **7 have never been written once, and NONE of them is a bug to fix:**

| column | why it is empty | evidence |
|---|---|---|
| `fcf_yield` | **superseded**, by design | `financial_ratios_fetcher.py`'s own comment marks it a pre-"Task 11" original replaced by `fcf_yield_approx` — which is live at 1,441/2,192 rows |
| `created_at` | dead provenance column | 0 rows in all history; `computed_at` is the real stamp |
| `eps_revision_3m_pct` | **calendar** | needs a snapshot ~90d back (±14d), so ≥76d of depth; `analyst_estimates_history` spans **50 days** (16 dates, 2026-06-21→08-10) |
| `target_revision_3m_pct` | **calendar** | same source, same constraint |
| `analyst_count_chg` | **calendar** | same; ran live — `0 symbols updated, 2337 skipped (2337 insufficient history)` |
| `pledge_chg_90d` | **calendar** | ran live — wrote 2,230 snapshots then `pledge_chg_90d for 0 symbols`; needs 90d of its own snapshot history |
| `ccc_trend` | **arithmetically impossible today** | it is a year-over-year CCC delta, and `working_capital_history` holds **one fiscal year per symbol — 0 of 1,675 symbols have 2+** |

**All three producers are scheduled and all three run clean** (`analyst_revision.py`
queues.ts:841, `fundamentals_snapshot.py` queues.ts:576, `working_capital_fetcher.py` /
`financial_ratios_fetcher.py` in the weekly batch). Nothing is silently failing; five of the
seven are waiting on elapsed time or an upstream backfill, and two are dead by design.

**Do not "fix" these, and do not re-audit them as dead columns.** The two genuinely actionable
follow-ups, neither of which is a code change: a deeper `analyst_estimates_history` backfill (or
~4 more weeks of accumulation) unblocks the three analyst columns around 2026-09-05, and a
second fiscal year in `working_capital_history` unblocks `ccc_trend`. `fcf_yield` and
`created_at` are droppable whenever someone wants the schema tidy.

### `build_features()`'s pandas fragmentation fix (2026-08-22) is NOT a scoring change — no `factor_backtest.py` run applies

`ml_ensemble.py`'s `build_features()` assigns 400+ columns one at a time (`X['col'] = expr`),
which trips pandas' `PerformanceWarning: DataFrame is highly fragmented` past its internal
~100-block threshold — 612 distinct source lines, ~16,500 total warning instances across a full
pytest run, purely from this one function (called from training, two scoring/backtest paths, and
`incremental_update`). Found while investigating why a routine pytest run's output looked
alarming (16k+ warning lines read, at a glance, like mass failure — it wasn't; 0 tests failed).

Fixed by inserting `X = X.copy()` at 5 points spread across the function's ~50 section
boundaries. `.copy()` is a pure identity operation — it duplicates the DataFrame's data
byte-for-byte into freshly consolidated memory blocks, changing zero values — and its only
effect is resetting pandas' block-fragmentation counter before the next stretch of assignments
re-triggers the warning. **No feature's computed value changes, no column is added or removed,
no weight/threshold/formula is touched.**

**`factor_backtest.py` was deliberately NOT run, same reasoning as this file's
`_log_recommendations`/`seed_screener_catalog`/`_next_generated_at` entries**: it measures
price-panel factor edge and has no code path sensitive to `build_features()`'s internal memory
layout. The applicable verification is a direct one, done: `test_ml_ensemble.py`,
`test_exit_policy.py`, `test_ml_ensemble_pricefeed_fallback.py`,
`test_ml_ensemble_promotion_label_and_edge.py`, `test_cs_ranker.py`,
`test_analyst_estimates_snapshot.py`, `test_fundamentals_pit.py` (all callers of
`build_features()` reachable from the test suite) — 80/80 passed, and the `PerformanceWarning`
no longer appears in any of their output. **Warning volume measured, not asserted**: a full
CI-identical run dropped from 16,526 warnings (pre-fix baseline) to 154 (post-fix) — the ~16.4k
difference is entirely `PerformanceWarning` instances this fix removes.

Full CI-identical suite re-run twice to confirm no regression, and each run told a different,
useful part of the story: the first came back `1 failed, 2125 passed` —
`test_mc_earnings_fetcher.py::TestFetchActualEstimateBeatsUsesLogicalTradingDate::test_write_targets_logical_trading_date`,
a file this change never touches. Investigated rather than dismissed: passed standalone, passed
with its whole file run alone, and passed within `src/server/tests/` run alone (1,658 tests) — a
`src/server/__tests__/`/`tests/chatbot/`-interaction-dependent flake, not reproducible in
isolation. A second full run came back **`2129 passed / 232 skipped / 0 failed`** — clean,
including that exact test. Recorded honestly rather than claimed as fixed: this is a
**pre-existing, non-deterministic flake, root cause not identified**, orthogonal to this change
(3 of 4 attempts against the post-fix code were clean; the file's own logic and this diff share
no code path). Worth a dedicated look if it recurs; not this session's finding to claim.

## Not testable — do not spend time here without a genuinely new angle

- **Fundamentals, analyst, ownership and earnings factors**: every one of those tables has ~30 distinct dates, all starting 2026-06-30 (1–2 independent quarterly observations). Calendar constraint, not engineering — elapsed time or a backfill fixes it, nothing else does.
- **FnO / positioning (long/short buildup, short covering)**: no fetcher captures per-stock futures OI; `so_stock_oi_summary.fut_oi` is 100% NULL (re-confirmed live 2026-08-21: 5,649 rows, `fut_oi` populated on **0**, table otherwise fresh to 2026-08-20 — the table is being written, that column never is). ⚠ **CORRECTED 2026-08-21 — "Needs a new data source" was WRONG, and it blocked this for months. The source is already onboarded; nobody ever built the fetcher.** `src/server/urls_sample.json` (857 URLs) carries `api.moneycontrol.com/mcapi/v1/fno/futures/getFuturesData?fut=FUTSTK&id=<scId>&expirydate=<d>`, live-probed against RELIANCE (`id=RI`, near expiry resolved from the sibling `getExpDts`, which returns `{"data":{"0":{"fno_exp":"2026-08-25",...}}}` — a dict-of-dicts, not a list; parsing it as a list yields `None` and a 422). Real response, verbatim: `open_int` 79,580,500 · `oi_change` −11,349,500 · `oi_percchg` −12.48 · **`oiBuildup` "Long Unwinding"** · `rollover` 52.57 · `oi_pcr` 0.61 · `spot_price` 1316.00 vs `lastprice` 1310.00 (so basis is derivable too). That is the entire long/short-buildup family this line called impossible, plus rollover, per stock, from an endpoint already in the registry. Trendlyne carries the same family independently (`smartoptions.trendlyne.com/phoenix/api/fno/market/filter/?...screenType=long-buildup|short-buildup|oi-gainers|oi-losers`, and `trendlyne.com/futures-options/api/heatmap/.../long/price/`), so there is a cross-check available rather than a single-vendor dependency. **Still genuinely unbuilt** — this is an engineering gap now, not a data gap, and the factor remains UNMEASURED: nothing here claims edge, and `oiBuildup` is a *vendor's own* directional label, which this file's `mojo_indigraph` row already shows is worth no more than our own. Build it per `data-sources.md` (fetcher + `live_datasource` test + `TABLE_FRESHNESS_CHECKS` entry; MC's `scId` is already in `StockMapping.mcsymbol`, and note two providers issue this family independently, so any table keyed on a vendor id needs the provider in the PK), then grade it through `factor_edge.py`/`factor_backtest.py` like everything else before it is allowed near `unified_ranker.py`.
- Of 60 symbol+date tables audited 2026-08-11, only 9 have enough history to test anything at all; the other 35 start ~2026-06-30.
