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
| `smart_money` (`unified_ranker.py`'s live insider+block-deal+institutional-deal composite input, flat 0.05 weight) | **never backtested for edge magnitude** — its own code comment says so | **unmeasured, not proven** — the closest measured analogue, `ticket_size`, is significantly inverted (row above); a 2026-08-12 incoming commit fabricated a "Sharpe 1.38 / 64.5% win rate" backtest for a "Smart Money Veto" concept that does not exist in the live ranker and was deleted, not evidence of anything. **Separately, a real (non-fabricated) "Smart Money Override" DID land in the live ranker the same day (`ae3e369`)** — bypassed the significantly-negative `high_vol` veto (t=−6.09, see banner) for any symbol scoring `sm_score>=80` on this same unmeasured input, zero test coverage, zero backtest. Live exposure quantified 2026-08-12: 21 real symbols cleared the threshold via the institutional-deal-signals channel alone in the trailing 14 days. Reverted same day (`unified_ranker.py:2077`) — re-add only behind a real `factor_backtest.py` run on the bypassed cohort. |
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
| **`screener_combo_finder.py --tier1`'s "capitulation" triple (`gap_down` AND `open_eq_low` AND `top_loser`, next-session open→close, single day, not a rebalanced hold)** | Reviewed 2026-08-13 (`/measurement-integrity-review`): reproduced live, 425 days / 651 signal-rows, spread +0.53%/day net of 15bps, t=+3.61, p=0.0003, clears the 41-combination Bonferroni bar. **Robust**: winsorizing at 1/2/5% *strengthens* it (t 3.69–3.94); dropping the single most extreme day still gives t=3.49; dropping the top 3 most extreme days still gives t=3.25, p=0.0013. **6/6 years positive** (2021–2026), 3 of 6 individually significant. | **Not a contradiction of the `gap_down`/`gap_up` rows above** — different construct entirely: those rank/hold the top-K gapped names for a 21d rebalance and eat turnover-drag costs; this is a same-next-session open→close return on a much narrower, rarer AND'd condition (real capitulation — gapped down, opened at the low, AND already among the day's biggest losers — not just "gapped down"). Reads as a genuine short-horizon reversal/bounce off a panic day, not a continuation trade. **Two real gaps found, neither changes the verdict**: (1) the script has no winsorization step despite the panel spec requiring one — checked live, doesn't matter here, but should still be added for consistency; (2) `run_tier1`'s verdict logic (`is_edge = spread_pct > 0`) only ever surfaces the best *positive*-direction combo — the single most significant combo in the full 41-row table is actually negative-direction (`gap_down,open_eq_high`, t=−4.12, spread=−0.53%, stronger than the "winning" positive one), which the console output/verdict never highlights. Low signal density (~1.5 signals/day when it fires, ~651 stock-days across 5.5y) means this is thin — narrow enough to watch, not yet enough to call it capacity-proven at scale. `live_capitulation_screener.py`'s docstring says "See measurement.md" — this row is that entry. |

## Not testable — do not spend time here without a genuinely new angle

- **Fundamentals, analyst, ownership and earnings factors**: every one of those tables has ~30 distinct dates, all starting 2026-06-30 (1–2 independent quarterly observations). Calendar constraint, not engineering — elapsed time or a backfill fixes it, nothing else does.
- **FnO / positioning (long/short buildup, short covering)**: no fetcher captures per-stock futures OI; `so_stock_oi_summary.fut_oi` is 100% NULL. Needs a new data source.
- Of 60 symbol+date tables audited 2026-08-11, only 9 have enough history to test anything at all; the other 35 start ~2026-06-30.
