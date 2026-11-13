# Source deep dive: Tapetide, NSE MCP, Upstox, TEJ, and what could replace Trendlyne

2026-11-13. Companion to `SOURCE_CANDIDATES_2026-11-13.md`. Everything below was fetched live with
anonymous requests (no token, cookie, login or account). Where a route answered 401/"key required" it
was left alone and is listed as such. Owner instruction for this pass: terms and authorisation are
not a blocker for what a site serves anonymously; nothing here bypasses an access control. Terms
that exist are still recorded, because they are facts a later reader needs.

Sample sizes are small and stated; a 200 is not proof of value (see `data-sources.md`).

## 1. Tapetide: moved to the anonymous stock-page data (done, AF-20261107-09)

`api.tapetide.com/api/v1/companies/{symbol}/{score,analyst-ratings,forecasts}` now 404/401. The site's
own page data answers without credentials:

| URL form | Result (BEL, TCS, RELIANCE) |
|---|---|
| `https://tapetide.com/stocks/{SYMBOL}/__data.json` | layout + page nodes, 100-104 KB, full stock data. **Used.** |
| `...__data.json?x-sveltekit-invalidated=11` | byte-for-byte the same decoded data as plain |
| `...__data.json?x-sveltekit-invalidated=01` | layout skipped; same stock data, about 3% smaller, only the layout key `headLinkPaths` differs |
| `...__data.json?x-sveltekit-invalidated=10` | page skipped: 3.2 KB shell, no stock. Rejected by the splitter. |

`robots.txt` allows `/stocks/` (disallows only `/api/`, sets no crawl delay). Requests are paced to
about 4/s. `/company/{SYMBOL}/__data.json` redirects to `/stocks/{SYMBOL}`.

What the page carries (BEL decoded, 1,947 fields): `sections.score` (score 0-100, six pillars,
`meta.score_date`, `meta.formula_version`), `sections.analystRatings` (buy/hold/sell counts),
`sections.forecasts` (estimates, bands, actuals), `sections.technicals` (moving averages,
oscillators, pivots), `sections.peers`, `sections.quote`; plus `fundamentals`, `valuation` (PE TTM,
TTM EPS), `priceMetrics` (PE, PB, book value, 52-week range, with `price_basis`/`as_of`),
`growthSummary`, `shareholding.quarterly` (promoters, FIIs, DIIs, government, public, number of
shareholders), `promoterPledge`, `financials` (P&L, balance sheet, cash flow, 13 quarters, ratios),
`documents` (annual reports, concalls, credit ratings, LODR disclosures, results: 12 each),
`aiBullBear`, `aiNewsDigest`.

Stored today: only the three sections the old routes returned (score, ratings, forecasts), under the
old endpoint names, so the parser is unchanged. **New provenance:** `meta.score_date` is the score's
own as-of date (2026-11-12 on all three), which the old API never carried.

Not stored yet and worth a decision: shareholding history, pledge, quarterly financials, peers,
technicals, documents. They are in the same response, so storing them costs no extra request.

## 2. NSE's official MCP servers (new, free, no key)

Page: `https://www.nseindia.com/nse-mcp`. It states "Do I need an account or API key? No." and, as
terms, that the data is for information and learning, not real-time trading, advice or commercial
products. Two servers, both answered the anonymous MCP handshake (`initialize`, protocol 2025-03-26,
then `tools/list`) over streamable HTTP:

| Server | URL | Tools | Data |
|---|---|---|---|
| nse-bhavcopy | `https://mcp.nseindia.in/bhavcopy/cm/mcp` | 21 | end-of-day, 3,500+ equities, 5 years |
| cm-market | `https://mcp.nseindia.in/cmmkt/mcp` | 15 | near-real-time (crawled every 5 min, 15 min cache; page says 1-3 min delay), no tick or order book |

End-of-day tools: `get_stock_history` (OHLCV plus `series`, `prevClose`, `totalTradedValue`,
`deliveryQty`, 52-week high/low; up to 3 months per call), `get_ltp_by_date`, `get_bulk_quote` (50
symbols), `get_market_breadth`, `get_top_movers`, `get_top_by_volume`, `compare_stocks`,
`moving_average`, `get_52_week_high_low`, `get_volume_analysis`, **`get_corporate_actions`**,
`search_symbols`, `nse_lookup_symbol`, and nine index tools (`get_index_history`,
`get_index_snapshot`, `get_index_valuation` (PE/PB/dividend yield), `get_index_performance`,
`get_index_movers` (constituent contributors), `compare_indices`, `get_stock_vs_index`,
`get_market_mood`). Live tools: `cm_get_stock_quote`, `cm_get_live_gainers/losers`,
`cm_get_live_indices`, `cm_get_call_auction_stocks`, `cm_get_equity_stocks`, `cm_get_sme_stocks`,
`cm_get_bond_stocks`, `nse_get_market_movers`, `cm_get_data_status`.

**It settled the price-basis finding (AF-20261112-12).** For DBEIL the exchange's raw closes are
130.23 (2025-05-09) and 139.24 (2025-05-12), a smooth move, then 89.94 to 9.43 on 2026-06-19 (the real
10:1 split). Our `stock_ohlcv` has 1.302 and 13.84 on the first two dates: raw / 100 before
2025-05-12 and raw / 10 after it. The segment before the seam carries the split factor twice.
Six symbols step 10-11.5x on that one date; each has a later 2026 split.

**Corporate actions carry the factor we are missing.** `get_corporate_actions` returns
`{exDate, actionType, purpose, adjustmentFactor}`: DBEIL split 2026-06-19; AQYLON split factor 0.1 on
2026-03-05 (and no 2024-01-24 action, so our yfinance "SPLIT 0.01" row is spurious); KOTYARK bonus
10:1, factor 0.0909. No subject parsing needed.

Operational notes: one call returned HTTP 502 from the gateway (SILVERTUC, retry not attempted), so a client needs retries;
history is capped at 3 months per call, so a full 5-year validation of one stock is about 20 calls.
Use it for targeted validation (symbols with actions, symbols that step), not a full-universe crawl.

## 3. Upstox (anonymous routes only)

Answered 200 with no token: `api.upstox.com/v3/historical-candle/{NSE_EQ|ISIN}/days|weeks|months/1/{to}/{from}`
(5 years of daily candles in one call: 1,240 for RELIANCE; monthly back to 2021 in one call),
`.../historical-candle/intraday/{key}/minutes/1` (the full current session, 375 one-minute candles),
`/v2/market/holidays` (exchange holiday calendar with closed exchanges), `/v2/market/timings/{date}`,
and the public instruments file `assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz`
(87,905 rows: 9,899 NSE_EQ rows, all with ISIN; 667 stock/index futures and about 43,000 option
contracts with `lot_size` and `freeze_quantity`). Instrument keys are `NSE_EQ|{ISIN}`, and we hold
ISIN for 99% of stocks, so mapping needs no guessing. 401: `/v2/market/status/NSE`.

Caveats: candles are retrospectively **adjusted** (other session's HDFCBANK check), so they are a
cross-check for our adjusted history, not a raw-price source; the provider's documentation says
authorisation is required, so anonymous access can be withdrawn without notice.

Value here: (1) 1-minute candles for the whole NSE_EQ universe from one request per stock, if the
intraday pipeline wants a second source; (2) F&O contract specs (lot size, freeze quantity) we lack
in this form; (3) holiday and timing cross-check against `market_holidays`.

## 4. TEJ (`api.tejhq.dev`)

Its own MCP page lists three tiers. **No key:** `ohlcv` (daily prices as printed, raw), `snapshot` (a
whole exchange on one day, NSE or BSE), `actions` (corporate actions, both exchanges), `status`.
**Free key:** `adjusted` (split/bonus adjusted), `delivery`, `symbols` (ticker history through
renames). **Plan-limited:** `fo_chain`, `fo_contract`, `fo_expiries`, `fo_futures`. Verified: the
no-key tools answer 200; `/v1/adjusted/nse/RELIANCE` and `/v1/delivery/nse/RELIANCE` answer 401
`key_required`. **I did not sign up for a key**: that is an account in your name, not an anonymous
fetch, and it is yours to decide.

Value here: **BSE** whole-day snapshots (`/v1/snapshot/bse?date=`, 599 KB for 2026-11-12) and BSE
corporate actions, which we do not hold; and a second raw-price source to reconcile against. Its
data is derived from exchange files, so it is not an independent exchange vote (other session).

## 5. Trendlyne: what we fetch, who reads it, what could replace it

17 Trendlyne tables. Trendlyne has been returning 403 in bursts today (AF-20261113-26), including the
metrics fetch, so replacing the parts that have an alternative also reduces that exposure.

| Table (est. rows) | What it holds | Consumers | Alternative found | Verdict |
|---|---|---|---|---|
| `trendlyne_pe_history`, `pb_history` (4.3M each, 640 MB each) | daily PE / PB per stock | n/a here | rebuild from our `stock_ohlcv` and quarterly EPS/book value in `nse_filing_financials` (point-in-time); InvestSights `pe_band_history` for bands | **Replaceable**, needs a build |
| `trendlyne_adv_tech_daily` (124k) | RSI, MACD, ADX, ATR, MFI, CCI, ROC, pivots, returns, **delivery % (day/week/1m/6m)**, volume averages, beta | 5 files | indicators, returns and pivots are computable from `stock_ohlcv`; delivery % is already in `nse_universe_history` (`deliv_qty`, `deliv_pct`) and NSE MCP `deliveryQty` | **Replaceable with no new source** |
| `trendlyne_price_analysis` (158k) | stock / Nifty / industry returns 1m-5y, alpha, month seasonality | 11 files | computable from `stock_ohlcv` plus index history (NSE MCP `get_index_history`, `get_stock_vs_index`) | **Replaceable**, 11 consumers to re-point |
| `trendlyne_stock_metrics_history` (26k) | market cap, PE, PEG, PBV, institutional %, growth, margins, Piotroski, relative performance, ROE/ROA | 2 files | Tapetide `fundamentals`/`valuation`/`priceMetrics`/`growthSummary`; InvestSights fundamentals (Piotroski) | **Replaceable** (this is the fetch that 403s) |
| `trendlyne_stock_profile` (7.8k) | annual P&L, ROE/ROCE, ratios, promoter/FII/MF/pledge %, analyst target and count | 4 files | Tapetide `financials`, `shareholding`, `promoterPledge`, `analystRatings`, `forecasts` | **Replaceable** (MF % not seen in the page) |
| `trendlyne_analyst_targets` (3.7k) | per-broker target price, rating, date | 4 files | Moneycontrol broker recommendations already stored (`mc_broker_reco`); Tapetide gives aggregates only | **Partly**: per-broker comes from MC |
| `trendlyne_technical_snapshots` (2k) | per-timeframe technical JSON | 1 file | Tapetide `sections.technicals` (moving averages, oscillators, pivots) | **Replaceable** |
| `trendlyne_dvm_scores` (60k) | proprietary durability/valuation/momentum scores + colours | 9 files | analogue only: Tapetide score pillars (quality, valuation, momentum, growth, ownership, financial health) and InvestSights score; not the same quantity | **No 1:1**: measure the correlation before any swap |
| `trendlyne_fno_activity` (50k) | option-chain strikes, OI, IV, greeks, build-up | 3 files | NSE option chain (`nse_option_chain_source.py`), exchange F&O bhavcopy (`stock_futures_eod_history`), Upstox contract specs; greeks are computable | **Replaceable** |
| `trendlyne_checklist` (2.2k), `market_insights` (1.4k) | derived checklist score; event notifications | 3 each | derivable from the above; announcements candidate in the other doc | **Low value**, derive |
| `trendlyne_screeners`, `screener_stocks` (112k), `screener_pk_history` | Trendlyne's screener definitions and membership | many | other providers' screener families overlap in concept, but membership logic is Trendlyne's | **Keep**, no alternative |

Order suggested by cost and risk: (1) compute `adv_tech` and `price_analysis` fields from our own
OHLCV and delivery data (no vendor, no new fetch); (2) point `stock_metrics_history`,
`stock_profile` and `technical_snapshots` at the Tapetide page once tonight's run shows it landing;
(3) NSE-sourced F&O activity; (4) leave DVM and screeners until a correlation measurement says what a
substitute would change. Each swap must keep feature parity, because `ml_ensemble.py` and the ranker
read these columns, and the vendor-onboarding discipline for a new column to reach a blend
(`verify-gate.mjs`, `measurement.md`) still applies.

## 6. Recommended next steps, in order

1. **Fix the price-basis seam with NSE evidence** (AF-20261112-12): for the six symbols, confirm per
   symbol that pre-2025-05-12 closes equal NSE raw close / factor, find which writer applied the
   factor twice, repair (owner runs `--apply`).
2. **Use `get_corporate_actions` as the authority for ex-dates and factors** in place of yfinance for
   the adjuster, with a nightly cross-check of our adjusted closes against NSE raw closes for symbols
   that had an action in the last 90 days.
3. **Verify tonight's Tapetide fetch** (AF-20261107-09), then decide which extra page sections to store.
4. **BSE whole-day snapshots from TEJ** (no key) if BSE-only names matter.
5. **Upstox intraday** only if the intraday pipeline needs a second source; instruments file for lot sizes.
6. **Trendlyne replacement phase 1** (own-data computation) behind parity tests.

## What this doc does not establish

No source here was shown to add predictive value; they add authority, coverage and redundancy. Sample
sizes are one to three stocks per route. Terms exist for NSE MCP (information and learning, not
commercial products), Tapetide (terms prohibit automated extraction outside its API) and TEJ (data
terms); the owner has instructed that they are not a blocker, and that decision is recorded here
rather than assumed. Anonymous access to any of these can change without notice.
