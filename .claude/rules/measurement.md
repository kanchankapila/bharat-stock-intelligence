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
| **`earnings_beat_yoy`/`earnings_beat_qoq`** (PEAD-style post-earnings drift, `earnings_category_yoy`/`_qoq` from `mc_earnings_fetcher.py`'s `_backfill_rapid_features`, BP=+2/PT=+1/LR=0/WP=-1/NT=-2, wired into `factor_backtest.py` 2026-08-13) | 21d rebalance: **0 completed periods** — no result, insufficient runway. 5d/top-50/15bps (the shortest feasible horizon): 3 periods (0.06 years), net excess −0.78%/period, t=−1.79. | **NOT significant, and severely underpowered** — 3 periods is worse than `screener_breadth`'s already-flagged-as-low-power 9. Calendar-constrained: `earnings_category_yoy` has only 19 trading days of real depth (2026-07-20→2026-08-13) — the column is a recent addition, not deep history. Re-test only once it has ~12+ months, same bar as `screener_breadth`. **Separately: `pead_model.py`'s own `compute_pead_score()` is unusable regardless of history depth** — its two required inputs (`eps_growth_yoy`/`eps_growth_qoq`) are ~100% NULL across the entire panel (measured live: populated on 0 symbols except the 2 most recent dates), dead schema, same shape as `feature_store`'s `rev_growth`/`eps_growth` pair above. `earnings_category_yoy`/`_qoq` are the only genuinely-populated earnings-surprise columns on this panel, which is why they're what got tested instead. |
| **`screener_combo_finder.py --tier1`'s "capitulation" triple (`gap_down` AND `open_eq_low` AND `top_loser`, next-session open→close, single day, not a rebalanced hold)** | Reviewed 2026-08-13 (`/measurement-integrity-review`): reproduced live, 425 days / 651 signal-rows, spread +0.53%/day net of 15bps, t=+3.61, p=0.0003, clears the 41-combination Bonferroni bar. **Robust**: winsorizing at 1/2/5% *strengthens* it (t 3.69–3.94); dropping the single most extreme day still gives t=3.49; dropping the top 3 most extreme days still gives t=3.25, p=0.0013. **6/6 years positive** (2021–2026), 3 of 6 individually significant. | **Not a contradiction of the `gap_down`/`gap_up` rows above** — different construct entirely: those rank/hold the top-K gapped names for a 21d rebalance and eat turnover-drag costs; this is a same-next-session open→close return on a much narrower, rarer AND'd condition (real capitulation — gapped down, opened at the low, AND already among the day's biggest losers — not just "gapped down"). Reads as a genuine short-horizon reversal/bounce off a panic day, not a continuation trade. **Two real gaps found, neither changes the verdict**: (1) the script has no winsorization step despite the panel spec requiring one — checked live, doesn't matter here, but should still be added for consistency; (2) `run_tier1`'s verdict logic (`is_edge = spread_pct > 0`) only ever surfaces the best *positive*-direction combo — the single most significant combo in the full 41-row table is actually negative-direction (`gap_down,open_eq_high`, t=−4.12, spread=−0.53%, stronger than the "winning" positive one), which the console output/verdict never highlights. Low signal density (~1.5 signals/day when it fires, ~651 stock-days across 5.5y) means this is thin — narrow enough to watch, not yet enough to call it capacity-proven at scale. `live_capitulation_screener.py`'s docstring says "See measurement.md" — this row is that entry. **Re-confirmed 2026-08-20** (`screener_combo_finder.py --tier1` re-run live, production-grade-hardening §4): 430 days / 658 signal-rows (5 more days accumulated since the 2026-08-13 read), spread +0.5064%/day net of 0.15% round-trip cost, t=+3.48, p=0.0005 — same combo still wins, magnitude and significance essentially unchanged (t 3.61→3.48), and the negative-direction `gap_down,open_eq_high` combo the earlier review flagged as unhighlighted-but-stronger is *still* the single most significant row in the table (t=−4.05 this run, vs −4.12 previously). Cost accounting for this construct was already adequate at first measurement — it's a single next-session open→close round-trip, not a multi-period rebalance, so `gap_down`/`gap_up`'s turnover-drag concern (which is about *holding* a rebalanced position) doesn't apply the same way here; re-running under the exact same harness with a few more weeks of data was the right bar to clear, and it cleared it. **Not yet done**: a per-year breakdown to reconfirm "6/6 years positive" (the fresh run doesn't emit that split) and explicit capacity/liquidity sizing beyond the ≥₹5cr ADTV floor already applied. |

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
finding above, except here the disqualifier is classification power rather than cost. **Not yet
done**: the full cost/turnover-aware portfolio run this section's third step calls for — this
result argues it may not be worth the effort (a signal this weak on AUC is unlikely to survive
25bps costs even if IC is real), but that is an inference, not a measurement, and should not be
quoted as if the portfolio run happened. Re-check via the historical saga below only if trying to
understand *why* the write-timing/provenance question needed resolving before this could be
trusted at all.

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

## Not testable — do not spend time here without a genuinely new angle

- **Fundamentals, analyst, ownership and earnings factors**: every one of those tables has ~30 distinct dates, all starting 2026-06-30 (1–2 independent quarterly observations). Calendar constraint, not engineering — elapsed time or a backfill fixes it, nothing else does.
- **FnO / positioning (long/short buildup, short covering)**: no fetcher captures per-stock futures OI; `so_stock_oi_summary.fut_oi` is 100% NULL. Needs a new data source.
- Of 60 symbol+date tables audited 2026-08-11, only 9 have enough history to test anything at all; the other 35 start ~2026-06-30.
