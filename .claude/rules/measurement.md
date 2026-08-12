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

`unified_score` 5d rank IC ≈ 0.0001 (t=0.02). Short-horizon momentum is negative at three horizons. Bullish screener consensus is significantly negative (t=−2.36), and screener sentiment labels are themselves inverted (bullish minus bearish = −0.11pp, t=−4.61) because they're keyword-classified off the screener name, never validated against an outcome. `insider_net`, `delivery_spike`, `ticket_size` are null-to-negative. No individual screener (0 of 552 tested) survives FDR or Bonferroni. The common bullish setups (Gap Up ≥2%, breakout>20d-high, volume shocker) are inverted at 1-day; Gap Down ≤−2% is the one significantly positive setup. Sector-neutralising a factor destroys its edge here (opposite of the published US result) — see the "already tested" table. FnO/positioning factors (long/short buildup) cannot be reconstructed at all — no fetcher on this platform captures per-stock futures OI.

**Consequence: reweighting the existing engines is not a fix.** There is no incumbent factor to beat — see the banner above. Combining reduced performance in every case tested (12-1 alone +0.86% vs +2 exclusions −1.25%; long-only +0.86% vs long/short +0.49%; the 8-engine blend at IC 0.0001).

## Already tested — do not re-run without a reason

Each of these was measured on the 5-year price panel with the spec above. Re-testing them costs days and returns the same answer. If you think one deserves another look, state what changed (more history, a different horizon, a different construction) before spending the time. Full derivation for any row: `docs/measurement-history.md`.

| Factor | Result | Verdict |
|---|---|---|
| `momentum_12_1` | +0.53%/mo, t=1.10 (post-fix) | not significant |
| `value_book_to_price` | +0.78%/mo, t=1.99 (post-fix) | not significant; vendor history may be retrospectively restated |
| `insider_net` | +0.48%/mo, t=+2.05 | only positive & significant factor; fails 26-factor Bonferroni |
| `momentum_21d` / `63d` / `reversal_21d` | negative, t up to −3.96 | dead |
| `high_vol` / `low_vol` | both negative (−1.21, −1.66) | **both tails lose**; the middle outperforms |
| `delivery_spike` / `delivery_trend` | t=−1.08 / −1.43 | dead |
| **`delivery_pct` (raw level, NOT the derived spike/trend above)** | quintile spread +0.19pp/day, t=+7.82 — but **long-only top-50 net excess −1.04%/period at 21d/25bps and −0.15%/period at 5d/15bps, t=−1.48 both** | **dead as a long-only factor** despite a real directional signal in the spread |
| `ticket_size` (institutional proxy) | −0.67%, t=−2.36 | significantly **inverted** |
| `smart_money` (`unified_ranker.py`'s live insider+block-deal input, flat 0.05 weight) | **never backtested for edge magnitude** — its own code comment says so | **unmeasured, not proven** — the closest measured analogue, `ticket_size`, is significantly inverted (row above); a 2026-08-12 incoming commit fabricated a "Sharpe 1.38 / 64.5% win rate" backtest for a "Smart Money Veto" concept that does not exist in the live ranker and was deleted, not evidence of anything |
| screener bullish consensus | IC −0.027, t=−2.36 | significantly negative; cleaning the labels made it *more* negative |
| **every individual screener** (1,563, one at a time) | **0 survive FDR or Bonferroni** | population direction is negative, sentiment labels inverted |
| news sentiment | same-day +0.13 IC, next-day −0.03 | real but not tradeable — the move is over by the first entry you can take |
| `near_52w_high`, `low_beta`, `low_idio_vol` | insignificant | US-published factors that did not transfer |
| `low_max_ret` (lottery demand) | t=−3.12 | significantly **inverted** vs the published result |
| intraday (23 days, 256 configs) | best net at 15bps = −0.004% | edge exists in sign, smaller than costs |
| **`mojo_indigraph`** (MarketsMojo's own composite bullish/bearish call) | −0.08 to −0.14%/period, t=−0.15 to −1.26 | **no edge** — a vendor's standing directional call is not better than this platform's own |
| **sector-neutral (industry-relative) value & momentum** | **every one worse than its raw parent; B/P +0.82→+0.46%/mo, t 2.08→1.12** | **rejected** — confound (smaller universe) ruled out with a registered control |

## Not testable — do not spend time here without a genuinely new angle

- **Fundamentals, analyst, ownership and earnings factors**: every one of those tables has ~30 distinct dates, all starting 2026-06-30 (1–2 independent quarterly observations). Calendar constraint, not engineering — elapsed time or a backfill fixes it, nothing else does.
- **FnO / positioning (long/short buildup, short covering)**: no fetcher captures per-stock futures OI; `so_stock_oi_summary.fut_oi` is 100% NULL. Needs a new data source.
- Of 60 symbol+date tables audited 2026-08-11, only 9 have enough history to test anything at all; the other 35 start ~2026-06-30.
