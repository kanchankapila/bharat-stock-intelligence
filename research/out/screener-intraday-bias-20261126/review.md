# Bias review of the 160 screeners that feed the intraday membership (2026-11-26)

Inputs: `screeners.csv` (stored labels), `screeners_v3.csv` (filter criteria and the 2026-11-06 proposals),
`conflicts.py` (live overlap). Web: StockCharts ChartSchool pages for RSI, CCI, Williams %R, ADX, %B and MFI.
A label says what a condition conventionally means. It is not evidence that it predicts returns, and no study of
15-minute signals on NSE net of costs was found.

## Wrong under any reading (pinned in `screener_bias_pins.py`, not yet wired)

| screener | stored | why wrong | pin |
|---|---|---|---|
| Previous Day / Month Breakout - Down (MoneyControl, ETnow) | bullish | closes below the prior low; the repo's `screener_corrections.csv` already says bearish and is overwritten | bearish |
| Price crossed below 15m/30m/1H/2H Bollinger Band | bullish | %B < 0 is the superset of "Bollinger Band Breakdown" (bearish): 39 (15m) and 25 (30m) stocks get both votes; the curated CSV says bearish | bearish |
| ADX Strong Trending Stocks (all timeframes) | bullish | ADX "is used to measure the strength or weakness of a trend, not the actual direction" | neutral |
| Overbought / Oversold on both RSI and MFI | bearish / bullish | the same RSI >= 80 and <= 20 conditions sit in oppositely labelled screeners: 64 to 84 stocks get both votes | neutral |

## Convention disputes (not changed)
- CCI crossed above 100: stored bearish; StockCharts reads it as a possible uptrend start. 2026-11-06 proposal: bullish.
- Williams %R crossed -20: stored bearish; "overbought readings are not necessarily bearish". Proposal: bullish.
- Bare overbought (MFI, CCI, Williams, RSI above 75): stored bearish; sources say not bearish alone, and the repo's
  daily 5-year test found no signal (t -0.18).
- Bare oversold (MFI, CCI, Williams): stored bullish; "oversold readings are not necessarily bullish", and the daily
  test found oversold bearish (t -4.26). "Oversold - RSI below 30" is stored bearish on that measurement although its
  vendor text says bullish. AF-20260829-11 holds the 15m CCI Oversold disagreement for the owner.
- High Relative Strength (RSI > 70), Low Volatility: stored bearish; the proposal is neutral.
- None of these is measured at 15 or 30 minute horizons.

## Looks consistent with the name (not individually web-checked)
SMA crosses, MACD crossovers, Supertrend, candlestick patterns, 52-week and breakout screens other than the two above.

## Why wrong labels survive
`screener_catalog_enricher` (name keywords; syncs `screener_master` over the catalog), `trendlyne_screener_discovery`
(substring guess over name and description), `unified_ranker.seed_screener_catalog` (CSV then corrections) and
`scoring_engine` (CSV into master) all write the label; `screener_features_fetcher.compute_features` then guesses
direction again from the name.

## What the labels affect
- The live intraday screener score is a constant 50 whatever they say, and `_classify` ignores bull/bear counts.
- `screener_momentum_score` (read by the technical engine and ML features) does use them.
- The 29 catalog rows the pins would change include no risk-red-flag category, so no veto changes.

## Not established
- Whether the 15-minute lists are refreshed during the day (`last_seen` is a date only).
- Why 53 of 70 Trendlyne screeners hold exactly 100 members while 1000 are requested (possible truncation).
- CCI and Williams criteria are stored with the field name missing ("None > 100").
