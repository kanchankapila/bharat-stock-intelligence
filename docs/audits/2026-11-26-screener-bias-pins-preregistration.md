# Screener bias pins: pre-registration (AF-20261126-11)

Written 2026-11-26 about 20:15 IST, before the replay was run. Pins: `src/server/screener_bias_pins.py`
(29 catalog rows would change; none in a risk-red-flag category).

## What is being tested
`screener_momentum_score` rebuilt with and without the pins. A pin sets the screener's sentiment AND replaces the
name-keyword guess in `compute_features` (without that, "... Breakout - Down" still counts as bullish).

## Script
`research/out/screener-intraday-bias-20261126/replay_pins.py`, run once, from the repo root, outside the barred
windows. Membership from `screener_appearances` episodes. Primary membership: the 3-day window production's
features use today (`old_arm`). Secondary, reported only: all confirmed open episodes (`new_arm`).
Dates 2026-09-01 .. 2026-11-19. Next-session open to close, ADT >= Rs 1 cr, |return| <= 40%, same symbols in
both arms, point-in-time `load_screener_meta(as_of=date)` (names, categories and labels are current ones:
hindsight, same limit as the 2026-11-21 rerun).

## Decision (AF-20261026-71 ship rule)
Ship unless the paired daily rank-IC difference (pinned minus current) has t <= -2 in either half of the dates on
the primary membership. Fewer than 20 graded dates is LOW-DATA: do not ship. Also report top-50 net of 0.32%.
"Ship" means the labels are corrected; it is not a claim of edge. No pin is added or removed after the result.

## If it ships, wire exactly this
1. `screener_features_fetcher.compute_features`: if `pinned_bias(name)`, use it for sentiment and the name signal.
2. A function that sets `screener_catalog.signal_bias` and `screener_master.inferred_sentiment` for pinned names,
   called at the end of `screener_catalog_enricher.run()` and `UnifiedRanker.seed_screener_catalog()`.
A failing test first for each of the three call sites. No manual UPDATE, no other label changes.
