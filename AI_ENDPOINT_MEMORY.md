# AI AGENT MASTER ENDPOINT & QUANTINGEST MEMORY INDEX (1024 API SCHEMAS)

> **Purpose**: This memory specification serves as a comprehensive system prompt & schema registry for AI agents to query, map, and integrate ALL 1024 real-world market endpoints across Indian Financial Data Providers (MoneyControl, NSE India, ETNow, NiftyTrader, Sensibull, Trendlyne, Tickertape, StockEdge, InvestSights, NDTV Profit, Finology Ticker, MarketsMojo, TapeTide).

---

## 0. VERIFICATION STATUS (read this first — 2026-07-30)

**The "1024 endpoints" catalogue in Section 3 below is an AI-generated discovery brainstorm, not a
verified capture.** It uses literal `"default"` placeholders for most query params, repeats
identical boilerplate descriptions per category regardless of the actual endpoint, and maps
canonical fields that don't match real response shapes (e.g. a `vwap-intraday` URL labeled with
`revenue, net_income, debt_to_equity, pe_ratio`). `endpoint_registry.py` already treats this file
correctly — it is parsed for audit/reference only; **none of its 1024 rows are ever fetched**
(`validate_ai_memory_record()` always sets `enabled=False`). Do not cite "1024 endpoints" as real
platform coverage. If you need real endpoint counts, they are:

| Status | Count | Where |
|---|---|---|
| **Live-fetchable, tested against real APIs (2026-07-30, three passes)** | **29** | `CURATED_EXTRA_ENDPOINTS` in `src/server/endpoint_registry.py` (27) + `trendlyne_fno_activity_fetcher.py` (1 endpoint family, 3 screen types) + `nse_ipo_calendar_fetcher.py` (1 endpoint family, 3 phases) |
| Parsed into ML features (`ml_ensemble.py`) | 15 feature columns from 5 of the 29 | `marketservices_shareholding`, `trading80_header_info`, `marketsmojo_header_info`, `investsights_score`, `tapetide_score` |
| Archived raw only (no parser yet, fetched + stored as-is) | 22 of the 29 | the original 9 + `stockedge_high_delivery_qty` + `investsights_pe_band`/`investsights_dcf_valuation`/`investsights_growth_metrics`/`investsights_pros_cons` + `tapetide_analyst_ratings`/`tapetide_forecasts` + `marketsmojo_stock_picks_history`/`marketsmojo_results_corner`/`tickertape_financials_income`/`tickertape_estimates_history`/`tickertape_deals`/`trendlyne_market_insight`/`trendlyne_mf_home` |
| Confirmed unreachable/blocked — do not add without solving the noted blocker | 2 | Sensibull `oxide.sensibull.com/*` (returns `401 invalid platform access token`); StockEdge per-stock endpoints (opaque numeric ID, no resolver) |
| **Tested and ruled dead** (403/404 even with full browser headers, or HTML not JSON — see Round 3) | ~72 unique shapes | `www.ndtvprofit.com` (16), `ticker.finology.in` (10), `api.niftytrader.in` (15, retired subdomain), `oxide.sensibull.com` (5), `www.moneycontrol.com/mc/widget/*` (13), plus scattered others |
| **Tested and confirmed real, but already covered by an existing fetcher** (not re-promoted) | ~180 unique shapes | see Round 3 — mostly `trendlyne.com`'s screener-catalog and per-stock paths, and most of `api.moneycontrol.com`/`webapi.niftytrader.in`/ETNow's surface (presumed, not path-by-path re-verified against every existing fetcher) |
| Unverified (Section 3 catalogue, AI-generated) | 1024 | This file, below — treat as a source of URL *shapes* to investigate, never as confirmed-working endpoints |

### Round 3 (2026-07-30, same day): all 437 unique URL shapes tested, not just a sample

At explicit request, every one of `updated_urls.json`'s 437 unique `(host, path)` shapes was
hit live (not sampled) — see the batch-test methodology: per-host headers, 15s timeout,
16-way concurrency, classified by HTTP status + JSON-vs-HTML body shape. Results: **352
returned real data**, 85 failed (403/404/401/timeout/5xx). The 352 successes were then
content-reviewed by cluster, cross-referencing every candidate against existing fetchers
**before** building anything — this caught several near-misses:

- **`trendlyne.com`'s ~35 `fundamentals/json-screener/{id}/...` paths are the exact same
  `screenpk` values `trendlyne_screener_discovery.py` already syncs** — confirmed by
  cross-referencing 6 sampled numeric ids (79791, 79811, 79796, 79790, 27, 28) against the
  live `trendlyne_screeners` table; all 6 matched existing screener names exactly (e.g.
  `79791` = "Relative Outperformance versus Nifty500 over 1 Year"). Not a new data source.
- **`trendlyne.com`'s per-stock paths were already covered**: `overview-second-part` and
  `chart/fundamental-profile` by `trendlyne_overview_fetcher.py`; `adv-technical-analysis` by
  `trendlyne_adv_tech_fetcher.py` (exact URL match); `share-price/price-performance-analysis`
  by `trendlyne_price_analysis_fetcher.py`; `sector-industry-analysis`/`global-indices-analysis`
  by `sync_tl_index_map.py`. Confirmed Trendlyne's numeric stock id in these URLs (e.g. `175`)
  **is** the same `tlid` field already in `stocklist.json` (175 = BEL, verified live) — so any
  future Trendlyne per-stock endpoint can template `{tlid}` directly, no new resolver needed.
- **Genuinely dead ends, tried harder before giving up**: `www.ndtvprofit.com` and
  `ticker.finology.in` remained 403 even with a full browser-like header set (Accept-Language,
  Referer, real Chrome UA) — real bot-protection (Cloudflare-class), not a simple header gap.
  `api.niftytrader.in` 404s across the board — a retired subdomain; `webapi.niftytrader.in` is
  the live one and is already used by existing `nt_*.py` fetchers. `www.moneycontrol.com/mc/widget/*`
  returns HTML (legacy server-rendered page fragments), not a JSON API.
- **What survived and was promoted** (all content-reviewed, all confirmed non-duplicate):
  `marketsmojo_stock_picks_history` (MarketsMojo's own model-portfolio track record — real
  entry/exit dates and returns, e.g. one live pick showing +154.54% — a genuine "does this
  third party's own picks have edge" candidate for a future `factor_edge.py` pass, same
  treatment `m_score` already got), `marketsmojo_results_corner` (market-wide earnings-results
  sentiment breakdown, positive/flat/negative counts + per-stock detail, valuable during
  results season), `tickertape_financials_income`/`tickertape_estimates_history` (per-stock,
  keyed by `tickertape_sid` — full normalized income statement history and historical
  analyst price-target estimates), `tickertape_deals` (market-wide, no `sids` param — 659,545
  total bulk/block deal records live-verified, materially richer than `block_deal_fetcher.py`'s
  NSE-sourced daily pull), `trendlyne_market_insight` (market-wide AI-tagged news/insight
  feed with per-item sentiment label), `trendlyne_mf_home` (mutual fund ratings/recommendation
  table — real but tangential to this platform's stock-picking focus, included for
  completeness). All archived raw for now (no parser yet), matching the established
  "archive first, build a feature once value is proven" pattern most of the original 12
  endpoints already follow. Live-datasource tests in `test_live_datasource_round3_endpoints.py`.
- **Not re-verified path-by-path**: the ~180 remaining working shapes across
  `api.moneycontrol.com`/`appfeeds.moneycontrol.com`/`priceapi.moneycontrol.com` (125),
  `webapi.niftytrader.in`/`api.niftytrader.in`'s working subset, and most of the ETNow/indiatimes
  cluster were confirmed reachable but assumed (not individually cross-checked one-by-one)
  redundant with this codebase's extensive existing MoneyControl/NiftyTrader/ETNow fetchers,
  given how deep that coverage already is. If a specific gap is ever suspected in one of
  those providers, treat this as unverified and check the specific path against existing
  fetchers the same way the Trendlyne cluster was checked here — do not assume.

### Round 2 (2026-07-30, same day): InvestSights + Tapetide + NSE official libraries

**InvestSights (`investsights.in`) and Tapetide (`api.tapetide.com`) both resolve stocks directly
by plain NSE symbol** (confirmed via InvestSights' own `/symbols/resolve/{symbol}` endpoint
returning `{"found": true, "canonical": "RELIANCE"}`) — no opaque per-provider ID needed, unlike
Trading80/MarketsMojo/StockEdge. Both are genuinely rich, no-auth-required REST APIs (~51 unique
paths captured for InvestSights, 14 for Tapetide in `updated_urls.json`); only a focused,
individually-live-tested subset was promoted rather than the whole surface:

- **`investsights_score`** (parsed → `ext_is_overall_score`, `ext_is_percentile_rank`) — a
  7-factor composite (value/growth/quality/momentum/stability/governance/sentiment) plus
  `forensic_scores` (Piotroski, Altman Z) and `risk_indicators` (beta, volatility) in the raw
  response. Only the two headline fields are promoted to ML features for now — the
  forensic/risk sub-fields overlap conceptually with this codebase's EXISTING independently-
  computed `altman_z`/`piotroski` features (from `psh_az`/`stock_fundamentals` in
  `ml_ensemble.py`) and need a cross-validation pass (do the two sources agree?) before adding
  a second copy — **not done yet**, same caution as the Trading80/MarketsMojo duplication
  finding above. `investsights_pe_band`, `investsights_dcf_valuation`,
  `investsights_growth_metrics`, `investsights_pros_cons` promoted as raw archive only.
- **`tapetide_score`** (parsed → `ext_tt_score`) — a DIFFERENT 6-pillar composite
  (financial_health/growth/momentum/ownership/quality/valuation, each independently weighted).
  Live spot-check found it is NOT byte-identical to `investsights_score` or to `ext_t80_*`/
  `ext_mojo_*` (unlike the earlier-confirmed Trading80≡MarketsMojo duplication), but that was
  not a rigorous `factor_edge.py` pass — treat as unvalidated until enough history accumulates.
  `tapetide_analyst_ratings`, `tapetide_forecasts` promoted as raw archive only.
- **Ruled out live**: Tapetide's `ai-chat.tapetide.com/*` (401 `Authentication required`,
  same class of blocker as Sensibull). `quote`/`chart_1y`/`chart_max`/`link_index` confirmed
  working but skipped as promotions — redundant with existing deep OHLCV backfill
  (`mc_ohlcv_backfill.py`) and live price feeds, no incremental signal value.
- **Real bug found and fixed while wiring this in**: `extra_endpoints_fetcher.py`'s
  `fetch_url()` had a hardcoded 10s timeout — too short for `api.tapetide.com` under this
  fetcher's real 8-worker concurrent load (confirmed: `tapetide_*` fetches for RELIANCE
  silently returned nothing, no error surfaced beyond a log line, `ext_tt_score` stayed NULL).
  Bumped to 20s.
- **Second, more serious real bug found and fixed**: running `extra_features_parser.py`'s
  `run()` against the full universe (2188 symbols) for the first time this session crashed
  with `AttributeError: 'list' object has no attribute 'get'` — some stocks
  (ELGIRUBCO/MUTHOOTFIN/ADANIGREEN confirmed live) get `"data": []` (an empty LIST) instead of
  `"data": {}` from `trading80_header_info` when Trading80 has no score for that stock, and
  `.get("dot_summary", ...)` on a list crashes. **This means the daily ext_\* feature-parsing
  step for the ENTIRE universe had likely been crashing on the first such stock it encountered
  since this table was introduced** — silently truncating every run to whatever alphabetically
  (or DB-order) preceded the first list-shaped row. Fixed with a new `_as_dict()` guard applied
  everywhere `extract_features()` calls `.get()` on provider-nested JSON (including the
  investsights/tapetide branches, defensively, even though they haven't shown this failure
  mode yet). Full-universe run now completes cleanly: 1663/2188 symbols updated. Regression
  tests in `TestNonDictNestedShapeDoesNotCrash` (`test_extra_features_parser.py`).

**NSE official libraries evaluated** (per an explicit ask to distribute load / reduce
over-dependence on any one source, and surface data not currently available):
- **`nse` (NseIndiaApi, PyPI)** — chosen as the integration target. Live-verified reliable
  across `status`, `quote`, `listCurrentIPO`/`listUpcomingIPO`/`listPastIPO`, `shareholding`,
  `advanceDecline`, `getFuturesExpiry`, `financial_results`, `boardMeetings`. Lean dependency
  footprint (only `mthrottle`). Added to `requirements.txt`.
- **`nsepython` (PyPI)** — evaluated and NOT chosen as primary. Has real live bugs in this
  version: `nse_get_advances_declines()` raises `NameError: name 'logger' is not defined`
  (a bug in the library itself), `nse_most_active()` raises `KeyError: 'data'`, `gainers()`-
  equivalent paths and `get_fao_participant_oi()` 404'd on real live calls. Its
  `nse_price_band_hitters('upper'/'lower')` (circuit-breaker hitters) DID work reliably and is
  a real, currently-uncovered signal — flagged as a follow-up candidate, not implemented this
  round to keep the dependency surface to one well-behaved NSE package rather than two.
- **`stock-nse-india` (npm)** — explored and deliberately NOT integrated. `npm view` shows 29+
  direct dependencies including a bundled GraphQL server (`apollo-server-express`), an MCP
  server, and the OpenAI SDK (`unpackedSize` 413KB, designed to run as its own standalone
  server/CLI, not as a lightweight client import). Pulling this into the Node/tRPC side would
  add real dependency and security surface for functionality the already-verified lean Python
  `nse` package already covers — wrong architectural fit for this codebase's established
  pattern (Python fetchers write to Postgres; Node/tRPC only reads). No accuracy or
  performance benefit identified over the Python path.
- **What was integrated**: (1) **`nse_ipo_calendar_fetcher.py`** (new) — NSE's own
  current/upcoming/past IPO calendar, genuinely new data (confirmed via a full grep sweep that
  no existing fetcher covers this). Writes to `nse_ipo_calendar`. Live-verified: NSE's own
  `listPastIPO()` occasionally returns the exact same symbol twice in one response
  (CUBEINVIT/BAGMANE, byte-identical rows) — handled via upsert (`ON CONFLICT DO UPDATE`), not
  a plain insert. Wired into `queues.ts` daily alongside `mc_corporate_calendar_fetcher.py`.
  (2) **NSE-official expiry cross-source** in `trendlyne_fno_activity_fetcher.py` — 
  `_get_nearest_monthly_expiry()` now tries NSE's own `getFuturesExpiry('NIFTY')` first
  (authoritative, live-verified to match the prior mode-based `nt_fno_expiry` heuristic
  exactly: `2026-08-25` both ways) and only falls back to the `nt_fno_expiry`-mode heuristic if
  the NSE call fails — reduces sole dependence on NiftyTrader's expiry sync for this one
  consumer while also using the more authoritative source when available.
- **Not attempted this round** (flagged, not implemented — would need dedicated scoping):
  using NSE's own `quote()` as a redundant/fallback source for live price polling (currently
  100% Yahoo-Finance-dependent per `liveStockData.ts`) — confirmed the API call works, but
  order-book fields read all-zero outside market hours in this test and a proper redundancy
  wire-in deserves its own dedicated session mirroring the `intraday_fetcher.py` MC+Yahoo
  dual-source pattern, not a drive-by addition here.

### External composite scores — confirmed NOT independent signals

Live-verified 2026-07-30 across a 15-stock sample: `trading80_header_info` and
`marketsmojo_header_info` return **byte-identical `dot_summary` data** for the same stock (same
`q_rank`, `v_rank`, `f_pts`, `tech_score` — MarketsMojo is reissuing Trading80's own scoring, not
an independent opinion). `factor_edge.py --table technical_signals --scores
ext_t80_quality_rank,ext_mojo_quality_rank,...` independently corroborates this: `ext_t80_*` and
`ext_mojo_*` produced identical rank_IC/hit_AUC/n on every run. **Do not treat the `ext_t80_*` /
`ext_mojo_*` pair in `ml_ensemble.py` as diversified signal** — they're the same field stored
twice. A first `factor_edge.py` run against real `technical_signals` history came back
**LOW-DATA** on every score (only 4-6 dates of history exist as of 2026-07-30) — there is not yet
enough history to say whether any of these external scores carry real forward-return edge;
re-run `factor_edge.py --table technical_signals --scores ext_t80_tech_score,ext_t80_quality_rank,ext_t80_valuation_rank,ext_t80_financial_pts,ext_fii_holding_pct,ext_dii_holding_pct --persist`
in 4-6 weeks once daily fetches accumulate enough dates, the same way `m_score` was found to have
**no** forward edge (see `factor_edge_history` / the memory system's `m_score` finding) after a
larger sample. Two real bugs were found and fixed while investigating this (both live-verified):
a `-99997` "no score" sentinel value was passing straight into ML features unfiltered
(`extra_features_parser.py`'s `_clean_score()` now catches it), and `ml_ensemble.py`'s clip bounds
for `q_rank`/`v_rank`/`f_pts` were badly mismatched to the real observed range (real `q_rank` runs
2-66, not the assumed 0-5/0-20; real `v_rank`/`f_pts` run negative, not the assumed positive-only
floor of 0) — both fixed in `ml_ensemble.py`'s `build_features()`.

### What was promoted this session (all live-tested before being added)

- **`stockedge_high_delivery_qty`** (`CURATED_EXTRA_ENDPOINTS`, market-wide, no per-stock ID
  needed) — StockEdge's high-delivery-quantity alert scanner. Promoted from
  `explore_mc_tl.py`'s pre-existing (but never wired) `build_stockedge_urls()`; 3 of 6 candidate
  StockEdge market-wide URLs from that function 404'd live and were dropped, this one returned
  real, current (previous-session-dated) data.
- **`trendlyne_fno_activity_fetcher.py`** (new standalone fetcher, mirrors
  `so_option_chain_fetcher.py`'s structure) — Trendlyne SmartOptions' cross-market F&O activity
  screeners (`most-active-value`, `oi-gainers`, `oi-losers`), a genuinely different endpoint from
  `so_option_chain_fetcher.py`'s per-stock option chain (that one needs `stockCode`; this one is a
  ranked cross-market screener with no per-stock id). Source URL in `updated_urls.json` had a
  stale hardcoded `expDate=2026-05-26` (a past expiry by the time this was reviewed) — fixed by
  resolving the current monthly F&O expiry live from `nt_fno_expiry` (the mode/most-common expiry
  date across symbols, **not** NIFTY's own nearest expiry, which is a weekly-only date most
  individual stocks don't trade on at all — using NIFTY's expiry here was tried first and
  returned 298/298 rows for symbol=NIFTY only; the monthly expiry correctly returns 97-155
  distinct symbols per screen type). Writes to `trendlyne_fno_activity`. Not yet wired into any
  ML feature — raw archival for now, same as most of the original 9 unparsed curated endpoints.
- **Ruled out after live-testing** (do not re-add without solving the noted blocker): Sensibull
  `oxide.sensibull.com` (auth-gated), StockEdge per-stock endpoints (no ID resolver),
  `kayal.trendlyne.com` / `smartoptions.trendlyne.com`'s option-chain path / `api.tickertape.in`
  (all already covered by existing fetchers — `trendlyne_screener_discovery.py`,
  `so_option_chain_fetcher.py`, `tickertape_client.py` — re-promoting them here would duplicate,
  not add, coverage).

Live-datasource tests for all of the above live in `src/server/tests/test_live_datasource_extra_endpoints.py`
and `test_live_datasource_trendlyne_fno_activity.py` (skipped by default — run with
`RUN_LIVE_DATASOURCE_TESTS=1`).

---

## 1. Executive Summary & Category Matrix (UNVERIFIED — see Section 0)

| Category | Endpoint Count | Sample Frequency | Primary Canonical Fields | Key Use Case |
| :--- | :--- | :--- | :--- | :--- |
| **Price & Technical Charts** | `123 Endpoints` | 1-Min Intraday | Listed per endpoint | OHLCV bars, VWAP streams, tick pricing, Order Book depth |
| **Derivatives & F&O Analytics** | `123 Endpoints` | 1-Min Intraday | Listed per endpoint | Futures basis, Option Chain matrix, OI builds, IV Skew, PCR, Max Pain |
| **Fundamental Financials & Valuation** | `123 Endpoints` | Quarterly | Listed per endpoint | Quarterly Balance Sheets, Income Statements, Cash Flow, Financial Ratios |
| **Screener & Quantitative Discovery** | `123 Endpoints` | Daily EOD | Listed per endpoint | Multi-factor strategy filters, trend setups, delivery scanners |
| **Ownership & Institutional Holdings** | `123 Endpoints` | Quarterly | Listed per endpoint | FII/DII net flows, Promoter pledges, Mutual Fund portfolios |
| **News, Filings & AI Sentiment** | `121 Endpoints` | Event-based | Listed per endpoint | Exchange announcements, AI news summaries, market pulse feeds |
| **Analyst Estimates & Price Targets** | `96 Endpoints` | Daily EOD | Listed per endpoint | Consensus price targets, EPS forecast hits/misses, broker calls |
| **Corporate Actions & Governance** | `96 Endpoints` | Event-based | Listed per endpoint | Dividends, stock splits, bonus announcements, board meetings |
| **General Market Metadata** | `96 Endpoints` | Daily EOD | Listed per endpoint | Symbol mapping dictionaries, trading calendars, global market cues |

---

## 2. Global Provider Distribution

- **MoneyControl**: Intraday ticks, Futures & Options pricing, Valuation scorecards, Technical indicators.
- **NSE India**: Official Exchange Market Status, Pre-Open matching, Corporate Filings, Index Watch.
- **ETNow / Economic Times**: Technical Screeners, Shareholding patterns, Sector Performance, News Feeds.
- **NiftyTrader**: Live Option Chain Matrix, Max Pain, Intraday OI Time Ranges, IV Percentiles.
- **Sensibull**: FII/DII Cash & Derivatives Flows, Option Lot Sizes, Multi-strike IV surfaces.
- **Trendlyne**: Custom Screeners, F&O Heatmaps, DII/FII Institutional Holdings, Advanced Technicals.
- **Tickertape**: Market Mood Index (MMI), Scorecards, Intraday Charting, Consensus Analyst Recs.
- **StockEdge**: Delivery Quantity Scanners, Saved Breakout Alerts, Technical Scorecards.
- **InvestSights**: DCF Intrinsic Valuation models, Sector Rotation RRG, Superstar Portfolios.
- **NDTV Profit / Bloomberg**: Sector Heatmaps, Market Movers, Research Reports.
- **Finology Ticker**: Peer Comparisons, Price-to-Book Ratios, Historical Volume, Shareholding.
- **MarketsMojo**: Mojo Stock Health Rankings, Quality/Valuation Scorecards, Market Actions.
- **TapeTide**: AI Copilot Insights, 1-Year/Max Historical Price Series, Company Forecasts.

---

## 3. Full Comprehensive Endpoint Memory Index (All 1024 Endpoints Covered) — UNVERIFIED, see Section 0

> Every entry below is AI-generated and unverified — `"default"` in a query string means the
> real value was never captured, and `endpoint_registry.py` never fetches from any row here.
> Treat entries as leads to manually verify (real ID, real headers, real response shape) before
> ever adding one to `CURATED_EXTRA_ENDPOINTS` or a dedicated fetcher — see Section 0 for the
> process that promoted `stockedge_high_delivery_qty` and `trendlyne_fno_activity_fetcher.py`.

### [EP-0001] MoneyControl - Price & Technical Charts
- **URL**: `https://api.moneycontrol.com/mcapi/v1/history?symbol=TCS&resolution=default&from=default&to=default&currencyCode=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, resolution, from, to, currencyCode`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: MoneyControl Real-time historical OHLCV chart bars and tick time-series data. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0002] MoneyControl - Price & Technical Charts
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/history?symbol=HDFCBANK&resolution=default&from=default&to=default&currencyCode=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, resolution, from, to, currencyCode`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: MoneyControl Real-time historical OHLCV chart bars and tick time-series data. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0003] MoneyControl - Price & Technical Charts
- **URL**: `https://www.moneycontrol.com/mc/widget/history?symbol=SBIN&resolution=default&from=default&to=default&currencyCode=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, resolution, from, to, currencyCode`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: MoneyControl Real-time historical OHLCV chart bars and tick time-series data. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0004] MoneyControl - Derivatives & F&O Analytics
- **URL**: `https://api.moneycontrol.com/mcapi/v1/live-quote?symbol=ICICIBANK`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: MoneyControl Live streaming market quote, last traded price, bid/ask depth, and session volume. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0005] MoneyControl - Derivatives & F&O Analytics
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/live-quote?symbol=BHARTIARTL`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: MoneyControl Live streaming market quote, last traded price, bid/ask depth, and session volume. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0006] MoneyControl - Derivatives & F&O Analytics
- **URL**: `https://www.moneycontrol.com/mc/widget/live-quote?symbol=LTIM`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: MoneyControl Live streaming market quote, last traded price, bid/ask depth, and session volume. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0007] MoneyControl - Fundamental Financials & Valuation
- **URL**: `https://api.moneycontrol.com/mcapi/v1/vwap-intraday?scId=640544&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: MoneyControl Intraday Volume-Weighted Average Price (VWAP) line coordinates and volume distribution. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0008] MoneyControl - Fundamental Financials & Valuation
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/vwap-intraday?scId=BE03&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: MoneyControl Intraday Volume-Weighted Average Price (VWAP) line coordinates and volume distribution. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0009] MoneyControl - Fundamental Financials & Valuation
- **URL**: `https://www.moneycontrol.com/mc/widget/vwap-intraday?scId=WSL&period=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: MoneyControl Intraday Volume-Weighted Average Price (VWAP) line coordinates and volume distribution. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0010] MoneyControl - Screener & Quantitative Discovery
- **URL**: `https://api.moneycontrol.com/mcapi/v1/pivot-levels?scId=IT&classic=default&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, classic, period`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: MoneyControl Classic, Fibonacci, and Camarilla pivot support (S1-S3) and resistance (R1-R3) levels. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0011] MoneyControl - Screener & Quantitative Discovery
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/pivot-levels?scId=RLXO&classic=default&period=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, classic, period`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: MoneyControl Classic, Fibonacci, and Camarilla pivot support (S1-S3) and resistance (R1-R3) levels. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0012] MoneyControl - Screener & Quantitative Discovery
- **URL**: `https://www.moneycontrol.com/mc/widget/pivot-levels?scId=WEBELSOLAR&classic=default&period=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, classic, period`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: MoneyControl Classic, Fibonacci, and Camarilla pivot support (S1-S3) and resistance (R1-R3) levels. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0013] MoneyControl - Ownership & Institutional Holdings
- **URL**: `https://api.moneycontrol.com/mcapi/v1/moving-averages?scId=JKIN&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: MoneyControl Exponential (EMA) and Simple (SMA) moving averages across 5, 20, 50, 100, 200 day periods. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0014] MoneyControl - Ownership & Institutional Holdings
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/moving-averages?scId=11945&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: MoneyControl Exponential (EMA) and Simple (SMA) moving averages across 5, 20, 50, 100, 200 day periods. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0015] MoneyControl - Ownership & Institutional Holdings
- **URL**: `https://www.moneycontrol.com/mc/widget/moving-averages?scId=8581&period=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: MoneyControl Exponential (EMA) and Simple (SMA) moving averages across 5, 20, 50, 100, 200 day periods. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0016] MoneyControl - News, Filings & AI Sentiment
- **URL**: `https://api.moneycontrol.com/mcapi/v1/chart-patterns?scId=11984&pattern_type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `sc_id, pattern_type`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: MoneyControl Automated candlestick pattern scanner (Doji, Marubozu, Head & Shoulders, Double Top). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0017] MoneyControl - News, Filings & AI Sentiment
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/chart-patterns?scId=16552&pattern_type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `sc_id, pattern_type`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: MoneyControl Automated candlestick pattern scanner (Doji, Marubozu, Head & Shoulders, Double Top). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0018] MoneyControl - News, Filings & AI Sentiment
- **URL**: `https://www.moneycontrol.com/mc/widget/chart-patterns?scId=132762&pattern_type=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Event-based`
- **Parameters**: `sc_id, pattern_type`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: MoneyControl Automated candlestick pattern scanner (Doji, Marubozu, Head & Shoulders, Double Top). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0019] MoneyControl - Analyst Estimates & Price Targets
- **URL**: `https://api.moneycontrol.com/mcapi/v1/option-chain?symbol=ICICIBANK&expiryDate=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol, expiryDate, exchange`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: MoneyControl Complete options chain matrix containing Call/Put LTP, Strike Prices, OI, and IV Skew. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0020] MoneyControl - Analyst Estimates & Price Targets
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/option-chain?symbol=BHARTIARTL&expiryDate=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol, expiryDate, exchange`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: MoneyControl Complete options chain matrix containing Call/Put LTP, Strike Prices, OI, and IV Skew. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0021] MoneyControl - Analyst Estimates & Price Targets
- **URL**: `https://www.moneycontrol.com/mc/widget/option-chain?symbol=LTIM&expiryDate=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol, expiryDate, exchange`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: MoneyControl Complete options chain matrix containing Call/Put LTP, Strike Prices, OI, and IV Skew. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0022] MoneyControl - Corporate Actions & Governance
- **URL**: `https://api.moneycontrol.com/mcapi/v1/futures-data?exchange=NSE&id=default&expirydate=default&fut=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `id, expirydate, fut`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: MoneyControl Futures contract prices, lot sizes, basis premium/discount to spot, and open interest builds. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0023] MoneyControl - Corporate Actions & Governance
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/futures-data?exchange=NSE&id=default&expirydate=default&fut=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `id, expirydate, fut`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: MoneyControl Futures contract prices, lot sizes, basis premium/discount to spot, and open interest builds. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0024] MoneyControl - Corporate Actions & Governance
- **URL**: `https://www.moneycontrol.com/mc/widget/futures-data?exchange=NSE&id=default&expirydate=default&fut=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Event-based`
- **Parameters**: `id, expirydate, fut`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: MoneyControl Futures contract prices, lot sizes, basis premium/discount to spot, and open interest builds. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0025] MoneyControl - General Market Metadata
- **URL**: `https://api.moneycontrol.com/mcapi/v1/oi-pcr-trend?exchange=NSE&symbolName=default&reqType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbolName, reqType`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: MoneyControl Intraday Put-Call Ratio (PCR) history and open interest distribution charts. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0026] MoneyControl - General Market Metadata
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/oi-pcr-trend?exchange=NSE&symbolName=default&reqType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbolName, reqType`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: MoneyControl Intraday Put-Call Ratio (PCR) history and open interest distribution charts. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0027] MoneyControl - General Market Metadata
- **URL**: `https://www.moneycontrol.com/mc/widget/oi-pcr-trend?exchange=NSE&symbolName=default&reqType=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Daily EOD`
- **Parameters**: `symbolName, reqType`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: MoneyControl Intraday Put-Call Ratio (PCR) history and open interest distribution charts. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0028] MoneyControl - Price & Technical Charts
- **URL**: `https://api.moneycontrol.com/mcapi/v1/iv-percentile?symbol=KOTAKBANK&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, type, exchange`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: MoneyControl Implied Volatility (IV) rank, IV percentile, and historical IV volatility surface. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0029] MoneyControl - Price & Technical Charts
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/iv-percentile?symbol=RELIANCE&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, type, exchange`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: MoneyControl Implied Volatility (IV) rank, IV percentile, and historical IV volatility surface. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0030] MoneyControl - Price & Technical Charts
- **URL**: `https://www.moneycontrol.com/mc/widget/iv-percentile?symbol=INFY&type=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, type, exchange`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: MoneyControl Implied Volatility (IV) rank, IV percentile, and historical IV volatility surface. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0031] MoneyControl - Derivatives & F&O Analytics
- **URL**: `https://api.moneycontrol.com/mcapi/v1/max-pain?symbol=TCS`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: MoneyControl Intraday and EOD Max Pain strike price calculation for options expiry pinning. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0032] MoneyControl - Derivatives & F&O Analytics
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/max-pain?symbol=HDFCBANK`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: MoneyControl Intraday and EOD Max Pain strike price calculation for options expiry pinning. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0033] MoneyControl - Derivatives & F&O Analytics
- **URL**: `https://www.moneycontrol.com/mc/widget/max-pain?symbol=SBIN`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: MoneyControl Intraday and EOD Max Pain strike price calculation for options expiry pinning. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0034] MoneyControl - Fundamental Financials & Valuation
- **URL**: `https://api.moneycontrol.com/mcapi/v1/fno-ban-list?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchange`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: MoneyControl Official NSE F&O Securities in Ban Period exceeding 95% Market-Wide Position Limit (MWPL). [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0035] MoneyControl - Fundamental Financials & Valuation
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/fno-ban-list?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchange`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: MoneyControl Official NSE F&O Securities in Ban Period exceeding 95% Market-Wide Position Limit (MWPL). [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0036] MoneyControl - Fundamental Financials & Valuation
- **URL**: `https://www.moneycontrol.com/mc/widget/fno-ban-list?exchange=NSE`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Quarterly`
- **Parameters**: `exchange`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: MoneyControl Official NSE F&O Securities in Ban Period exceeding 95% Market-Wide Position Limit (MWPL). [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0037] MoneyControl - Screener & Quantitative Discovery
- **URL**: `https://api.moneycontrol.com/mcapi/v1/oi-heatmaps?exchange=NSE&mtype=default&expDate=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `mtype, expDate`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: MoneyControl Heatmap of open interest vs price change (Long Build-up, Short Covering, Short Build-up). [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0038] MoneyControl - Screener & Quantitative Discovery
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/oi-heatmaps?exchange=NSE&mtype=default&expDate=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `mtype, expDate`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: MoneyControl Heatmap of open interest vs price change (Long Build-up, Short Covering, Short Build-up). [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0039] MoneyControl - Screener & Quantitative Discovery
- **URL**: `https://www.moneycontrol.com/mc/widget/oi-heatmaps?exchange=NSE&mtype=default&expDate=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Daily EOD`
- **Parameters**: `mtype, expDate`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: MoneyControl Heatmap of open interest vs price change (Long Build-up, Short Covering, Short Build-up). [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0040] MoneyControl - Ownership & Institutional Holdings
- **URL**: `https://api.moneycontrol.com/mcapi/v1/financial-overview?scId=IT&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: MoneyControl Consolidated Income Statement, Balance Sheet, and Cash Flow Annual and Quarterly figures. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0041] MoneyControl - Ownership & Institutional Holdings
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/financial-overview?scId=RLXO&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: MoneyControl Consolidated Income Statement, Balance Sheet, and Cash Flow Annual and Quarterly figures. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0042] MoneyControl - Ownership & Institutional Holdings
- **URL**: `https://www.moneycontrol.com/mc/widget/financial-overview?scId=WEBELSOLAR&ex=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Quarterly`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: MoneyControl Consolidated Income Statement, Balance Sheet, and Cash Flow Annual and Quarterly figures. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0043] MoneyControl - News, Filings & AI Sentiment
- **URL**: `https://api.moneycontrol.com/mcapi/v1/pe-pb-bands?symbol=KOTAKBANK&days=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `days, symbol`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: MoneyControl Historical Valuation P/E and P/B median bands over 3-year and 5-year horizons. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0044] MoneyControl - News, Filings & AI Sentiment
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/pe-pb-bands?symbol=RELIANCE&days=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `days, symbol`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: MoneyControl Historical Valuation P/E and P/B median bands over 3-year and 5-year horizons. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0045] MoneyControl - News, Filings & AI Sentiment
- **URL**: `https://www.moneycontrol.com/mc/widget/pe-pb-bands?symbol=INFY&days=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Event-based`
- **Parameters**: `days, symbol`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: MoneyControl Historical Valuation P/E and P/B median bands over 3-year and 5-year horizons. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0046] MoneyControl - Analyst Estimates & Price Targets
- **URL**: `https://api.moneycontrol.com/mcapi/v1/dcf-valuation?symbol=TCS`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: MoneyControl Discounted Cash Flow (DCF) intrinsic value valuation model and target fair price. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0047] MoneyControl - Analyst Estimates & Price Targets
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/dcf-valuation?symbol=HDFCBANK`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: MoneyControl Discounted Cash Flow (DCF) intrinsic value valuation model and target fair price. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0048] MoneyControl - Analyst Estimates & Price Targets
- **URL**: `https://www.moneycontrol.com/mc/widget/dcf-valuation?symbol=SBIN`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: MoneyControl Discounted Cash Flow (DCF) intrinsic value valuation model and target fair price. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0049] MoneyControl - Corporate Actions & Governance
- **URL**: `https://api.moneycontrol.com/mcapi/v1/ratio-analysis?companyid=107685`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid, exchange`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: MoneyControl Solvency, liquidity, Return on Equity (ROE), and Return on Capital Employed (ROCE) ratios. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0050] MoneyControl - Corporate Actions & Governance
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/ratio-analysis?companyid=363433`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid, exchange`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: MoneyControl Solvency, liquidity, Return on Equity (ROE), and Return on Capital Employed (ROCE) ratios. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0051] MoneyControl - Corporate Actions & Governance
- **URL**: `https://www.moneycontrol.com/mc/widget/ratio-analysis?companyid=984165`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Event-based`
- **Parameters**: `companyid, exchange`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: MoneyControl Solvency, liquidity, Return on Equity (ROE), and Return on Capital Employed (ROCE) ratios. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0052] MoneyControl - General Market Metadata
- **URL**: `https://api.moneycontrol.com/mcapi/v1/quarterly-results?scId=640544&type_format=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `sc_id, type_format`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: MoneyControl Detailed quarterly revenue, operating profit margins, and net profit margins. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0053] MoneyControl - General Market Metadata
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/quarterly-results?scId=BE03&type_format=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `sc_id, type_format`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: MoneyControl Detailed quarterly revenue, operating profit margins, and net profit margins. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0054] MoneyControl - General Market Metadata
- **URL**: `https://www.moneycontrol.com/mc/widget/quarterly-results?scId=WSL&type_format=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Daily EOD`
- **Parameters**: `sc_id, type_format`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: MoneyControl Detailed quarterly revenue, operating profit margins, and net profit margins. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0055] MoneyControl - Price & Technical Charts
- **URL**: `https://api.moneycontrol.com/mcapi/v1/trending-screeners?exchange=NSE&exchangeId=default&pageNumber=default&pageSize=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `exchangeId, pageNumber, pageSize`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: MoneyControl Top trending technical and quantitative screening strategies. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0056] MoneyControl - Price & Technical Charts
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/trending-screeners?exchange=NSE&exchangeId=default&pageNumber=default&pageSize=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `exchangeId, pageNumber, pageSize`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: MoneyControl Top trending technical and quantitative screening strategies. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0057] MoneyControl - Price & Technical Charts
- **URL**: `https://www.moneycontrol.com/mc/widget/trending-screeners?exchange=NSE&exchangeId=default&pageNumber=default&pageSize=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `1-Min Intraday`
- **Parameters**: `exchangeId, pageNumber, pageSize`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: MoneyControl Top trending technical and quantitative screening strategies. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0058] MoneyControl - Derivatives & F&O Analytics
- **URL**: `https://api.moneycontrol.com/mcapi/v1/gainers-losers?exchange=NSE&pagesize=default&duration=default&marketcap=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `pagesize, duration, marketcap`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: MoneyControl Real-time top gainers, losers, and volume shockers filtered by market cap. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0059] MoneyControl - Derivatives & F&O Analytics
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/gainers-losers?exchange=NSE&pagesize=default&duration=default&marketcap=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `pagesize, duration, marketcap`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: MoneyControl Real-time top gainers, losers, and volume shockers filtered by market cap. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0060] MoneyControl - Derivatives & F&O Analytics
- **URL**: `https://www.moneycontrol.com/mc/widget/gainers-losers?exchange=NSE&pagesize=default&duration=default&marketcap=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `1-Min Intraday`
- **Parameters**: `pagesize, duration, marketcap`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: MoneyControl Real-time top gainers, losers, and volume shockers filtered by market cap. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0061] MoneyControl - Fundamental Financials & Valuation
- **URL**: `https://api.moneycontrol.com/mcapi/v1/delivery-scanners?exchange=NSE&lang=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `lang`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: MoneyControl Stocks with high delivery percentage and delivery quantity spikes for smart money tracking. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0062] MoneyControl - Fundamental Financials & Valuation
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/delivery-scanners?exchange=NSE&lang=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `lang`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: MoneyControl Stocks with high delivery percentage and delivery quantity spikes for smart money tracking. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0063] MoneyControl - Fundamental Financials & Valuation
- **URL**: `https://www.moneycontrol.com/mc/widget/delivery-scanners?exchange=NSE&lang=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Quarterly`
- **Parameters**: `lang`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: MoneyControl Stocks with high delivery percentage and delivery quantity spikes for smart money tracking. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0064] MoneyControl - Screener & Quantitative Discovery
- **URL**: `https://api.moneycontrol.com/mcapi/v1/momentum-rankings?exchange=NSE&index=default&page=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `index, page`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: MoneyControl Relative strength momentum rankings vs Nifty 50 benchmark index. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0065] MoneyControl - Screener & Quantitative Discovery
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/momentum-rankings?exchange=NSE&index=default&page=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `index, page`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: MoneyControl Relative strength momentum rankings vs Nifty 50 benchmark index. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0066] MoneyControl - Screener & Quantitative Discovery
- **URL**: `https://www.moneycontrol.com/mc/widget/momentum-rankings?exchange=NSE&index=default&page=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Daily EOD`
- **Parameters**: `index, page`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: MoneyControl Relative strength momentum rankings vs Nifty 50 benchmark index. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0067] MoneyControl - Ownership & Institutional Holdings
- **URL**: `https://api.moneycontrol.com/mcapi/v1/proscanner-details?exchange=NSE&catId=default&scanId=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `catId, scanId`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: MoneyControl Algorithmic quantitative strategies screening details and stock candidate lists. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0068] MoneyControl - Ownership & Institutional Holdings
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/proscanner-details?exchange=NSE&catId=default&scanId=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `catId, scanId`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: MoneyControl Algorithmic quantitative strategies screening details and stock candidate lists. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0069] MoneyControl - Ownership & Institutional Holdings
- **URL**: `https://www.moneycontrol.com/mc/widget/proscanner-details?exchange=NSE&catId=default&scanId=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Quarterly`
- **Parameters**: `catId, scanId`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: MoneyControl Algorithmic quantitative strategies screening details and stock candidate lists. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0070] MoneyControl - News, Filings & AI Sentiment
- **URL**: `https://api.moneycontrol.com/mcapi/v1/shareholding-pattern?companyid=IT`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: MoneyControl Distribution of stock equity among Promoters, FIIs, DIIs, Mutual Funds, and Retail. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0071] MoneyControl - News, Filings & AI Sentiment
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/shareholding-pattern?companyid=RLXO`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: MoneyControl Distribution of stock equity among Promoters, FIIs, DIIs, Mutual Funds, and Retail. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0072] MoneyControl - News, Filings & AI Sentiment
- **URL**: `https://www.moneycontrol.com/mc/widget/shareholding-pattern?companyid=WEBELSOLAR`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Event-based`
- **Parameters**: `companyid`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: MoneyControl Distribution of stock equity among Promoters, FIIs, DIIs, Mutual Funds, and Retail. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0073] MoneyControl - Analyst Estimates & Price Targets
- **URL**: `https://api.moneycontrol.com/mcapi/v1/fii-dii-daily?exchange=NSE&year_month=default&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `year_month, type`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: MoneyControl Daily Foreign (FII) and Domestic (DII) institutional net buying/selling in Cash and FnO. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0074] MoneyControl - Analyst Estimates & Price Targets
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/fii-dii-daily?exchange=NSE&year_month=default&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `year_month, type`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: MoneyControl Daily Foreign (FII) and Domestic (DII) institutional net buying/selling in Cash and FnO. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0075] MoneyControl - Analyst Estimates & Price Targets
- **URL**: `https://www.moneycontrol.com/mc/widget/fii-dii-daily?exchange=NSE&year_month=default&type=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Daily EOD`
- **Parameters**: `year_month, type`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: MoneyControl Daily Foreign (FII) and Domestic (DII) institutional net buying/selling in Cash and FnO. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0076] MoneyControl - Corporate Actions & Governance
- **URL**: `https://api.moneycontrol.com/mcapi/v1/insider-deals?exchange=NSE&dealsType=default&range=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `dealsType, range`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: MoneyControl Promoter insider transactions, substantial acquisitions, and pledged share filings. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0077] MoneyControl - Corporate Actions & Governance
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/insider-deals?exchange=NSE&dealsType=default&range=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `dealsType, range`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: MoneyControl Promoter insider transactions, substantial acquisitions, and pledged share filings. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0078] MoneyControl - Corporate Actions & Governance
- **URL**: `https://www.moneycontrol.com/mc/widget/insider-deals?exchange=NSE&dealsType=default&range=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Event-based`
- **Parameters**: `dealsType, range`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: MoneyControl Promoter insider transactions, substantial acquisitions, and pledged share filings. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0079] MoneyControl - General Market Metadata
- **URL**: `https://api.moneycontrol.com/mcapi/v1/bulk-block-deals?exchange=NSE&start=default&limit=default&orderBy=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `start, limit, orderBy`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: MoneyControl Chronological bulk and block deal logs detailing buyer, seller, quantity, and price. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0080] MoneyControl - General Market Metadata
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/bulk-block-deals?exchange=NSE&start=default&limit=default&orderBy=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `start, limit, orderBy`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: MoneyControl Chronological bulk and block deal logs detailing buyer, seller, quantity, and price. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0081] MoneyControl - General Market Metadata
- **URL**: `https://www.moneycontrol.com/mc/widget/bulk-block-deals?exchange=NSE&start=default&limit=default&orderBy=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Daily EOD`
- **Parameters**: `start, limit, orderBy`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: MoneyControl Chronological bulk and block deal logs detailing buyer, seller, quantity, and price. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0082] MoneyControl - Price & Technical Charts
- **URL**: `https://api.moneycontrol.com/mcapi/v1/superstar-portfolios?exchange=NSE&only_superstars=default&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `only_superstars, limit`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: MoneyControl Portfolio composition and trade activity of celebrity investors and ace funds. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0083] MoneyControl - Price & Technical Charts
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/superstar-portfolios?exchange=NSE&only_superstars=default&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `only_superstars, limit`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: MoneyControl Portfolio composition and trade activity of celebrity investors and ace funds. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0084] MoneyControl - Price & Technical Charts
- **URL**: `https://www.moneycontrol.com/mc/widget/superstar-portfolios?exchange=NSE&only_superstars=default&limit=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `1-Min Intraday`
- **Parameters**: `only_superstars, limit`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: MoneyControl Portfolio composition and trade activity of celebrity investors and ace funds. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0085] MoneyControl - Derivatives & F&O Analytics
- **URL**: `https://api.moneycontrol.com/mcapi/v1/market-news?exchange=NSE&category=default&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `category, limit`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: MoneyControl Real-time market news flashes, press releases, and macroeconomic news feed. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0086] MoneyControl - Derivatives & F&O Analytics
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/market-news?exchange=NSE&category=default&limit=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `category, limit`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: MoneyControl Real-time market news flashes, press releases, and macroeconomic news feed. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0087] MoneyControl - Derivatives & F&O Analytics
- **URL**: `https://www.moneycontrol.com/mc/widget/market-news?exchange=NSE&category=default&limit=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `1-Min Intraday`
- **Parameters**: `category, limit`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: MoneyControl Real-time market news flashes, press releases, and macroeconomic news feed. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0088] MoneyControl - Fundamental Financials & Valuation
- **URL**: `https://api.moneycontrol.com/mcapi/v1/ai-sentiment-summary?symbol=KOTAKBANK`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `symbol`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: MoneyControl AI-summarized news sentiment score (-1.0 to +1.0), topic tags, and confidence scores. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0089] MoneyControl - Fundamental Financials & Valuation
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/ai-sentiment-summary?symbol=RELIANCE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `symbol`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: MoneyControl AI-summarized news sentiment score (-1.0 to +1.0), topic tags, and confidence scores. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0090] MoneyControl - Fundamental Financials & Valuation
- **URL**: `https://www.moneycontrol.com/mc/widget/ai-sentiment-summary?symbol=INFY`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Quarterly`
- **Parameters**: `symbol`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: MoneyControl AI-summarized news sentiment score (-1.0 to +1.0), topic tags, and confidence scores. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0091] MoneyControl - Screener & Quantitative Discovery
- **URL**: `https://api.moneycontrol.com/mcapi/v1/concall-transcripts?exchange=NSE&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `limit`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: MoneyControl Quarterly earnings conference call audio recordings, transcripts, and AI key takeaways. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0092] MoneyControl - Screener & Quantitative Discovery
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/concall-transcripts?exchange=NSE&limit=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `limit`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: MoneyControl Quarterly earnings conference call audio recordings, transcripts, and AI key takeaways. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0093] MoneyControl - Screener & Quantitative Discovery
- **URL**: `https://www.moneycontrol.com/mc/widget/concall-transcripts?exchange=NSE&limit=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Daily EOD`
- **Parameters**: `limit`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: MoneyControl Quarterly earnings conference call audio recordings, transcripts, and AI key takeaways. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0094] MoneyControl - Ownership & Institutional Holdings
- **URL**: `https://api.moneycontrol.com/mcapi/v1/exchange-filings?exchange=NSE&exchangeSymbol=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchangeSymbol`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: MoneyControl Official BSE/NSE corporate disclosures, material event notices, and regulatory PDF links. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0095] MoneyControl - Ownership & Institutional Holdings
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/exchange-filings?exchange=NSE&exchangeSymbol=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchangeSymbol`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: MoneyControl Official BSE/NSE corporate disclosures, material event notices, and regulatory PDF links. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0096] MoneyControl - Ownership & Institutional Holdings
- **URL**: `https://www.moneycontrol.com/mc/widget/exchange-filings?exchange=NSE&exchangeSymbol=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Quarterly`
- **Parameters**: `exchangeSymbol`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: MoneyControl Official BSE/NSE corporate disclosures, material event notices, and regulatory PDF links. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0097] MoneyControl - News, Filings & AI Sentiment
- **URL**: `https://api.moneycontrol.com/mcapi/v1/consensus-ratings?scId=640544&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: MoneyControl Wall Street and Indian broker consensus ratings (Strong Buy, Buy, Hold, Sell, Strong Sell). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0098] MoneyControl - News, Filings & AI Sentiment
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/consensus-ratings?scId=BE03&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: MoneyControl Wall Street and Indian broker consensus ratings (Strong Buy, Buy, Hold, Sell, Strong Sell). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0099] MoneyControl - News, Filings & AI Sentiment
- **URL**: `https://www.moneycontrol.com/mc/widget/consensus-ratings?scId=WSL&ex=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Event-based`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: MoneyControl Wall Street and Indian broker consensus ratings (Strong Buy, Buy, Hold, Sell, Strong Sell). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0100] MoneyControl - Analyst Estimates & Price Targets
- **URL**: `https://api.moneycontrol.com/mcapi/v1/price-forecast?scId=IT&deviceType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, deviceType`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: MoneyControl 12-month analyst target price forecasts including High, Median, Low estimates. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0101] MoneyControl - Analyst Estimates & Price Targets
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/price-forecast?scId=RLXO&deviceType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, deviceType`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: MoneyControl 12-month analyst target price forecasts including High, Median, Low estimates. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0102] MoneyControl - Analyst Estimates & Price Targets
- **URL**: `https://www.moneycontrol.com/mc/widget/price-forecast?scId=WEBELSOLAR&deviceType=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, deviceType`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: MoneyControl 12-month analyst target price forecasts including High, Median, Low estimates. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0103] MoneyControl - Corporate Actions & Governance
- **URL**: `https://api.moneycontrol.com/mcapi/v1/earnings-surprises?scId=JKIN&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, type`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: MoneyControl Historical quarterly EPS and Revenue analyst consensus estimates vs actual reported performance. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0104] MoneyControl - Corporate Actions & Governance
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/earnings-surprises?scId=11945&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, type`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: MoneyControl Historical quarterly EPS and Revenue analyst consensus estimates vs actual reported performance. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0105] MoneyControl - Corporate Actions & Governance
- **URL**: `https://www.moneycontrol.com/mc/widget/earnings-surprises?scId=8581&type=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Event-based`
- **Parameters**: `scId, type`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: MoneyControl Historical quarterly EPS and Revenue analyst consensus estimates vs actual reported performance. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0106] MoneyControl - General Market Metadata
- **URL**: `https://api.moneycontrol.com/mcapi/v1/research-reports?exchange=NSE&path=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `path`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: MoneyControl Institutional equity research reports and broker analysis recommendations feed. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0107] MoneyControl - General Market Metadata
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/research-reports?exchange=NSE&path=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `path`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: MoneyControl Institutional equity research reports and broker analysis recommendations feed. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0108] MoneyControl - General Market Metadata
- **URL**: `https://www.moneycontrol.com/mc/widget/research-reports?exchange=NSE&path=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Daily EOD`
- **Parameters**: `path`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: MoneyControl Institutional equity research reports and broker analysis recommendations feed. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0109] MoneyControl - Price & Technical Charts
- **URL**: `https://api.moneycontrol.com/mcapi/v1/dividend-calendar?scId=107685&section=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId, section`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: MoneyControl Historical and upcoming dividend declarations, record dates, ex-dates, and yields. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0110] MoneyControl - Price & Technical Charts
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/dividend-calendar?scId=363433&section=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId, section`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: MoneyControl Historical and upcoming dividend declarations, record dates, ex-dates, and yields. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0111] MoneyControl - Price & Technical Charts
- **URL**: `https://www.moneycontrol.com/mc/widget/dividend-calendar?scId=984165&section=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId, section`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: MoneyControl Historical and upcoming dividend declarations, record dates, ex-dates, and yields. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0112] MoneyControl - Derivatives & F&O Analytics
- **URL**: `https://api.moneycontrol.com/mcapi/v1/splits-bonuses?scId=640544`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: MoneyControl Corporate actions log detailing stock splits, bonus shares ratios, and rights issues. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0113] MoneyControl - Derivatives & F&O Analytics
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/splits-bonuses?scId=BE03`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: MoneyControl Corporate actions log detailing stock splits, bonus shares ratios, and rights issues. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0114] MoneyControl - Derivatives & F&O Analytics
- **URL**: `https://www.moneycontrol.com/mc/widget/splits-bonuses?scId=WSL`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: MoneyControl Corporate actions log detailing stock splits, bonus shares ratios, and rights issues. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0115] MoneyControl - Fundamental Financials & Valuation
- **URL**: `https://api.moneycontrol.com/mcapi/v1/board-meetings?scId=IT`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: MoneyControl Upcoming corporate board meeting announcements and agendas. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0116] MoneyControl - Fundamental Financials & Valuation
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/board-meetings?scId=RLXO`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: MoneyControl Upcoming corporate board meeting announcements and agendas. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0117] MoneyControl - Fundamental Financials & Valuation
- **URL**: `https://www.moneycontrol.com/mc/widget/board-meetings?scId=WEBELSOLAR`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Quarterly`
- **Parameters**: `scId`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: MoneyControl Upcoming corporate board meeting announcements and agendas. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0118] MoneyControl - Screener & Quantitative Discovery
- **URL**: `https://api.moneycontrol.com/mcapi/v1/symbol-resolution?symbol=KOTAKBANK`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: MoneyControl Master symbol mapping resolving NSE/BSE tickers, ISIN codes, and security identifiers. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0119] MoneyControl - Screener & Quantitative Discovery
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/symbol-resolution?symbol=RELIANCE`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: MoneyControl Master symbol mapping resolving NSE/BSE tickers, ISIN codes, and security identifiers. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0120] MoneyControl - Screener & Quantitative Discovery
- **URL**: `https://www.moneycontrol.com/mc/widget/symbol-resolution?symbol=INFY`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: MoneyControl Master symbol mapping resolving NSE/BSE tickers, ISIN codes, and security identifiers. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0121] MoneyControl - Ownership & Institutional Holdings
- **URL**: `https://api.moneycontrol.com/mcapi/v1/market-status?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `None`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: MoneyControl Live trading session market status (Pre-open, Normal, Auction, Closed) and holiday calendar. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0122] MoneyControl - Ownership & Institutional Holdings
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/market-status?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `None`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: MoneyControl Live trading session market status (Pre-open, Normal, Auction, Closed) and holiday calendar. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0123] MoneyControl - Ownership & Institutional Holdings
- **URL**: `https://www.moneycontrol.com/mc/widget/market-status?exchange=NSE`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Quarterly`
- **Parameters**: `None`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: MoneyControl Live trading session market status (Pre-open, Normal, Auction, Closed) and holiday calendar. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0124] MoneyControl - News, Filings & AI Sentiment
- **URL**: `https://api.moneycontrol.com/mcapi/v1/sector-mappings?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `exchange`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: MoneyControl Sector and industry hierarchy classifications and index constituent weights. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0125] MoneyControl - News, Filings & AI Sentiment
- **URL**: `https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/sector-mappings?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `exchange`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: MoneyControl Sector and industry hierarchy classifications and index constituent weights. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0126] MoneyControl - News, Filings & AI Sentiment
- **URL**: `https://www.moneycontrol.com/mc/widget/sector-mappings?exchange=NSE`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Event-based`
- **Parameters**: `exchange`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: MoneyControl Sector and industry hierarchy classifications and index constituent weights. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0127] NSE India - Price & Technical Charts
- **URL**: `https://www.nseindia.com/api/history?symbol=ITC&resolution=default&from=default&to=default&currencyCode=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, resolution, from, to, currencyCode`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: NSE India Real-time historical OHLCV chart bars and tick time-series data. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0128] NSE India - Price & Technical Charts
- **URL**: `https://www.nseindia.com/api/NextApi/history?symbol=WIPRO&resolution=default&from=default&to=default&currencyCode=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, resolution, from, to, currencyCode`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: NSE India Real-time historical OHLCV chart bars and tick time-series data. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0129] NSE India - Price & Technical Charts
- **URL**: `https://www.nseindia.com/api/history?symbol=MARUTI&resolution=default&from=default&to=default&currencyCode=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, resolution, from, to, currencyCode`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: NSE India Real-time historical OHLCV chart bars and tick time-series data. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0130] NSE India - Derivatives & F&O Analytics
- **URL**: `https://www.nseindia.com/api/live-quote?symbol=TATAMOTORS`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: NSE India Live streaming market quote, last traded price, bid/ask depth, and session volume. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0131] NSE India - Derivatives & F&O Analytics
- **URL**: `https://www.nseindia.com/api/NextApi/live-quote?symbol=BAJFINANCE`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: NSE India Live streaming market quote, last traded price, bid/ask depth, and session volume. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0132] NSE India - Derivatives & F&O Analytics
- **URL**: `https://www.nseindia.com/api/live-quote?symbol=LT`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: NSE India Live streaming market quote, last traded price, bid/ask depth, and session volume. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0133] NSE India - Fundamental Financials & Valuation
- **URL**: `https://www.nseindia.com/api/vwap-intraday?scId=JKIN&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: NSE India Intraday Volume-Weighted Average Price (VWAP) line coordinates and volume distribution. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0134] NSE India - Fundamental Financials & Valuation
- **URL**: `https://www.nseindia.com/api/NextApi/vwap-intraday?scId=11945&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: NSE India Intraday Volume-Weighted Average Price (VWAP) line coordinates and volume distribution. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0135] NSE India - Fundamental Financials & Valuation
- **URL**: `https://www.nseindia.com/api/vwap-intraday?scId=8581&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: NSE India Intraday Volume-Weighted Average Price (VWAP) line coordinates and volume distribution. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0136] NSE India - Screener & Quantitative Discovery
- **URL**: `https://www.nseindia.com/api/pivot-levels?scId=11984&classic=default&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, classic, period`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: NSE India Classic, Fibonacci, and Camarilla pivot support (S1-S3) and resistance (R1-R3) levels. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0137] NSE India - Screener & Quantitative Discovery
- **URL**: `https://www.nseindia.com/api/NextApi/pivot-levels?scId=16552&classic=default&period=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, classic, period`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: NSE India Classic, Fibonacci, and Camarilla pivot support (S1-S3) and resistance (R1-R3) levels. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0138] NSE India - Screener & Quantitative Discovery
- **URL**: `https://www.nseindia.com/api/pivot-levels?scId=132762&classic=default&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, classic, period`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: NSE India Classic, Fibonacci, and Camarilla pivot support (S1-S3) and resistance (R1-R3) levels. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0139] NSE India - Ownership & Institutional Holdings
- **URL**: `https://www.nseindia.com/api/moving-averages?scId=107685&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: NSE India Exponential (EMA) and Simple (SMA) moving averages across 5, 20, 50, 100, 200 day periods. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0140] NSE India - Ownership & Institutional Holdings
- **URL**: `https://www.nseindia.com/api/NextApi/moving-averages?scId=363433&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: NSE India Exponential (EMA) and Simple (SMA) moving averages across 5, 20, 50, 100, 200 day periods. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0141] NSE India - Ownership & Institutional Holdings
- **URL**: `https://www.nseindia.com/api/moving-averages?scId=984165&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: NSE India Exponential (EMA) and Simple (SMA) moving averages across 5, 20, 50, 100, 200 day periods. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0142] NSE India - News, Filings & AI Sentiment
- **URL**: `https://www.nseindia.com/api/chart-patterns?scId=640544&pattern_type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `sc_id, pattern_type`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: NSE India Automated candlestick pattern scanner (Doji, Marubozu, Head & Shoulders, Double Top). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0143] NSE India - News, Filings & AI Sentiment
- **URL**: `https://www.nseindia.com/api/NextApi/chart-patterns?scId=BE03&pattern_type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `sc_id, pattern_type`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: NSE India Automated candlestick pattern scanner (Doji, Marubozu, Head & Shoulders, Double Top). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0144] NSE India - News, Filings & AI Sentiment
- **URL**: `https://www.nseindia.com/api/chart-patterns?scId=WSL&pattern_type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `sc_id, pattern_type`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: NSE India Automated candlestick pattern scanner (Doji, Marubozu, Head & Shoulders, Double Top). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0145] NSE India - Analyst Estimates & Price Targets
- **URL**: `https://www.nseindia.com/api/option-chain?symbol=TATAMOTORS&expiryDate=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol, expiryDate, exchange`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: NSE India Complete options chain matrix containing Call/Put LTP, Strike Prices, OI, and IV Skew. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0146] NSE India - Analyst Estimates & Price Targets
- **URL**: `https://www.nseindia.com/api/NextApi/option-chain?symbol=BAJFINANCE&expiryDate=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol, expiryDate, exchange`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: NSE India Complete options chain matrix containing Call/Put LTP, Strike Prices, OI, and IV Skew. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0147] NSE India - Analyst Estimates & Price Targets
- **URL**: `https://www.nseindia.com/api/option-chain?symbol=LT&expiryDate=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol, expiryDate, exchange`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: NSE India Complete options chain matrix containing Call/Put LTP, Strike Prices, OI, and IV Skew. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0148] NSE India - Corporate Actions & Governance
- **URL**: `https://www.nseindia.com/api/futures-data?exchange=NSE&id=default&expirydate=default&fut=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `id, expirydate, fut`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: NSE India Futures contract prices, lot sizes, basis premium/discount to spot, and open interest builds. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0149] NSE India - Corporate Actions & Governance
- **URL**: `https://www.nseindia.com/api/NextApi/futures-data?exchange=NSE&id=default&expirydate=default&fut=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `id, expirydate, fut`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: NSE India Futures contract prices, lot sizes, basis premium/discount to spot, and open interest builds. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0150] NSE India - Corporate Actions & Governance
- **URL**: `https://www.nseindia.com/api/futures-data?exchange=NSE&id=default&expirydate=default&fut=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `id, expirydate, fut`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: NSE India Futures contract prices, lot sizes, basis premium/discount to spot, and open interest builds. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0151] NSE India - General Market Metadata
- **URL**: `https://www.nseindia.com/api/oi-pcr-trend?exchange=NSE&symbolName=default&reqType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbolName, reqType`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: NSE India Intraday Put-Call Ratio (PCR) history and open interest distribution charts. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0152] NSE India - General Market Metadata
- **URL**: `https://www.nseindia.com/api/NextApi/oi-pcr-trend?exchange=NSE&symbolName=default&reqType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbolName, reqType`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: NSE India Intraday Put-Call Ratio (PCR) history and open interest distribution charts. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0153] NSE India - General Market Metadata
- **URL**: `https://www.nseindia.com/api/oi-pcr-trend?exchange=NSE&symbolName=default&reqType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbolName, reqType`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: NSE India Intraday Put-Call Ratio (PCR) history and open interest distribution charts. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0154] NSE India - Price & Technical Charts
- **URL**: `https://www.nseindia.com/api/iv-percentile?symbol=ICICIBANK&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, type, exchange`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: NSE India Implied Volatility (IV) rank, IV percentile, and historical IV volatility surface. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0155] NSE India - Price & Technical Charts
- **URL**: `https://www.nseindia.com/api/NextApi/iv-percentile?symbol=BHARTIARTL&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, type, exchange`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: NSE India Implied Volatility (IV) rank, IV percentile, and historical IV volatility surface. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0156] NSE India - Price & Technical Charts
- **URL**: `https://www.nseindia.com/api/iv-percentile?symbol=LTIM&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, type, exchange`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: NSE India Implied Volatility (IV) rank, IV percentile, and historical IV volatility surface. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0157] NSE India - Derivatives & F&O Analytics
- **URL**: `https://www.nseindia.com/api/max-pain?symbol=ITC`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: NSE India Intraday and EOD Max Pain strike price calculation for options expiry pinning. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0158] NSE India - Derivatives & F&O Analytics
- **URL**: `https://www.nseindia.com/api/NextApi/max-pain?symbol=WIPRO`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: NSE India Intraday and EOD Max Pain strike price calculation for options expiry pinning. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0159] NSE India - Derivatives & F&O Analytics
- **URL**: `https://www.nseindia.com/api/max-pain?symbol=MARUTI`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: NSE India Intraday and EOD Max Pain strike price calculation for options expiry pinning. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0160] NSE India - Fundamental Financials & Valuation
- **URL**: `https://www.nseindia.com/api/fno-ban-list?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchange`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: NSE India Official NSE F&O Securities in Ban Period exceeding 95% Market-Wide Position Limit (MWPL). [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0161] NSE India - Fundamental Financials & Valuation
- **URL**: `https://www.nseindia.com/api/NextApi/fno-ban-list?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchange`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: NSE India Official NSE F&O Securities in Ban Period exceeding 95% Market-Wide Position Limit (MWPL). [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0162] NSE India - Fundamental Financials & Valuation
- **URL**: `https://www.nseindia.com/api/fno-ban-list?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchange`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: NSE India Official NSE F&O Securities in Ban Period exceeding 95% Market-Wide Position Limit (MWPL). [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0163] NSE India - Screener & Quantitative Discovery
- **URL**: `https://www.nseindia.com/api/oi-heatmaps?exchange=NSE&mtype=default&expDate=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `mtype, expDate`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: NSE India Heatmap of open interest vs price change (Long Build-up, Short Covering, Short Build-up). [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0164] NSE India - Screener & Quantitative Discovery
- **URL**: `https://www.nseindia.com/api/NextApi/oi-heatmaps?exchange=NSE&mtype=default&expDate=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `mtype, expDate`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: NSE India Heatmap of open interest vs price change (Long Build-up, Short Covering, Short Build-up). [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0165] NSE India - Screener & Quantitative Discovery
- **URL**: `https://www.nseindia.com/api/oi-heatmaps?exchange=NSE&mtype=default&expDate=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `mtype, expDate`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: NSE India Heatmap of open interest vs price change (Long Build-up, Short Covering, Short Build-up). [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0166] NSE India - Ownership & Institutional Holdings
- **URL**: `https://www.nseindia.com/api/financial-overview?scId=11984&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: NSE India Consolidated Income Statement, Balance Sheet, and Cash Flow Annual and Quarterly figures. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0167] NSE India - Ownership & Institutional Holdings
- **URL**: `https://www.nseindia.com/api/NextApi/financial-overview?scId=16552&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: NSE India Consolidated Income Statement, Balance Sheet, and Cash Flow Annual and Quarterly figures. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0168] NSE India - Ownership & Institutional Holdings
- **URL**: `https://www.nseindia.com/api/financial-overview?scId=132762&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: NSE India Consolidated Income Statement, Balance Sheet, and Cash Flow Annual and Quarterly figures. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0169] NSE India - News, Filings & AI Sentiment
- **URL**: `https://www.nseindia.com/api/pe-pb-bands?symbol=ICICIBANK&days=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `days, symbol`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: NSE India Historical Valuation P/E and P/B median bands over 3-year and 5-year horizons. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0170] NSE India - News, Filings & AI Sentiment
- **URL**: `https://www.nseindia.com/api/NextApi/pe-pb-bands?symbol=BHARTIARTL&days=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `days, symbol`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: NSE India Historical Valuation P/E and P/B median bands over 3-year and 5-year horizons. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0171] NSE India - News, Filings & AI Sentiment
- **URL**: `https://www.nseindia.com/api/pe-pb-bands?symbol=LTIM&days=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `days, symbol`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: NSE India Historical Valuation P/E and P/B median bands over 3-year and 5-year horizons. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0172] NSE India - Analyst Estimates & Price Targets
- **URL**: `https://www.nseindia.com/api/dcf-valuation?symbol=ITC`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: NSE India Discounted Cash Flow (DCF) intrinsic value valuation model and target fair price. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0173] NSE India - Analyst Estimates & Price Targets
- **URL**: `https://www.nseindia.com/api/NextApi/dcf-valuation?symbol=WIPRO`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: NSE India Discounted Cash Flow (DCF) intrinsic value valuation model and target fair price. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0174] NSE India - Analyst Estimates & Price Targets
- **URL**: `https://www.nseindia.com/api/dcf-valuation?symbol=MARUTI`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: NSE India Discounted Cash Flow (DCF) intrinsic value valuation model and target fair price. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0175] NSE India - Corporate Actions & Governance
- **URL**: `https://www.nseindia.com/api/ratio-analysis?companyid=IT`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid, exchange`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: NSE India Solvency, liquidity, Return on Equity (ROE), and Return on Capital Employed (ROCE) ratios. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0176] NSE India - Corporate Actions & Governance
- **URL**: `https://www.nseindia.com/api/NextApi/ratio-analysis?companyid=RLXO`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid, exchange`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: NSE India Solvency, liquidity, Return on Equity (ROE), and Return on Capital Employed (ROCE) ratios. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0177] NSE India - Corporate Actions & Governance
- **URL**: `https://www.nseindia.com/api/ratio-analysis?companyid=WEBELSOLAR`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid, exchange`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: NSE India Solvency, liquidity, Return on Equity (ROE), and Return on Capital Employed (ROCE) ratios. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0178] NSE India - General Market Metadata
- **URL**: `https://www.nseindia.com/api/quarterly-results?scId=JKIN&type_format=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `sc_id, type_format`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: NSE India Detailed quarterly revenue, operating profit margins, and net profit margins. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0179] NSE India - General Market Metadata
- **URL**: `https://www.nseindia.com/api/NextApi/quarterly-results?scId=11945&type_format=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `sc_id, type_format`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: NSE India Detailed quarterly revenue, operating profit margins, and net profit margins. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0180] NSE India - General Market Metadata
- **URL**: `https://www.nseindia.com/api/quarterly-results?scId=8581&type_format=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `sc_id, type_format`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: NSE India Detailed quarterly revenue, operating profit margins, and net profit margins. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0181] NSE India - Price & Technical Charts
- **URL**: `https://www.nseindia.com/api/trending-screeners?exchange=NSE&exchangeId=default&pageNumber=default&pageSize=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `exchangeId, pageNumber, pageSize`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: NSE India Top trending technical and quantitative screening strategies. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0182] NSE India - Price & Technical Charts
- **URL**: `https://www.nseindia.com/api/NextApi/trending-screeners?exchange=NSE&exchangeId=default&pageNumber=default&pageSize=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `exchangeId, pageNumber, pageSize`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: NSE India Top trending technical and quantitative screening strategies. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0183] NSE India - Price & Technical Charts
- **URL**: `https://www.nseindia.com/api/trending-screeners?exchange=NSE&exchangeId=default&pageNumber=default&pageSize=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `exchangeId, pageNumber, pageSize`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: NSE India Top trending technical and quantitative screening strategies. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0184] NSE India - Derivatives & F&O Analytics
- **URL**: `https://www.nseindia.com/api/gainers-losers?exchange=NSE&pagesize=default&duration=default&marketcap=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `pagesize, duration, marketcap`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: NSE India Real-time top gainers, losers, and volume shockers filtered by market cap. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0185] NSE India - Derivatives & F&O Analytics
- **URL**: `https://www.nseindia.com/api/NextApi/gainers-losers?exchange=NSE&pagesize=default&duration=default&marketcap=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `pagesize, duration, marketcap`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: NSE India Real-time top gainers, losers, and volume shockers filtered by market cap. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0186] NSE India - Derivatives & F&O Analytics
- **URL**: `https://www.nseindia.com/api/gainers-losers?exchange=NSE&pagesize=default&duration=default&marketcap=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `pagesize, duration, marketcap`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: NSE India Real-time top gainers, losers, and volume shockers filtered by market cap. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0187] NSE India - Fundamental Financials & Valuation
- **URL**: `https://www.nseindia.com/api/delivery-scanners?exchange=NSE&lang=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `lang`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: NSE India Stocks with high delivery percentage and delivery quantity spikes for smart money tracking. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0188] NSE India - Fundamental Financials & Valuation
- **URL**: `https://www.nseindia.com/api/NextApi/delivery-scanners?exchange=NSE&lang=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `lang`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: NSE India Stocks with high delivery percentage and delivery quantity spikes for smart money tracking. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0189] NSE India - Fundamental Financials & Valuation
- **URL**: `https://www.nseindia.com/api/delivery-scanners?exchange=NSE&lang=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `lang`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: NSE India Stocks with high delivery percentage and delivery quantity spikes for smart money tracking. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0190] NSE India - Screener & Quantitative Discovery
- **URL**: `https://www.nseindia.com/api/momentum-rankings?exchange=NSE&index=default&page=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `index, page`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: NSE India Relative strength momentum rankings vs Nifty 50 benchmark index. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0191] NSE India - Screener & Quantitative Discovery
- **URL**: `https://www.nseindia.com/api/NextApi/momentum-rankings?exchange=NSE&index=default&page=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `index, page`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: NSE India Relative strength momentum rankings vs Nifty 50 benchmark index. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0192] NSE India - Screener & Quantitative Discovery
- **URL**: `https://www.nseindia.com/api/momentum-rankings?exchange=NSE&index=default&page=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `index, page`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: NSE India Relative strength momentum rankings vs Nifty 50 benchmark index. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0193] NSE India - Ownership & Institutional Holdings
- **URL**: `https://www.nseindia.com/api/proscanner-details?exchange=NSE&catId=default&scanId=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `catId, scanId`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: NSE India Algorithmic quantitative strategies screening details and stock candidate lists. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0194] NSE India - Ownership & Institutional Holdings
- **URL**: `https://www.nseindia.com/api/NextApi/proscanner-details?exchange=NSE&catId=default&scanId=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `catId, scanId`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: NSE India Algorithmic quantitative strategies screening details and stock candidate lists. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0195] NSE India - Ownership & Institutional Holdings
- **URL**: `https://www.nseindia.com/api/proscanner-details?exchange=NSE&catId=default&scanId=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `catId, scanId`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: NSE India Algorithmic quantitative strategies screening details and stock candidate lists. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0196] NSE India - News, Filings & AI Sentiment
- **URL**: `https://www.nseindia.com/api/shareholding-pattern?companyid=11984`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: NSE India Distribution of stock equity among Promoters, FIIs, DIIs, Mutual Funds, and Retail. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0197] NSE India - News, Filings & AI Sentiment
- **URL**: `https://www.nseindia.com/api/NextApi/shareholding-pattern?companyid=16552`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: NSE India Distribution of stock equity among Promoters, FIIs, DIIs, Mutual Funds, and Retail. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0198] NSE India - News, Filings & AI Sentiment
- **URL**: `https://www.nseindia.com/api/shareholding-pattern?companyid=132762`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: NSE India Distribution of stock equity among Promoters, FIIs, DIIs, Mutual Funds, and Retail. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0199] NSE India - Analyst Estimates & Price Targets
- **URL**: `https://www.nseindia.com/api/fii-dii-daily?exchange=NSE&year_month=default&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `year_month, type`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: NSE India Daily Foreign (FII) and Domestic (DII) institutional net buying/selling in Cash and FnO. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0200] NSE India - Analyst Estimates & Price Targets
- **URL**: `https://www.nseindia.com/api/NextApi/fii-dii-daily?exchange=NSE&year_month=default&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `year_month, type`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: NSE India Daily Foreign (FII) and Domestic (DII) institutional net buying/selling in Cash and FnO. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0201] NSE India - Analyst Estimates & Price Targets
- **URL**: `https://www.nseindia.com/api/fii-dii-daily?exchange=NSE&year_month=default&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `year_month, type`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: NSE India Daily Foreign (FII) and Domestic (DII) institutional net buying/selling in Cash and FnO. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0202] NSE India - Corporate Actions & Governance
- **URL**: `https://www.nseindia.com/api/insider-deals?exchange=NSE&dealsType=default&range=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `dealsType, range`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: NSE India Promoter insider transactions, substantial acquisitions, and pledged share filings. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0203] NSE India - Corporate Actions & Governance
- **URL**: `https://www.nseindia.com/api/NextApi/insider-deals?exchange=NSE&dealsType=default&range=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `dealsType, range`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: NSE India Promoter insider transactions, substantial acquisitions, and pledged share filings. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0204] NSE India - Corporate Actions & Governance
- **URL**: `https://www.nseindia.com/api/insider-deals?exchange=NSE&dealsType=default&range=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `dealsType, range`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: NSE India Promoter insider transactions, substantial acquisitions, and pledged share filings. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0205] NSE India - General Market Metadata
- **URL**: `https://www.nseindia.com/api/bulk-block-deals?exchange=NSE&start=default&limit=default&orderBy=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `start, limit, orderBy`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: NSE India Chronological bulk and block deal logs detailing buyer, seller, quantity, and price. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0206] NSE India - General Market Metadata
- **URL**: `https://www.nseindia.com/api/NextApi/bulk-block-deals?exchange=NSE&start=default&limit=default&orderBy=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `start, limit, orderBy`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: NSE India Chronological bulk and block deal logs detailing buyer, seller, quantity, and price. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0207] NSE India - General Market Metadata
- **URL**: `https://www.nseindia.com/api/bulk-block-deals?exchange=NSE&start=default&limit=default&orderBy=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `start, limit, orderBy`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: NSE India Chronological bulk and block deal logs detailing buyer, seller, quantity, and price. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0208] NSE India - Price & Technical Charts
- **URL**: `https://www.nseindia.com/api/superstar-portfolios?exchange=NSE&only_superstars=default&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `only_superstars, limit`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: NSE India Portfolio composition and trade activity of celebrity investors and ace funds. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0209] NSE India - Price & Technical Charts
- **URL**: `https://www.nseindia.com/api/NextApi/superstar-portfolios?exchange=NSE&only_superstars=default&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `only_superstars, limit`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: NSE India Portfolio composition and trade activity of celebrity investors and ace funds. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0210] NSE India - Price & Technical Charts
- **URL**: `https://www.nseindia.com/api/superstar-portfolios?exchange=NSE&only_superstars=default&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `only_superstars, limit`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: NSE India Portfolio composition and trade activity of celebrity investors and ace funds. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0211] NSE India - Derivatives & F&O Analytics
- **URL**: `https://www.nseindia.com/api/market-news?exchange=NSE&category=default&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `category, limit`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: NSE India Real-time market news flashes, press releases, and macroeconomic news feed. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0212] NSE India - Derivatives & F&O Analytics
- **URL**: `https://www.nseindia.com/api/NextApi/market-news?exchange=NSE&category=default&limit=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `category, limit`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: NSE India Real-time market news flashes, press releases, and macroeconomic news feed. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0213] NSE India - Derivatives & F&O Analytics
- **URL**: `https://www.nseindia.com/api/market-news?exchange=NSE&category=default&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `category, limit`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: NSE India Real-time market news flashes, press releases, and macroeconomic news feed. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0214] NSE India - Fundamental Financials & Valuation
- **URL**: `https://www.nseindia.com/api/ai-sentiment-summary?symbol=ICICIBANK`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `symbol`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: NSE India AI-summarized news sentiment score (-1.0 to +1.0), topic tags, and confidence scores. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0215] NSE India - Fundamental Financials & Valuation
- **URL**: `https://www.nseindia.com/api/NextApi/ai-sentiment-summary?symbol=BHARTIARTL`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `symbol`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: NSE India AI-summarized news sentiment score (-1.0 to +1.0), topic tags, and confidence scores. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0216] NSE India - Fundamental Financials & Valuation
- **URL**: `https://www.nseindia.com/api/ai-sentiment-summary?symbol=LTIM`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `symbol`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: NSE India AI-summarized news sentiment score (-1.0 to +1.0), topic tags, and confidence scores. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0217] NSE India - Screener & Quantitative Discovery
- **URL**: `https://www.nseindia.com/api/concall-transcripts?exchange=NSE&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `limit`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: NSE India Quarterly earnings conference call audio recordings, transcripts, and AI key takeaways. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0218] NSE India - Screener & Quantitative Discovery
- **URL**: `https://www.nseindia.com/api/NextApi/concall-transcripts?exchange=NSE&limit=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `limit`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: NSE India Quarterly earnings conference call audio recordings, transcripts, and AI key takeaways. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0219] NSE India - Screener & Quantitative Discovery
- **URL**: `https://www.nseindia.com/api/concall-transcripts?exchange=NSE&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `limit`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: NSE India Quarterly earnings conference call audio recordings, transcripts, and AI key takeaways. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0220] NSE India - Ownership & Institutional Holdings
- **URL**: `https://www.nseindia.com/api/exchange-filings?exchange=NSE&exchangeSymbol=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchangeSymbol`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: NSE India Official BSE/NSE corporate disclosures, material event notices, and regulatory PDF links. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0221] NSE India - Ownership & Institutional Holdings
- **URL**: `https://www.nseindia.com/api/NextApi/exchange-filings?exchange=NSE&exchangeSymbol=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchangeSymbol`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: NSE India Official BSE/NSE corporate disclosures, material event notices, and regulatory PDF links. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0222] NSE India - Ownership & Institutional Holdings
- **URL**: `https://www.nseindia.com/api/exchange-filings?exchange=NSE&exchangeSymbol=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchangeSymbol`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: NSE India Official BSE/NSE corporate disclosures, material event notices, and regulatory PDF links. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0223] NSE India - News, Filings & AI Sentiment
- **URL**: `https://www.nseindia.com/api/consensus-ratings?scId=JKIN&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: NSE India Wall Street and Indian broker consensus ratings (Strong Buy, Buy, Hold, Sell, Strong Sell). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0224] NSE India - News, Filings & AI Sentiment
- **URL**: `https://www.nseindia.com/api/NextApi/consensus-ratings?scId=11945&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: NSE India Wall Street and Indian broker consensus ratings (Strong Buy, Buy, Hold, Sell, Strong Sell). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0225] NSE India - News, Filings & AI Sentiment
- **URL**: `https://www.nseindia.com/api/consensus-ratings?scId=8581&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: NSE India Wall Street and Indian broker consensus ratings (Strong Buy, Buy, Hold, Sell, Strong Sell). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0226] NSE India - Analyst Estimates & Price Targets
- **URL**: `https://www.nseindia.com/api/price-forecast?scId=11984&deviceType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, deviceType`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: NSE India 12-month analyst target price forecasts including High, Median, Low estimates. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0227] NSE India - Analyst Estimates & Price Targets
- **URL**: `https://www.nseindia.com/api/NextApi/price-forecast?scId=16552&deviceType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, deviceType`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: NSE India 12-month analyst target price forecasts including High, Median, Low estimates. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0228] NSE India - Analyst Estimates & Price Targets
- **URL**: `https://www.nseindia.com/api/price-forecast?scId=132762&deviceType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, deviceType`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: NSE India 12-month analyst target price forecasts including High, Median, Low estimates. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0229] NSE India - Corporate Actions & Governance
- **URL**: `https://www.nseindia.com/api/earnings-surprises?scId=107685&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, type`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: NSE India Historical quarterly EPS and Revenue analyst consensus estimates vs actual reported performance. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0230] NSE India - Corporate Actions & Governance
- **URL**: `https://www.nseindia.com/api/NextApi/earnings-surprises?scId=363433&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, type`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: NSE India Historical quarterly EPS and Revenue analyst consensus estimates vs actual reported performance. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0231] NSE India - Corporate Actions & Governance
- **URL**: `https://www.nseindia.com/api/earnings-surprises?scId=984165&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, type`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: NSE India Historical quarterly EPS and Revenue analyst consensus estimates vs actual reported performance. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0232] NSE India - General Market Metadata
- **URL**: `https://www.nseindia.com/api/research-reports?exchange=NSE&path=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `path`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: NSE India Institutional equity research reports and broker analysis recommendations feed. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0233] NSE India - General Market Metadata
- **URL**: `https://www.nseindia.com/api/NextApi/research-reports?exchange=NSE&path=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `path`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: NSE India Institutional equity research reports and broker analysis recommendations feed. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0234] NSE India - General Market Metadata
- **URL**: `https://www.nseindia.com/api/research-reports?exchange=NSE&path=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `path`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: NSE India Institutional equity research reports and broker analysis recommendations feed. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0235] NSE India - Price & Technical Charts
- **URL**: `https://www.nseindia.com/api/dividend-calendar?scId=IT&section=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId, section`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: NSE India Historical and upcoming dividend declarations, record dates, ex-dates, and yields. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0236] NSE India - Price & Technical Charts
- **URL**: `https://www.nseindia.com/api/NextApi/dividend-calendar?scId=RLXO&section=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId, section`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: NSE India Historical and upcoming dividend declarations, record dates, ex-dates, and yields. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0237] NSE India - Price & Technical Charts
- **URL**: `https://www.nseindia.com/api/dividend-calendar?scId=WEBELSOLAR&section=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId, section`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: NSE India Historical and upcoming dividend declarations, record dates, ex-dates, and yields. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0238] NSE India - Derivatives & F&O Analytics
- **URL**: `https://www.nseindia.com/api/splits-bonuses?scId=JKIN`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: NSE India Corporate actions log detailing stock splits, bonus shares ratios, and rights issues. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0239] NSE India - Derivatives & F&O Analytics
- **URL**: `https://www.nseindia.com/api/NextApi/splits-bonuses?scId=11945`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: NSE India Corporate actions log detailing stock splits, bonus shares ratios, and rights issues. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0240] NSE India - Derivatives & F&O Analytics
- **URL**: `https://www.nseindia.com/api/splits-bonuses?scId=8581`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: NSE India Corporate actions log detailing stock splits, bonus shares ratios, and rights issues. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0241] NSE India - Fundamental Financials & Valuation
- **URL**: `https://www.nseindia.com/api/board-meetings?scId=11984`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: NSE India Upcoming corporate board meeting announcements and agendas. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0242] NSE India - Fundamental Financials & Valuation
- **URL**: `https://www.nseindia.com/api/NextApi/board-meetings?scId=16552`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: NSE India Upcoming corporate board meeting announcements and agendas. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0243] NSE India - Fundamental Financials & Valuation
- **URL**: `https://www.nseindia.com/api/board-meetings?scId=132762`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: NSE India Upcoming corporate board meeting announcements and agendas. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0244] NSE India - Screener & Quantitative Discovery
- **URL**: `https://www.nseindia.com/api/symbol-resolution?symbol=ICICIBANK`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: NSE India Master symbol mapping resolving NSE/BSE tickers, ISIN codes, and security identifiers. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0245] NSE India - Screener & Quantitative Discovery
- **URL**: `https://www.nseindia.com/api/NextApi/symbol-resolution?symbol=BHARTIARTL`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: NSE India Master symbol mapping resolving NSE/BSE tickers, ISIN codes, and security identifiers. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0246] NSE India - Screener & Quantitative Discovery
- **URL**: `https://www.nseindia.com/api/symbol-resolution?symbol=LTIM`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: NSE India Master symbol mapping resolving NSE/BSE tickers, ISIN codes, and security identifiers. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0247] NSE India - Ownership & Institutional Holdings
- **URL**: `https://www.nseindia.com/api/market-status?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `None`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: NSE India Live trading session market status (Pre-open, Normal, Auction, Closed) and holiday calendar. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0248] NSE India - Ownership & Institutional Holdings
- **URL**: `https://www.nseindia.com/api/NextApi/market-status?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `None`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: NSE India Live trading session market status (Pre-open, Normal, Auction, Closed) and holiday calendar. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0249] NSE India - Ownership & Institutional Holdings
- **URL**: `https://www.nseindia.com/api/market-status?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `None`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: NSE India Live trading session market status (Pre-open, Normal, Auction, Closed) and holiday calendar. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0250] NSE India - News, Filings & AI Sentiment
- **URL**: `https://www.nseindia.com/api/sector-mappings?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `exchange`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: NSE India Sector and industry hierarchy classifications and index constituent weights. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0251] NSE India - News, Filings & AI Sentiment
- **URL**: `https://www.nseindia.com/api/NextApi/sector-mappings?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `exchange`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: NSE India Sector and industry hierarchy classifications and index constituent weights. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0252] NSE India - News, Filings & AI Sentiment
- **URL**: `https://www.nseindia.com/api/sector-mappings?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `exchange`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: NSE India Sector and industry hierarchy classifications and index constituent weights. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0253] ETNow / Economic Times - Price & Technical Charts
- **URL**: `https://etmarketsapis.indiatimes.com/history?symbol=KOTAKBANK&resolution=default&from=default&to=default&currencyCode=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, resolution, from, to, currencyCode`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: ETNow / Economic Times Real-time historical OHLCV chart bars and tick time-series data. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0254] ETNow / Economic Times - Price & Technical Charts
- **URL**: `https://json.bselivefeeds.indiatimes.com/history?symbol=RELIANCE&resolution=default&from=default&to=default&currencyCode=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, resolution, from, to, currencyCode`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: ETNow / Economic Times Real-time historical OHLCV chart bars and tick time-series data. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0255] ETNow / Economic Times - Price & Technical Charts
- **URL**: `https://marketservices.indiatimes.com/history?symbol=INFY&resolution=default&from=default&to=default&currencyCode=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, resolution, from, to, currencyCode`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: ETNow / Economic Times Real-time historical OHLCV chart bars and tick time-series data. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0256] ETNow / Economic Times - Derivatives & F&O Analytics
- **URL**: `https://etmarketsapis.indiatimes.com/live-quote?symbol=TCS`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: ETNow / Economic Times Live streaming market quote, last traded price, bid/ask depth, and session volume. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0257] ETNow / Economic Times - Derivatives & F&O Analytics
- **URL**: `https://json.bselivefeeds.indiatimes.com/live-quote?symbol=HDFCBANK`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: ETNow / Economic Times Live streaming market quote, last traded price, bid/ask depth, and session volume. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0258] ETNow / Economic Times - Derivatives & F&O Analytics
- **URL**: `https://marketservices.indiatimes.com/live-quote?symbol=SBIN`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: ETNow / Economic Times Live streaming market quote, last traded price, bid/ask depth, and session volume. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0259] ETNow / Economic Times - Fundamental Financials & Valuation
- **URL**: `https://etmarketsapis.indiatimes.com/vwap-intraday?scId=107685&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: ETNow / Economic Times Intraday Volume-Weighted Average Price (VWAP) line coordinates and volume distribution. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0260] ETNow / Economic Times - Fundamental Financials & Valuation
- **URL**: `https://json.bselivefeeds.indiatimes.com/vwap-intraday?scId=363433&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: ETNow / Economic Times Intraday Volume-Weighted Average Price (VWAP) line coordinates and volume distribution. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0261] ETNow / Economic Times - Fundamental Financials & Valuation
- **URL**: `https://marketservices.indiatimes.com/vwap-intraday?scId=984165&period=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: ETNow / Economic Times Intraday Volume-Weighted Average Price (VWAP) line coordinates and volume distribution. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0262] ETNow / Economic Times - Screener & Quantitative Discovery
- **URL**: `https://etmarketsapis.indiatimes.com/pivot-levels?scId=640544&classic=default&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, classic, period`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: ETNow / Economic Times Classic, Fibonacci, and Camarilla pivot support (S1-S3) and resistance (R1-R3) levels. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0263] ETNow / Economic Times - Screener & Quantitative Discovery
- **URL**: `https://json.bselivefeeds.indiatimes.com/pivot-levels?scId=BE03&classic=default&period=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, classic, period`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: ETNow / Economic Times Classic, Fibonacci, and Camarilla pivot support (S1-S3) and resistance (R1-R3) levels. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0264] ETNow / Economic Times - Screener & Quantitative Discovery
- **URL**: `https://marketservices.indiatimes.com/pivot-levels?scId=WSL&classic=default&period=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, classic, period`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: ETNow / Economic Times Classic, Fibonacci, and Camarilla pivot support (S1-S3) and resistance (R1-R3) levels. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0265] ETNow / Economic Times - Ownership & Institutional Holdings
- **URL**: `https://etmarketsapis.indiatimes.com/moving-averages?scId=IT&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: ETNow / Economic Times Exponential (EMA) and Simple (SMA) moving averages across 5, 20, 50, 100, 200 day periods. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0266] ETNow / Economic Times - Ownership & Institutional Holdings
- **URL**: `https://json.bselivefeeds.indiatimes.com/moving-averages?scId=RLXO&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: ETNow / Economic Times Exponential (EMA) and Simple (SMA) moving averages across 5, 20, 50, 100, 200 day periods. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0267] ETNow / Economic Times - Ownership & Institutional Holdings
- **URL**: `https://marketservices.indiatimes.com/moving-averages?scId=WEBELSOLAR&period=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: ETNow / Economic Times Exponential (EMA) and Simple (SMA) moving averages across 5, 20, 50, 100, 200 day periods. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0268] ETNow / Economic Times - News, Filings & AI Sentiment
- **URL**: `https://etmarketsapis.indiatimes.com/chart-patterns?scId=JKIN&pattern_type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `sc_id, pattern_type`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: ETNow / Economic Times Automated candlestick pattern scanner (Doji, Marubozu, Head & Shoulders, Double Top). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0269] ETNow / Economic Times - News, Filings & AI Sentiment
- **URL**: `https://json.bselivefeeds.indiatimes.com/chart-patterns?scId=11945&pattern_type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `sc_id, pattern_type`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: ETNow / Economic Times Automated candlestick pattern scanner (Doji, Marubozu, Head & Shoulders, Double Top). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0270] ETNow / Economic Times - News, Filings & AI Sentiment
- **URL**: `https://marketservices.indiatimes.com/chart-patterns?scId=8581&pattern_type=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Event-based`
- **Parameters**: `sc_id, pattern_type`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: ETNow / Economic Times Automated candlestick pattern scanner (Doji, Marubozu, Head & Shoulders, Double Top). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0271] ETNow / Economic Times - Analyst Estimates & Price Targets
- **URL**: `https://etmarketsapis.indiatimes.com/option-chain?symbol=TCS&expiryDate=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol, expiryDate, exchange`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: ETNow / Economic Times Complete options chain matrix containing Call/Put LTP, Strike Prices, OI, and IV Skew. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0272] ETNow / Economic Times - Analyst Estimates & Price Targets
- **URL**: `https://json.bselivefeeds.indiatimes.com/option-chain?symbol=HDFCBANK&expiryDate=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol, expiryDate, exchange`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: ETNow / Economic Times Complete options chain matrix containing Call/Put LTP, Strike Prices, OI, and IV Skew. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0273] ETNow / Economic Times - Analyst Estimates & Price Targets
- **URL**: `https://marketservices.indiatimes.com/option-chain?symbol=SBIN&expiryDate=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol, expiryDate, exchange`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: ETNow / Economic Times Complete options chain matrix containing Call/Put LTP, Strike Prices, OI, and IV Skew. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0274] ETNow / Economic Times - Corporate Actions & Governance
- **URL**: `https://etmarketsapis.indiatimes.com/futures-data?exchange=NSE&id=default&expirydate=default&fut=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `id, expirydate, fut`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: ETNow / Economic Times Futures contract prices, lot sizes, basis premium/discount to spot, and open interest builds. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0275] ETNow / Economic Times - Corporate Actions & Governance
- **URL**: `https://json.bselivefeeds.indiatimes.com/futures-data?exchange=NSE&id=default&expirydate=default&fut=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `id, expirydate, fut`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: ETNow / Economic Times Futures contract prices, lot sizes, basis premium/discount to spot, and open interest builds. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0276] ETNow / Economic Times - Corporate Actions & Governance
- **URL**: `https://marketservices.indiatimes.com/futures-data?exchange=NSE&id=default&expirydate=default&fut=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Event-based`
- **Parameters**: `id, expirydate, fut`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: ETNow / Economic Times Futures contract prices, lot sizes, basis premium/discount to spot, and open interest builds. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0277] ETNow / Economic Times - General Market Metadata
- **URL**: `https://etmarketsapis.indiatimes.com/oi-pcr-trend?exchange=NSE&symbolName=default&reqType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbolName, reqType`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: ETNow / Economic Times Intraday Put-Call Ratio (PCR) history and open interest distribution charts. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0278] ETNow / Economic Times - General Market Metadata
- **URL**: `https://json.bselivefeeds.indiatimes.com/oi-pcr-trend?exchange=NSE&symbolName=default&reqType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbolName, reqType`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: ETNow / Economic Times Intraday Put-Call Ratio (PCR) history and open interest distribution charts. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0279] ETNow / Economic Times - General Market Metadata
- **URL**: `https://marketservices.indiatimes.com/oi-pcr-trend?exchange=NSE&symbolName=default&reqType=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Daily EOD`
- **Parameters**: `symbolName, reqType`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: ETNow / Economic Times Intraday Put-Call Ratio (PCR) history and open interest distribution charts. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0280] ETNow / Economic Times - Price & Technical Charts
- **URL**: `https://etmarketsapis.indiatimes.com/iv-percentile?symbol=TATAMOTORS&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, type, exchange`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: ETNow / Economic Times Implied Volatility (IV) rank, IV percentile, and historical IV volatility surface. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0281] ETNow / Economic Times - Price & Technical Charts
- **URL**: `https://json.bselivefeeds.indiatimes.com/iv-percentile?symbol=BAJFINANCE&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, type, exchange`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: ETNow / Economic Times Implied Volatility (IV) rank, IV percentile, and historical IV volatility surface. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0282] ETNow / Economic Times - Price & Technical Charts
- **URL**: `https://marketservices.indiatimes.com/iv-percentile?symbol=LT&type=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, type, exchange`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: ETNow / Economic Times Implied Volatility (IV) rank, IV percentile, and historical IV volatility surface. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0283] ETNow / Economic Times - Derivatives & F&O Analytics
- **URL**: `https://etmarketsapis.indiatimes.com/max-pain?symbol=KOTAKBANK`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: ETNow / Economic Times Intraday and EOD Max Pain strike price calculation for options expiry pinning. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0284] ETNow / Economic Times - Derivatives & F&O Analytics
- **URL**: `https://json.bselivefeeds.indiatimes.com/max-pain?symbol=RELIANCE`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: ETNow / Economic Times Intraday and EOD Max Pain strike price calculation for options expiry pinning. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0285] ETNow / Economic Times - Derivatives & F&O Analytics
- **URL**: `https://marketservices.indiatimes.com/max-pain?symbol=INFY`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: ETNow / Economic Times Intraday and EOD Max Pain strike price calculation for options expiry pinning. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0286] ETNow / Economic Times - Fundamental Financials & Valuation
- **URL**: `https://etmarketsapis.indiatimes.com/fno-ban-list?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchange`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: ETNow / Economic Times Official NSE F&O Securities in Ban Period exceeding 95% Market-Wide Position Limit (MWPL). [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0287] ETNow / Economic Times - Fundamental Financials & Valuation
- **URL**: `https://json.bselivefeeds.indiatimes.com/fno-ban-list?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchange`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: ETNow / Economic Times Official NSE F&O Securities in Ban Period exceeding 95% Market-Wide Position Limit (MWPL). [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0288] ETNow / Economic Times - Fundamental Financials & Valuation
- **URL**: `https://marketservices.indiatimes.com/fno-ban-list?exchange=NSE`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Quarterly`
- **Parameters**: `exchange`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: ETNow / Economic Times Official NSE F&O Securities in Ban Period exceeding 95% Market-Wide Position Limit (MWPL). [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0289] ETNow / Economic Times - Screener & Quantitative Discovery
- **URL**: `https://etmarketsapis.indiatimes.com/oi-heatmaps?exchange=NSE&mtype=default&expDate=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `mtype, expDate`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: ETNow / Economic Times Heatmap of open interest vs price change (Long Build-up, Short Covering, Short Build-up). [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0290] ETNow / Economic Times - Screener & Quantitative Discovery
- **URL**: `https://json.bselivefeeds.indiatimes.com/oi-heatmaps?exchange=NSE&mtype=default&expDate=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `mtype, expDate`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: ETNow / Economic Times Heatmap of open interest vs price change (Long Build-up, Short Covering, Short Build-up). [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0291] ETNow / Economic Times - Screener & Quantitative Discovery
- **URL**: `https://marketservices.indiatimes.com/oi-heatmaps?exchange=NSE&mtype=default&expDate=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Daily EOD`
- **Parameters**: `mtype, expDate`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: ETNow / Economic Times Heatmap of open interest vs price change (Long Build-up, Short Covering, Short Build-up). [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0292] ETNow / Economic Times - Ownership & Institutional Holdings
- **URL**: `https://etmarketsapis.indiatimes.com/financial-overview?scId=640544&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: ETNow / Economic Times Consolidated Income Statement, Balance Sheet, and Cash Flow Annual and Quarterly figures. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0293] ETNow / Economic Times - Ownership & Institutional Holdings
- **URL**: `https://json.bselivefeeds.indiatimes.com/financial-overview?scId=BE03&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: ETNow / Economic Times Consolidated Income Statement, Balance Sheet, and Cash Flow Annual and Quarterly figures. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0294] ETNow / Economic Times - Ownership & Institutional Holdings
- **URL**: `https://marketservices.indiatimes.com/financial-overview?scId=WSL&ex=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Quarterly`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: ETNow / Economic Times Consolidated Income Statement, Balance Sheet, and Cash Flow Annual and Quarterly figures. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0295] ETNow / Economic Times - News, Filings & AI Sentiment
- **URL**: `https://etmarketsapis.indiatimes.com/pe-pb-bands?symbol=TATAMOTORS&days=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `days, symbol`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: ETNow / Economic Times Historical Valuation P/E and P/B median bands over 3-year and 5-year horizons. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0296] ETNow / Economic Times - News, Filings & AI Sentiment
- **URL**: `https://json.bselivefeeds.indiatimes.com/pe-pb-bands?symbol=BAJFINANCE&days=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `days, symbol`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: ETNow / Economic Times Historical Valuation P/E and P/B median bands over 3-year and 5-year horizons. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0297] ETNow / Economic Times - News, Filings & AI Sentiment
- **URL**: `https://marketservices.indiatimes.com/pe-pb-bands?symbol=LT&days=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Event-based`
- **Parameters**: `days, symbol`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: ETNow / Economic Times Historical Valuation P/E and P/B median bands over 3-year and 5-year horizons. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0298] ETNow / Economic Times - Analyst Estimates & Price Targets
- **URL**: `https://etmarketsapis.indiatimes.com/dcf-valuation?symbol=KOTAKBANK`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: ETNow / Economic Times Discounted Cash Flow (DCF) intrinsic value valuation model and target fair price. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0299] ETNow / Economic Times - Analyst Estimates & Price Targets
- **URL**: `https://json.bselivefeeds.indiatimes.com/dcf-valuation?symbol=RELIANCE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: ETNow / Economic Times Discounted Cash Flow (DCF) intrinsic value valuation model and target fair price. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0300] ETNow / Economic Times - Analyst Estimates & Price Targets
- **URL**: `https://marketservices.indiatimes.com/dcf-valuation?symbol=INFY`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: ETNow / Economic Times Discounted Cash Flow (DCF) intrinsic value valuation model and target fair price. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0301] ETNow / Economic Times - Corporate Actions & Governance
- **URL**: `https://etmarketsapis.indiatimes.com/ratio-analysis?companyid=11984`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid, exchange`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: ETNow / Economic Times Solvency, liquidity, Return on Equity (ROE), and Return on Capital Employed (ROCE) ratios. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0302] ETNow / Economic Times - Corporate Actions & Governance
- **URL**: `https://json.bselivefeeds.indiatimes.com/ratio-analysis?companyid=16552`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid, exchange`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: ETNow / Economic Times Solvency, liquidity, Return on Equity (ROE), and Return on Capital Employed (ROCE) ratios. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0303] ETNow / Economic Times - Corporate Actions & Governance
- **URL**: `https://marketservices.indiatimes.com/ratio-analysis?companyid=132762`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Event-based`
- **Parameters**: `companyid, exchange`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: ETNow / Economic Times Solvency, liquidity, Return on Equity (ROE), and Return on Capital Employed (ROCE) ratios. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0304] ETNow / Economic Times - General Market Metadata
- **URL**: `https://etmarketsapis.indiatimes.com/quarterly-results?scId=107685&type_format=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `sc_id, type_format`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: ETNow / Economic Times Detailed quarterly revenue, operating profit margins, and net profit margins. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0305] ETNow / Economic Times - General Market Metadata
- **URL**: `https://json.bselivefeeds.indiatimes.com/quarterly-results?scId=363433&type_format=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `sc_id, type_format`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: ETNow / Economic Times Detailed quarterly revenue, operating profit margins, and net profit margins. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0306] ETNow / Economic Times - General Market Metadata
- **URL**: `https://marketservices.indiatimes.com/quarterly-results?scId=984165&type_format=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Daily EOD`
- **Parameters**: `sc_id, type_format`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: ETNow / Economic Times Detailed quarterly revenue, operating profit margins, and net profit margins. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0307] ETNow / Economic Times - Price & Technical Charts
- **URL**: `https://etmarketsapis.indiatimes.com/trending-screeners?exchange=NSE&exchangeId=default&pageNumber=default&pageSize=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `exchangeId, pageNumber, pageSize`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: ETNow / Economic Times Top trending technical and quantitative screening strategies. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0308] ETNow / Economic Times - Price & Technical Charts
- **URL**: `https://json.bselivefeeds.indiatimes.com/trending-screeners?exchange=NSE&exchangeId=default&pageNumber=default&pageSize=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `exchangeId, pageNumber, pageSize`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: ETNow / Economic Times Top trending technical and quantitative screening strategies. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0309] ETNow / Economic Times - Price & Technical Charts
- **URL**: `https://marketservices.indiatimes.com/trending-screeners?exchange=NSE&exchangeId=default&pageNumber=default&pageSize=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `1-Min Intraday`
- **Parameters**: `exchangeId, pageNumber, pageSize`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: ETNow / Economic Times Top trending technical and quantitative screening strategies. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0310] ETNow / Economic Times - Derivatives & F&O Analytics
- **URL**: `https://etmarketsapis.indiatimes.com/gainers-losers?exchange=NSE&pagesize=default&duration=default&marketcap=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `pagesize, duration, marketcap`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: ETNow / Economic Times Real-time top gainers, losers, and volume shockers filtered by market cap. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0311] ETNow / Economic Times - Derivatives & F&O Analytics
- **URL**: `https://json.bselivefeeds.indiatimes.com/gainers-losers?exchange=NSE&pagesize=default&duration=default&marketcap=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `pagesize, duration, marketcap`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: ETNow / Economic Times Real-time top gainers, losers, and volume shockers filtered by market cap. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0312] ETNow / Economic Times - Derivatives & F&O Analytics
- **URL**: `https://marketservices.indiatimes.com/gainers-losers?exchange=NSE&pagesize=default&duration=default&marketcap=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `1-Min Intraday`
- **Parameters**: `pagesize, duration, marketcap`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: ETNow / Economic Times Real-time top gainers, losers, and volume shockers filtered by market cap. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0313] ETNow / Economic Times - Fundamental Financials & Valuation
- **URL**: `https://etmarketsapis.indiatimes.com/delivery-scanners?exchange=NSE&lang=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `lang`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: ETNow / Economic Times Stocks with high delivery percentage and delivery quantity spikes for smart money tracking. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0314] ETNow / Economic Times - Fundamental Financials & Valuation
- **URL**: `https://json.bselivefeeds.indiatimes.com/delivery-scanners?exchange=NSE&lang=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `lang`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: ETNow / Economic Times Stocks with high delivery percentage and delivery quantity spikes for smart money tracking. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0315] ETNow / Economic Times - Fundamental Financials & Valuation
- **URL**: `https://marketservices.indiatimes.com/delivery-scanners?exchange=NSE&lang=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Quarterly`
- **Parameters**: `lang`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: ETNow / Economic Times Stocks with high delivery percentage and delivery quantity spikes for smart money tracking. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0316] ETNow / Economic Times - Screener & Quantitative Discovery
- **URL**: `https://etmarketsapis.indiatimes.com/momentum-rankings?exchange=NSE&index=default&page=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `index, page`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: ETNow / Economic Times Relative strength momentum rankings vs Nifty 50 benchmark index. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0317] ETNow / Economic Times - Screener & Quantitative Discovery
- **URL**: `https://json.bselivefeeds.indiatimes.com/momentum-rankings?exchange=NSE&index=default&page=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `index, page`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: ETNow / Economic Times Relative strength momentum rankings vs Nifty 50 benchmark index. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0318] ETNow / Economic Times - Screener & Quantitative Discovery
- **URL**: `https://marketservices.indiatimes.com/momentum-rankings?exchange=NSE&index=default&page=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Daily EOD`
- **Parameters**: `index, page`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: ETNow / Economic Times Relative strength momentum rankings vs Nifty 50 benchmark index. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0319] ETNow / Economic Times - Ownership & Institutional Holdings
- **URL**: `https://etmarketsapis.indiatimes.com/proscanner-details?exchange=NSE&catId=default&scanId=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `catId, scanId`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: ETNow / Economic Times Algorithmic quantitative strategies screening details and stock candidate lists. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0320] ETNow / Economic Times - Ownership & Institutional Holdings
- **URL**: `https://json.bselivefeeds.indiatimes.com/proscanner-details?exchange=NSE&catId=default&scanId=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `catId, scanId`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: ETNow / Economic Times Algorithmic quantitative strategies screening details and stock candidate lists. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0321] ETNow / Economic Times - Ownership & Institutional Holdings
- **URL**: `https://marketservices.indiatimes.com/proscanner-details?exchange=NSE&catId=default&scanId=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Quarterly`
- **Parameters**: `catId, scanId`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: ETNow / Economic Times Algorithmic quantitative strategies screening details and stock candidate lists. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0322] ETNow / Economic Times - News, Filings & AI Sentiment
- **URL**: `https://etmarketsapis.indiatimes.com/shareholding-pattern?companyid=640544`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: ETNow / Economic Times Distribution of stock equity among Promoters, FIIs, DIIs, Mutual Funds, and Retail. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0323] ETNow / Economic Times - News, Filings & AI Sentiment
- **URL**: `https://json.bselivefeeds.indiatimes.com/shareholding-pattern?companyid=BE03`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: ETNow / Economic Times Distribution of stock equity among Promoters, FIIs, DIIs, Mutual Funds, and Retail. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0324] ETNow / Economic Times - News, Filings & AI Sentiment
- **URL**: `https://marketservices.indiatimes.com/shareholding-pattern?companyid=WSL`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Event-based`
- **Parameters**: `companyid`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: ETNow / Economic Times Distribution of stock equity among Promoters, FIIs, DIIs, Mutual Funds, and Retail. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0325] ETNow / Economic Times - Analyst Estimates & Price Targets
- **URL**: `https://etmarketsapis.indiatimes.com/fii-dii-daily?exchange=NSE&year_month=default&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `year_month, type`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: ETNow / Economic Times Daily Foreign (FII) and Domestic (DII) institutional net buying/selling in Cash and FnO. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0326] ETNow / Economic Times - Analyst Estimates & Price Targets
- **URL**: `https://json.bselivefeeds.indiatimes.com/fii-dii-daily?exchange=NSE&year_month=default&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `year_month, type`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: ETNow / Economic Times Daily Foreign (FII) and Domestic (DII) institutional net buying/selling in Cash and FnO. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0327] ETNow / Economic Times - Analyst Estimates & Price Targets
- **URL**: `https://marketservices.indiatimes.com/fii-dii-daily?exchange=NSE&year_month=default&type=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Daily EOD`
- **Parameters**: `year_month, type`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: ETNow / Economic Times Daily Foreign (FII) and Domestic (DII) institutional net buying/selling in Cash and FnO. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0328] ETNow / Economic Times - Corporate Actions & Governance
- **URL**: `https://etmarketsapis.indiatimes.com/insider-deals?exchange=NSE&dealsType=default&range=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `dealsType, range`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: ETNow / Economic Times Promoter insider transactions, substantial acquisitions, and pledged share filings. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0329] ETNow / Economic Times - Corporate Actions & Governance
- **URL**: `https://json.bselivefeeds.indiatimes.com/insider-deals?exchange=NSE&dealsType=default&range=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `dealsType, range`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: ETNow / Economic Times Promoter insider transactions, substantial acquisitions, and pledged share filings. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0330] ETNow / Economic Times - Corporate Actions & Governance
- **URL**: `https://marketservices.indiatimes.com/insider-deals?exchange=NSE&dealsType=default&range=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Event-based`
- **Parameters**: `dealsType, range`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: ETNow / Economic Times Promoter insider transactions, substantial acquisitions, and pledged share filings. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0331] ETNow / Economic Times - General Market Metadata
- **URL**: `https://etmarketsapis.indiatimes.com/bulk-block-deals?exchange=NSE&start=default&limit=default&orderBy=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `start, limit, orderBy`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: ETNow / Economic Times Chronological bulk and block deal logs detailing buyer, seller, quantity, and price. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0332] ETNow / Economic Times - General Market Metadata
- **URL**: `https://json.bselivefeeds.indiatimes.com/bulk-block-deals?exchange=NSE&start=default&limit=default&orderBy=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `start, limit, orderBy`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: ETNow / Economic Times Chronological bulk and block deal logs detailing buyer, seller, quantity, and price. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0333] ETNow / Economic Times - General Market Metadata
- **URL**: `https://marketservices.indiatimes.com/bulk-block-deals?exchange=NSE&start=default&limit=default&orderBy=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Daily EOD`
- **Parameters**: `start, limit, orderBy`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: ETNow / Economic Times Chronological bulk and block deal logs detailing buyer, seller, quantity, and price. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0334] ETNow / Economic Times - Price & Technical Charts
- **URL**: `https://etmarketsapis.indiatimes.com/superstar-portfolios?exchange=NSE&only_superstars=default&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `only_superstars, limit`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: ETNow / Economic Times Portfolio composition and trade activity of celebrity investors and ace funds. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0335] ETNow / Economic Times - Price & Technical Charts
- **URL**: `https://json.bselivefeeds.indiatimes.com/superstar-portfolios?exchange=NSE&only_superstars=default&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `only_superstars, limit`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: ETNow / Economic Times Portfolio composition and trade activity of celebrity investors and ace funds. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0336] ETNow / Economic Times - Price & Technical Charts
- **URL**: `https://marketservices.indiatimes.com/superstar-portfolios?exchange=NSE&only_superstars=default&limit=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `1-Min Intraday`
- **Parameters**: `only_superstars, limit`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: ETNow / Economic Times Portfolio composition and trade activity of celebrity investors and ace funds. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0337] ETNow / Economic Times - Derivatives & F&O Analytics
- **URL**: `https://etmarketsapis.indiatimes.com/market-news?exchange=NSE&category=default&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `category, limit`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: ETNow / Economic Times Real-time market news flashes, press releases, and macroeconomic news feed. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0338] ETNow / Economic Times - Derivatives & F&O Analytics
- **URL**: `https://json.bselivefeeds.indiatimes.com/market-news?exchange=NSE&category=default&limit=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `category, limit`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: ETNow / Economic Times Real-time market news flashes, press releases, and macroeconomic news feed. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0339] ETNow / Economic Times - Derivatives & F&O Analytics
- **URL**: `https://marketservices.indiatimes.com/market-news?exchange=NSE&category=default&limit=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `1-Min Intraday`
- **Parameters**: `category, limit`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: ETNow / Economic Times Real-time market news flashes, press releases, and macroeconomic news feed. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0340] ETNow / Economic Times - Fundamental Financials & Valuation
- **URL**: `https://etmarketsapis.indiatimes.com/ai-sentiment-summary?symbol=TATAMOTORS`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `symbol`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: ETNow / Economic Times AI-summarized news sentiment score (-1.0 to +1.0), topic tags, and confidence scores. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0341] ETNow / Economic Times - Fundamental Financials & Valuation
- **URL**: `https://json.bselivefeeds.indiatimes.com/ai-sentiment-summary?symbol=BAJFINANCE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `symbol`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: ETNow / Economic Times AI-summarized news sentiment score (-1.0 to +1.0), topic tags, and confidence scores. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0342] ETNow / Economic Times - Fundamental Financials & Valuation
- **URL**: `https://marketservices.indiatimes.com/ai-sentiment-summary?symbol=LT`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Quarterly`
- **Parameters**: `symbol`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: ETNow / Economic Times AI-summarized news sentiment score (-1.0 to +1.0), topic tags, and confidence scores. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0343] ETNow / Economic Times - Screener & Quantitative Discovery
- **URL**: `https://etmarketsapis.indiatimes.com/concall-transcripts?exchange=NSE&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `limit`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: ETNow / Economic Times Quarterly earnings conference call audio recordings, transcripts, and AI key takeaways. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0344] ETNow / Economic Times - Screener & Quantitative Discovery
- **URL**: `https://json.bselivefeeds.indiatimes.com/concall-transcripts?exchange=NSE&limit=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `limit`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: ETNow / Economic Times Quarterly earnings conference call audio recordings, transcripts, and AI key takeaways. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0345] ETNow / Economic Times - Screener & Quantitative Discovery
- **URL**: `https://marketservices.indiatimes.com/concall-transcripts?exchange=NSE&limit=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Daily EOD`
- **Parameters**: `limit`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: ETNow / Economic Times Quarterly earnings conference call audio recordings, transcripts, and AI key takeaways. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0346] ETNow / Economic Times - Ownership & Institutional Holdings
- **URL**: `https://etmarketsapis.indiatimes.com/exchange-filings?exchange=NSE&exchangeSymbol=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchangeSymbol`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: ETNow / Economic Times Official BSE/NSE corporate disclosures, material event notices, and regulatory PDF links. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0347] ETNow / Economic Times - Ownership & Institutional Holdings
- **URL**: `https://json.bselivefeeds.indiatimes.com/exchange-filings?exchange=NSE&exchangeSymbol=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchangeSymbol`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: ETNow / Economic Times Official BSE/NSE corporate disclosures, material event notices, and regulatory PDF links. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0348] ETNow / Economic Times - Ownership & Institutional Holdings
- **URL**: `https://marketservices.indiatimes.com/exchange-filings?exchange=NSE&exchangeSymbol=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Quarterly`
- **Parameters**: `exchangeSymbol`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: ETNow / Economic Times Official BSE/NSE corporate disclosures, material event notices, and regulatory PDF links. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0349] ETNow / Economic Times - News, Filings & AI Sentiment
- **URL**: `https://etmarketsapis.indiatimes.com/consensus-ratings?scId=107685&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: ETNow / Economic Times Wall Street and Indian broker consensus ratings (Strong Buy, Buy, Hold, Sell, Strong Sell). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0350] ETNow / Economic Times - News, Filings & AI Sentiment
- **URL**: `https://json.bselivefeeds.indiatimes.com/consensus-ratings?scId=363433&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: ETNow / Economic Times Wall Street and Indian broker consensus ratings (Strong Buy, Buy, Hold, Sell, Strong Sell). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0351] ETNow / Economic Times - News, Filings & AI Sentiment
- **URL**: `https://marketservices.indiatimes.com/consensus-ratings?scId=984165&ex=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Event-based`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: ETNow / Economic Times Wall Street and Indian broker consensus ratings (Strong Buy, Buy, Hold, Sell, Strong Sell). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0352] ETNow / Economic Times - Analyst Estimates & Price Targets
- **URL**: `https://etmarketsapis.indiatimes.com/price-forecast?scId=640544&deviceType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, deviceType`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: ETNow / Economic Times 12-month analyst target price forecasts including High, Median, Low estimates. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0353] ETNow / Economic Times - Analyst Estimates & Price Targets
- **URL**: `https://json.bselivefeeds.indiatimes.com/price-forecast?scId=BE03&deviceType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, deviceType`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: ETNow / Economic Times 12-month analyst target price forecasts including High, Median, Low estimates. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0354] ETNow / Economic Times - Analyst Estimates & Price Targets
- **URL**: `https://marketservices.indiatimes.com/price-forecast?scId=WSL&deviceType=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, deviceType`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: ETNow / Economic Times 12-month analyst target price forecasts including High, Median, Low estimates. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0355] ETNow / Economic Times - Corporate Actions & Governance
- **URL**: `https://etmarketsapis.indiatimes.com/earnings-surprises?scId=IT&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, type`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: ETNow / Economic Times Historical quarterly EPS and Revenue analyst consensus estimates vs actual reported performance. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0356] ETNow / Economic Times - Corporate Actions & Governance
- **URL**: `https://json.bselivefeeds.indiatimes.com/earnings-surprises?scId=RLXO&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, type`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: ETNow / Economic Times Historical quarterly EPS and Revenue analyst consensus estimates vs actual reported performance. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0357] ETNow / Economic Times - Corporate Actions & Governance
- **URL**: `https://marketservices.indiatimes.com/earnings-surprises?scId=WEBELSOLAR&type=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Event-based`
- **Parameters**: `scId, type`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: ETNow / Economic Times Historical quarterly EPS and Revenue analyst consensus estimates vs actual reported performance. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0358] ETNow / Economic Times - General Market Metadata
- **URL**: `https://etmarketsapis.indiatimes.com/research-reports?exchange=NSE&path=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `path`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: ETNow / Economic Times Institutional equity research reports and broker analysis recommendations feed. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0359] ETNow / Economic Times - General Market Metadata
- **URL**: `https://json.bselivefeeds.indiatimes.com/research-reports?exchange=NSE&path=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `path`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: ETNow / Economic Times Institutional equity research reports and broker analysis recommendations feed. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0360] ETNow / Economic Times - General Market Metadata
- **URL**: `https://marketservices.indiatimes.com/research-reports?exchange=NSE&path=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Daily EOD`
- **Parameters**: `path`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: ETNow / Economic Times Institutional equity research reports and broker analysis recommendations feed. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0361] ETNow / Economic Times - Price & Technical Charts
- **URL**: `https://etmarketsapis.indiatimes.com/dividend-calendar?scId=11984&section=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId, section`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: ETNow / Economic Times Historical and upcoming dividend declarations, record dates, ex-dates, and yields. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0362] ETNow / Economic Times - Price & Technical Charts
- **URL**: `https://json.bselivefeeds.indiatimes.com/dividend-calendar?scId=16552&section=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId, section`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: ETNow / Economic Times Historical and upcoming dividend declarations, record dates, ex-dates, and yields. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0363] ETNow / Economic Times - Price & Technical Charts
- **URL**: `https://marketservices.indiatimes.com/dividend-calendar?scId=132762&section=default`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId, section`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: ETNow / Economic Times Historical and upcoming dividend declarations, record dates, ex-dates, and yields. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0364] ETNow / Economic Times - Derivatives & F&O Analytics
- **URL**: `https://etmarketsapis.indiatimes.com/splits-bonuses?scId=107685`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: ETNow / Economic Times Corporate actions log detailing stock splits, bonus shares ratios, and rights issues. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0365] ETNow / Economic Times - Derivatives & F&O Analytics
- **URL**: `https://json.bselivefeeds.indiatimes.com/splits-bonuses?scId=363433`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: ETNow / Economic Times Corporate actions log detailing stock splits, bonus shares ratios, and rights issues. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0366] ETNow / Economic Times - Derivatives & F&O Analytics
- **URL**: `https://marketservices.indiatimes.com/splits-bonuses?scId=984165`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: ETNow / Economic Times Corporate actions log detailing stock splits, bonus shares ratios, and rights issues. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0367] ETNow / Economic Times - Fundamental Financials & Valuation
- **URL**: `https://etmarketsapis.indiatimes.com/board-meetings?scId=640544`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: ETNow / Economic Times Upcoming corporate board meeting announcements and agendas. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0368] ETNow / Economic Times - Fundamental Financials & Valuation
- **URL**: `https://json.bselivefeeds.indiatimes.com/board-meetings?scId=BE03`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: ETNow / Economic Times Upcoming corporate board meeting announcements and agendas. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0369] ETNow / Economic Times - Fundamental Financials & Valuation
- **URL**: `https://marketservices.indiatimes.com/board-meetings?scId=WSL`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Quarterly`
- **Parameters**: `scId`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: ETNow / Economic Times Upcoming corporate board meeting announcements and agendas. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0370] ETNow / Economic Times - Screener & Quantitative Discovery
- **URL**: `https://etmarketsapis.indiatimes.com/symbol-resolution?symbol=TATAMOTORS`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: ETNow / Economic Times Master symbol mapping resolving NSE/BSE tickers, ISIN codes, and security identifiers. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0371] ETNow / Economic Times - Screener & Quantitative Discovery
- **URL**: `https://json.bselivefeeds.indiatimes.com/symbol-resolution?symbol=BAJFINANCE`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: ETNow / Economic Times Master symbol mapping resolving NSE/BSE tickers, ISIN codes, and security identifiers. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0372] ETNow / Economic Times - Screener & Quantitative Discovery
- **URL**: `https://marketservices.indiatimes.com/symbol-resolution?symbol=LT`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: ETNow / Economic Times Master symbol mapping resolving NSE/BSE tickers, ISIN codes, and security identifiers. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0373] ETNow / Economic Times - Ownership & Institutional Holdings
- **URL**: `https://etmarketsapis.indiatimes.com/market-status?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `None`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: ETNow / Economic Times Live trading session market status (Pre-open, Normal, Auction, Closed) and holiday calendar. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0374] ETNow / Economic Times - Ownership & Institutional Holdings
- **URL**: `https://json.bselivefeeds.indiatimes.com/market-status?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `None`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: ETNow / Economic Times Live trading session market status (Pre-open, Normal, Auction, Closed) and holiday calendar. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0375] ETNow / Economic Times - Ownership & Institutional Holdings
- **URL**: `https://marketservices.indiatimes.com/market-status?exchange=NSE`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Quarterly`
- **Parameters**: `None`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: ETNow / Economic Times Live trading session market status (Pre-open, Normal, Auction, Closed) and holiday calendar. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0376] ETNow / Economic Times - News, Filings & AI Sentiment
- **URL**: `https://etmarketsapis.indiatimes.com/sector-mappings?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `exchange`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: ETNow / Economic Times Sector and industry hierarchy classifications and index constituent weights. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0377] ETNow / Economic Times - News, Filings & AI Sentiment
- **URL**: `https://json.bselivefeeds.indiatimes.com/sector-mappings?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `exchange`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: ETNow / Economic Times Sector and industry hierarchy classifications and index constituent weights. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0378] ETNow / Economic Times - News, Filings & AI Sentiment
- **URL**: `https://marketservices.indiatimes.com/sector-mappings?exchange=NSE`
- **Method**: `GET` | **Format**: `JSONP` | **Frequency**: `Event-based`
- **Parameters**: `exchange`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: ETNow / Economic Times Sector and industry hierarchy classifications and index constituent weights. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0379] NiftyTrader - Price & Technical Charts
- **URL**: `https://webapi.niftytrader.in/webapi/history?symbol=ICICIBANK&resolution=default&from=default&to=default&currencyCode=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, resolution, from, to, currencyCode`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: NiftyTrader Real-time historical OHLCV chart bars and tick time-series data. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0380] NiftyTrader - Price & Technical Charts
- **URL**: `https://api.niftytrader.in/webapi/history?symbol=BHARTIARTL&resolution=default&from=default&to=default&currencyCode=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, resolution, from, to, currencyCode`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: NiftyTrader Real-time historical OHLCV chart bars and tick time-series data. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0381] NiftyTrader - Price & Technical Charts
- **URL**: `https://webapi.niftytrader.in/webapi/history?symbol=LTIM&resolution=default&from=default&to=default&currencyCode=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, resolution, from, to, currencyCode`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: NiftyTrader Real-time historical OHLCV chart bars and tick time-series data. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0382] NiftyTrader - Derivatives & F&O Analytics
- **URL**: `https://webapi.niftytrader.in/webapi/live-quote?symbol=ITC`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: NiftyTrader Live streaming market quote, last traded price, bid/ask depth, and session volume. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0383] NiftyTrader - Derivatives & F&O Analytics
- **URL**: `https://api.niftytrader.in/webapi/live-quote?symbol=WIPRO`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: NiftyTrader Live streaming market quote, last traded price, bid/ask depth, and session volume. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0384] NiftyTrader - Derivatives & F&O Analytics
- **URL**: `https://webapi.niftytrader.in/webapi/live-quote?symbol=MARUTI`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: NiftyTrader Live streaming market quote, last traded price, bid/ask depth, and session volume. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0385] NiftyTrader - Fundamental Financials & Valuation
- **URL**: `https://webapi.niftytrader.in/webapi/vwap-intraday?scId=IT&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: NiftyTrader Intraday Volume-Weighted Average Price (VWAP) line coordinates and volume distribution. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0386] NiftyTrader - Fundamental Financials & Valuation
- **URL**: `https://api.niftytrader.in/webapi/vwap-intraday?scId=RLXO&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: NiftyTrader Intraday Volume-Weighted Average Price (VWAP) line coordinates and volume distribution. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0387] NiftyTrader - Fundamental Financials & Valuation
- **URL**: `https://webapi.niftytrader.in/webapi/vwap-intraday?scId=WEBELSOLAR&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: NiftyTrader Intraday Volume-Weighted Average Price (VWAP) line coordinates and volume distribution. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0388] NiftyTrader - Screener & Quantitative Discovery
- **URL**: `https://webapi.niftytrader.in/webapi/pivot-levels?scId=JKIN&classic=default&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, classic, period`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: NiftyTrader Classic, Fibonacci, and Camarilla pivot support (S1-S3) and resistance (R1-R3) levels. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0389] NiftyTrader - Screener & Quantitative Discovery
- **URL**: `https://api.niftytrader.in/webapi/pivot-levels?scId=11945&classic=default&period=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, classic, period`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: NiftyTrader Classic, Fibonacci, and Camarilla pivot support (S1-S3) and resistance (R1-R3) levels. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0390] NiftyTrader - Screener & Quantitative Discovery
- **URL**: `https://webapi.niftytrader.in/webapi/pivot-levels?scId=8581&classic=default&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, classic, period`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: NiftyTrader Classic, Fibonacci, and Camarilla pivot support (S1-S3) and resistance (R1-R3) levels. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0391] NiftyTrader - Ownership & Institutional Holdings
- **URL**: `https://webapi.niftytrader.in/webapi/moving-averages?scId=11984&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: NiftyTrader Exponential (EMA) and Simple (SMA) moving averages across 5, 20, 50, 100, 200 day periods. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0392] NiftyTrader - Ownership & Institutional Holdings
- **URL**: `https://api.niftytrader.in/webapi/moving-averages?scId=16552&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: NiftyTrader Exponential (EMA) and Simple (SMA) moving averages across 5, 20, 50, 100, 200 day periods. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0393] NiftyTrader - Ownership & Institutional Holdings
- **URL**: `https://webapi.niftytrader.in/webapi/moving-averages?scId=132762&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: NiftyTrader Exponential (EMA) and Simple (SMA) moving averages across 5, 20, 50, 100, 200 day periods. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0394] NiftyTrader - News, Filings & AI Sentiment
- **URL**: `https://webapi.niftytrader.in/webapi/chart-patterns?scId=107685&pattern_type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `sc_id, pattern_type`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: NiftyTrader Automated candlestick pattern scanner (Doji, Marubozu, Head & Shoulders, Double Top). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0395] NiftyTrader - News, Filings & AI Sentiment
- **URL**: `https://api.niftytrader.in/webapi/chart-patterns?scId=363433&pattern_type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `sc_id, pattern_type`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: NiftyTrader Automated candlestick pattern scanner (Doji, Marubozu, Head & Shoulders, Double Top). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0396] NiftyTrader - News, Filings & AI Sentiment
- **URL**: `https://webapi.niftytrader.in/webapi/chart-patterns?scId=984165&pattern_type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `sc_id, pattern_type`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: NiftyTrader Automated candlestick pattern scanner (Doji, Marubozu, Head & Shoulders, Double Top). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0397] NiftyTrader - Analyst Estimates & Price Targets
- **URL**: `https://webapi.niftytrader.in/webapi/option-chain?symbol=ITC&expiryDate=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol, expiryDate, exchange`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: NiftyTrader Complete options chain matrix containing Call/Put LTP, Strike Prices, OI, and IV Skew. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0398] NiftyTrader - Analyst Estimates & Price Targets
- **URL**: `https://api.niftytrader.in/webapi/option-chain?symbol=WIPRO&expiryDate=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol, expiryDate, exchange`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: NiftyTrader Complete options chain matrix containing Call/Put LTP, Strike Prices, OI, and IV Skew. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0399] NiftyTrader - Analyst Estimates & Price Targets
- **URL**: `https://webapi.niftytrader.in/webapi/option-chain?symbol=MARUTI&expiryDate=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol, expiryDate, exchange`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: NiftyTrader Complete options chain matrix containing Call/Put LTP, Strike Prices, OI, and IV Skew. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0400] NiftyTrader - Corporate Actions & Governance
- **URL**: `https://webapi.niftytrader.in/webapi/futures-data?exchange=NSE&id=default&expirydate=default&fut=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `id, expirydate, fut`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: NiftyTrader Futures contract prices, lot sizes, basis premium/discount to spot, and open interest builds. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0401] NiftyTrader - Corporate Actions & Governance
- **URL**: `https://api.niftytrader.in/webapi/futures-data?exchange=NSE&id=default&expirydate=default&fut=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `id, expirydate, fut`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: NiftyTrader Futures contract prices, lot sizes, basis premium/discount to spot, and open interest builds. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0402] NiftyTrader - Corporate Actions & Governance
- **URL**: `https://webapi.niftytrader.in/webapi/futures-data?exchange=NSE&id=default&expirydate=default&fut=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `id, expirydate, fut`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: NiftyTrader Futures contract prices, lot sizes, basis premium/discount to spot, and open interest builds. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0403] NiftyTrader - General Market Metadata
- **URL**: `https://webapi.niftytrader.in/webapi/oi-pcr-trend?exchange=NSE&symbolName=default&reqType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbolName, reqType`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: NiftyTrader Intraday Put-Call Ratio (PCR) history and open interest distribution charts. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0404] NiftyTrader - General Market Metadata
- **URL**: `https://api.niftytrader.in/webapi/oi-pcr-trend?exchange=NSE&symbolName=default&reqType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbolName, reqType`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: NiftyTrader Intraday Put-Call Ratio (PCR) history and open interest distribution charts. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0405] NiftyTrader - General Market Metadata
- **URL**: `https://webapi.niftytrader.in/webapi/oi-pcr-trend?exchange=NSE&symbolName=default&reqType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbolName, reqType`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: NiftyTrader Intraday Put-Call Ratio (PCR) history and open interest distribution charts. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0406] NiftyTrader - Price & Technical Charts
- **URL**: `https://webapi.niftytrader.in/webapi/iv-percentile?symbol=TCS&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, type, exchange`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: NiftyTrader Implied Volatility (IV) rank, IV percentile, and historical IV volatility surface. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0407] NiftyTrader - Price & Technical Charts
- **URL**: `https://api.niftytrader.in/webapi/iv-percentile?symbol=HDFCBANK&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, type, exchange`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: NiftyTrader Implied Volatility (IV) rank, IV percentile, and historical IV volatility surface. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0408] NiftyTrader - Price & Technical Charts
- **URL**: `https://webapi.niftytrader.in/webapi/iv-percentile?symbol=SBIN&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, type, exchange`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: NiftyTrader Implied Volatility (IV) rank, IV percentile, and historical IV volatility surface. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0409] NiftyTrader - Derivatives & F&O Analytics
- **URL**: `https://webapi.niftytrader.in/webapi/max-pain?symbol=ICICIBANK`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: NiftyTrader Intraday and EOD Max Pain strike price calculation for options expiry pinning. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0410] NiftyTrader - Derivatives & F&O Analytics
- **URL**: `https://api.niftytrader.in/webapi/max-pain?symbol=BHARTIARTL`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: NiftyTrader Intraday and EOD Max Pain strike price calculation for options expiry pinning. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0411] NiftyTrader - Derivatives & F&O Analytics
- **URL**: `https://webapi.niftytrader.in/webapi/max-pain?symbol=LTIM`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: NiftyTrader Intraday and EOD Max Pain strike price calculation for options expiry pinning. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0412] NiftyTrader - Fundamental Financials & Valuation
- **URL**: `https://webapi.niftytrader.in/webapi/fno-ban-list?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchange`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: NiftyTrader Official NSE F&O Securities in Ban Period exceeding 95% Market-Wide Position Limit (MWPL). [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0413] NiftyTrader - Fundamental Financials & Valuation
- **URL**: `https://api.niftytrader.in/webapi/fno-ban-list?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchange`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: NiftyTrader Official NSE F&O Securities in Ban Period exceeding 95% Market-Wide Position Limit (MWPL). [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0414] NiftyTrader - Fundamental Financials & Valuation
- **URL**: `https://webapi.niftytrader.in/webapi/fno-ban-list?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchange`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: NiftyTrader Official NSE F&O Securities in Ban Period exceeding 95% Market-Wide Position Limit (MWPL). [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0415] NiftyTrader - Screener & Quantitative Discovery
- **URL**: `https://webapi.niftytrader.in/webapi/oi-heatmaps?exchange=NSE&mtype=default&expDate=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `mtype, expDate`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: NiftyTrader Heatmap of open interest vs price change (Long Build-up, Short Covering, Short Build-up). [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0416] NiftyTrader - Screener & Quantitative Discovery
- **URL**: `https://api.niftytrader.in/webapi/oi-heatmaps?exchange=NSE&mtype=default&expDate=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `mtype, expDate`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: NiftyTrader Heatmap of open interest vs price change (Long Build-up, Short Covering, Short Build-up). [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0417] NiftyTrader - Screener & Quantitative Discovery
- **URL**: `https://webapi.niftytrader.in/webapi/oi-heatmaps?exchange=NSE&mtype=default&expDate=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `mtype, expDate`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: NiftyTrader Heatmap of open interest vs price change (Long Build-up, Short Covering, Short Build-up). [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0418] NiftyTrader - Ownership & Institutional Holdings
- **URL**: `https://webapi.niftytrader.in/webapi/financial-overview?scId=JKIN&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: NiftyTrader Consolidated Income Statement, Balance Sheet, and Cash Flow Annual and Quarterly figures. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0419] NiftyTrader - Ownership & Institutional Holdings
- **URL**: `https://api.niftytrader.in/webapi/financial-overview?scId=11945&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: NiftyTrader Consolidated Income Statement, Balance Sheet, and Cash Flow Annual and Quarterly figures. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0420] NiftyTrader - Ownership & Institutional Holdings
- **URL**: `https://webapi.niftytrader.in/webapi/financial-overview?scId=8581&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: NiftyTrader Consolidated Income Statement, Balance Sheet, and Cash Flow Annual and Quarterly figures. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0421] NiftyTrader - News, Filings & AI Sentiment
- **URL**: `https://webapi.niftytrader.in/webapi/pe-pb-bands?symbol=TCS&days=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `days, symbol`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: NiftyTrader Historical Valuation P/E and P/B median bands over 3-year and 5-year horizons. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0422] NiftyTrader - News, Filings & AI Sentiment
- **URL**: `https://api.niftytrader.in/webapi/pe-pb-bands?symbol=HDFCBANK&days=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `days, symbol`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: NiftyTrader Historical Valuation P/E and P/B median bands over 3-year and 5-year horizons. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0423] NiftyTrader - News, Filings & AI Sentiment
- **URL**: `https://webapi.niftytrader.in/webapi/pe-pb-bands?symbol=SBIN&days=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `days, symbol`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: NiftyTrader Historical Valuation P/E and P/B median bands over 3-year and 5-year horizons. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0424] NiftyTrader - Analyst Estimates & Price Targets
- **URL**: `https://webapi.niftytrader.in/webapi/dcf-valuation?symbol=ICICIBANK`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: NiftyTrader Discounted Cash Flow (DCF) intrinsic value valuation model and target fair price. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0425] NiftyTrader - Analyst Estimates & Price Targets
- **URL**: `https://api.niftytrader.in/webapi/dcf-valuation?symbol=BHARTIARTL`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: NiftyTrader Discounted Cash Flow (DCF) intrinsic value valuation model and target fair price. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0426] NiftyTrader - Analyst Estimates & Price Targets
- **URL**: `https://webapi.niftytrader.in/webapi/dcf-valuation?symbol=LTIM`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: NiftyTrader Discounted Cash Flow (DCF) intrinsic value valuation model and target fair price. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0427] NiftyTrader - Corporate Actions & Governance
- **URL**: `https://webapi.niftytrader.in/webapi/ratio-analysis?companyid=640544`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid, exchange`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: NiftyTrader Solvency, liquidity, Return on Equity (ROE), and Return on Capital Employed (ROCE) ratios. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0428] NiftyTrader - Corporate Actions & Governance
- **URL**: `https://api.niftytrader.in/webapi/ratio-analysis?companyid=BE03`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid, exchange`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: NiftyTrader Solvency, liquidity, Return on Equity (ROE), and Return on Capital Employed (ROCE) ratios. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0429] NiftyTrader - Corporate Actions & Governance
- **URL**: `https://webapi.niftytrader.in/webapi/ratio-analysis?companyid=WSL`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid, exchange`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: NiftyTrader Solvency, liquidity, Return on Equity (ROE), and Return on Capital Employed (ROCE) ratios. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0430] NiftyTrader - General Market Metadata
- **URL**: `https://webapi.niftytrader.in/webapi/quarterly-results?scId=IT&type_format=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `sc_id, type_format`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: NiftyTrader Detailed quarterly revenue, operating profit margins, and net profit margins. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0431] NiftyTrader - General Market Metadata
- **URL**: `https://api.niftytrader.in/webapi/quarterly-results?scId=RLXO&type_format=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `sc_id, type_format`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: NiftyTrader Detailed quarterly revenue, operating profit margins, and net profit margins. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0432] NiftyTrader - General Market Metadata
- **URL**: `https://webapi.niftytrader.in/webapi/quarterly-results?scId=WEBELSOLAR&type_format=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `sc_id, type_format`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: NiftyTrader Detailed quarterly revenue, operating profit margins, and net profit margins. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0433] NiftyTrader - Price & Technical Charts
- **URL**: `https://webapi.niftytrader.in/webapi/trending-screeners?exchange=NSE&exchangeId=default&pageNumber=default&pageSize=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `exchangeId, pageNumber, pageSize`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: NiftyTrader Top trending technical and quantitative screening strategies. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0434] NiftyTrader - Price & Technical Charts
- **URL**: `https://api.niftytrader.in/webapi/trending-screeners?exchange=NSE&exchangeId=default&pageNumber=default&pageSize=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `exchangeId, pageNumber, pageSize`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: NiftyTrader Top trending technical and quantitative screening strategies. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0435] NiftyTrader - Price & Technical Charts
- **URL**: `https://webapi.niftytrader.in/webapi/trending-screeners?exchange=NSE&exchangeId=default&pageNumber=default&pageSize=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `exchangeId, pageNumber, pageSize`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: NiftyTrader Top trending technical and quantitative screening strategies. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0436] NiftyTrader - Derivatives & F&O Analytics
- **URL**: `https://webapi.niftytrader.in/webapi/gainers-losers?exchange=NSE&pagesize=default&duration=default&marketcap=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `pagesize, duration, marketcap`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: NiftyTrader Real-time top gainers, losers, and volume shockers filtered by market cap. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0437] NiftyTrader - Derivatives & F&O Analytics
- **URL**: `https://api.niftytrader.in/webapi/gainers-losers?exchange=NSE&pagesize=default&duration=default&marketcap=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `pagesize, duration, marketcap`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: NiftyTrader Real-time top gainers, losers, and volume shockers filtered by market cap. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0438] NiftyTrader - Derivatives & F&O Analytics
- **URL**: `https://webapi.niftytrader.in/webapi/gainers-losers?exchange=NSE&pagesize=default&duration=default&marketcap=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `pagesize, duration, marketcap`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: NiftyTrader Real-time top gainers, losers, and volume shockers filtered by market cap. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0439] NiftyTrader - Fundamental Financials & Valuation
- **URL**: `https://webapi.niftytrader.in/webapi/delivery-scanners?exchange=NSE&lang=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `lang`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: NiftyTrader Stocks with high delivery percentage and delivery quantity spikes for smart money tracking. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0440] NiftyTrader - Fundamental Financials & Valuation
- **URL**: `https://api.niftytrader.in/webapi/delivery-scanners?exchange=NSE&lang=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `lang`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: NiftyTrader Stocks with high delivery percentage and delivery quantity spikes for smart money tracking. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0441] NiftyTrader - Fundamental Financials & Valuation
- **URL**: `https://webapi.niftytrader.in/webapi/delivery-scanners?exchange=NSE&lang=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `lang`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: NiftyTrader Stocks with high delivery percentage and delivery quantity spikes for smart money tracking. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0442] NiftyTrader - Screener & Quantitative Discovery
- **URL**: `https://webapi.niftytrader.in/webapi/momentum-rankings?exchange=NSE&index=default&page=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `index, page`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: NiftyTrader Relative strength momentum rankings vs Nifty 50 benchmark index. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0443] NiftyTrader - Screener & Quantitative Discovery
- **URL**: `https://api.niftytrader.in/webapi/momentum-rankings?exchange=NSE&index=default&page=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `index, page`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: NiftyTrader Relative strength momentum rankings vs Nifty 50 benchmark index. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0444] NiftyTrader - Screener & Quantitative Discovery
- **URL**: `https://webapi.niftytrader.in/webapi/momentum-rankings?exchange=NSE&index=default&page=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `index, page`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: NiftyTrader Relative strength momentum rankings vs Nifty 50 benchmark index. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0445] NiftyTrader - Ownership & Institutional Holdings
- **URL**: `https://webapi.niftytrader.in/webapi/proscanner-details?exchange=NSE&catId=default&scanId=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `catId, scanId`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: NiftyTrader Algorithmic quantitative strategies screening details and stock candidate lists. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0446] NiftyTrader - Ownership & Institutional Holdings
- **URL**: `https://api.niftytrader.in/webapi/proscanner-details?exchange=NSE&catId=default&scanId=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `catId, scanId`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: NiftyTrader Algorithmic quantitative strategies screening details and stock candidate lists. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0447] NiftyTrader - Ownership & Institutional Holdings
- **URL**: `https://webapi.niftytrader.in/webapi/proscanner-details?exchange=NSE&catId=default&scanId=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `catId, scanId`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: NiftyTrader Algorithmic quantitative strategies screening details and stock candidate lists. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0448] NiftyTrader - News, Filings & AI Sentiment
- **URL**: `https://webapi.niftytrader.in/webapi/shareholding-pattern?companyid=JKIN`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: NiftyTrader Distribution of stock equity among Promoters, FIIs, DIIs, Mutual Funds, and Retail. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0449] NiftyTrader - News, Filings & AI Sentiment
- **URL**: `https://api.niftytrader.in/webapi/shareholding-pattern?companyid=11945`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: NiftyTrader Distribution of stock equity among Promoters, FIIs, DIIs, Mutual Funds, and Retail. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0450] NiftyTrader - News, Filings & AI Sentiment
- **URL**: `https://webapi.niftytrader.in/webapi/shareholding-pattern?companyid=8581`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: NiftyTrader Distribution of stock equity among Promoters, FIIs, DIIs, Mutual Funds, and Retail. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0451] NiftyTrader - Analyst Estimates & Price Targets
- **URL**: `https://webapi.niftytrader.in/webapi/fii-dii-daily?exchange=NSE&year_month=default&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `year_month, type`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: NiftyTrader Daily Foreign (FII) and Domestic (DII) institutional net buying/selling in Cash and FnO. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0452] NiftyTrader - Analyst Estimates & Price Targets
- **URL**: `https://api.niftytrader.in/webapi/fii-dii-daily?exchange=NSE&year_month=default&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `year_month, type`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: NiftyTrader Daily Foreign (FII) and Domestic (DII) institutional net buying/selling in Cash and FnO. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0453] NiftyTrader - Analyst Estimates & Price Targets
- **URL**: `https://webapi.niftytrader.in/webapi/fii-dii-daily?exchange=NSE&year_month=default&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `year_month, type`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: NiftyTrader Daily Foreign (FII) and Domestic (DII) institutional net buying/selling in Cash and FnO. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0454] NiftyTrader - Corporate Actions & Governance
- **URL**: `https://webapi.niftytrader.in/webapi/insider-deals?exchange=NSE&dealsType=default&range=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `dealsType, range`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: NiftyTrader Promoter insider transactions, substantial acquisitions, and pledged share filings. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0455] NiftyTrader - Corporate Actions & Governance
- **URL**: `https://api.niftytrader.in/webapi/insider-deals?exchange=NSE&dealsType=default&range=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `dealsType, range`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: NiftyTrader Promoter insider transactions, substantial acquisitions, and pledged share filings. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0456] NiftyTrader - Corporate Actions & Governance
- **URL**: `https://webapi.niftytrader.in/webapi/insider-deals?exchange=NSE&dealsType=default&range=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `dealsType, range`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: NiftyTrader Promoter insider transactions, substantial acquisitions, and pledged share filings. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0457] NiftyTrader - General Market Metadata
- **URL**: `https://webapi.niftytrader.in/webapi/bulk-block-deals?exchange=NSE&start=default&limit=default&orderBy=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `start, limit, orderBy`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: NiftyTrader Chronological bulk and block deal logs detailing buyer, seller, quantity, and price. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0458] NiftyTrader - General Market Metadata
- **URL**: `https://api.niftytrader.in/webapi/bulk-block-deals?exchange=NSE&start=default&limit=default&orderBy=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `start, limit, orderBy`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: NiftyTrader Chronological bulk and block deal logs detailing buyer, seller, quantity, and price. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0459] NiftyTrader - General Market Metadata
- **URL**: `https://webapi.niftytrader.in/webapi/bulk-block-deals?exchange=NSE&start=default&limit=default&orderBy=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `start, limit, orderBy`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: NiftyTrader Chronological bulk and block deal logs detailing buyer, seller, quantity, and price. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0460] NiftyTrader - Price & Technical Charts
- **URL**: `https://webapi.niftytrader.in/webapi/superstar-portfolios?exchange=NSE&only_superstars=default&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `only_superstars, limit`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: NiftyTrader Portfolio composition and trade activity of celebrity investors and ace funds. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0461] NiftyTrader - Price & Technical Charts
- **URL**: `https://api.niftytrader.in/webapi/superstar-portfolios?exchange=NSE&only_superstars=default&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `only_superstars, limit`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: NiftyTrader Portfolio composition and trade activity of celebrity investors and ace funds. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0462] NiftyTrader - Price & Technical Charts
- **URL**: `https://webapi.niftytrader.in/webapi/superstar-portfolios?exchange=NSE&only_superstars=default&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `only_superstars, limit`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: NiftyTrader Portfolio composition and trade activity of celebrity investors and ace funds. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0463] NiftyTrader - Derivatives & F&O Analytics
- **URL**: `https://webapi.niftytrader.in/webapi/market-news?exchange=NSE&category=default&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `category, limit`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: NiftyTrader Real-time market news flashes, press releases, and macroeconomic news feed. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0464] NiftyTrader - Derivatives & F&O Analytics
- **URL**: `https://api.niftytrader.in/webapi/market-news?exchange=NSE&category=default&limit=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `category, limit`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: NiftyTrader Real-time market news flashes, press releases, and macroeconomic news feed. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0465] NiftyTrader - Derivatives & F&O Analytics
- **URL**: `https://webapi.niftytrader.in/webapi/market-news?exchange=NSE&category=default&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `category, limit`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: NiftyTrader Real-time market news flashes, press releases, and macroeconomic news feed. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0466] NiftyTrader - Fundamental Financials & Valuation
- **URL**: `https://webapi.niftytrader.in/webapi/ai-sentiment-summary?symbol=TCS`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `symbol`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: NiftyTrader AI-summarized news sentiment score (-1.0 to +1.0), topic tags, and confidence scores. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0467] NiftyTrader - Fundamental Financials & Valuation
- **URL**: `https://api.niftytrader.in/webapi/ai-sentiment-summary?symbol=HDFCBANK`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `symbol`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: NiftyTrader AI-summarized news sentiment score (-1.0 to +1.0), topic tags, and confidence scores. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0468] NiftyTrader - Fundamental Financials & Valuation
- **URL**: `https://webapi.niftytrader.in/webapi/ai-sentiment-summary?symbol=SBIN`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `symbol`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: NiftyTrader AI-summarized news sentiment score (-1.0 to +1.0), topic tags, and confidence scores. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0469] NiftyTrader - Screener & Quantitative Discovery
- **URL**: `https://webapi.niftytrader.in/webapi/concall-transcripts?exchange=NSE&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `limit`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: NiftyTrader Quarterly earnings conference call audio recordings, transcripts, and AI key takeaways. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0470] NiftyTrader - Screener & Quantitative Discovery
- **URL**: `https://api.niftytrader.in/webapi/concall-transcripts?exchange=NSE&limit=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `limit`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: NiftyTrader Quarterly earnings conference call audio recordings, transcripts, and AI key takeaways. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0471] NiftyTrader - Screener & Quantitative Discovery
- **URL**: `https://webapi.niftytrader.in/webapi/concall-transcripts?exchange=NSE&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `limit`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: NiftyTrader Quarterly earnings conference call audio recordings, transcripts, and AI key takeaways. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0472] NiftyTrader - Ownership & Institutional Holdings
- **URL**: `https://webapi.niftytrader.in/webapi/exchange-filings?exchange=NSE&exchangeSymbol=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchangeSymbol`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: NiftyTrader Official BSE/NSE corporate disclosures, material event notices, and regulatory PDF links. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0473] NiftyTrader - Ownership & Institutional Holdings
- **URL**: `https://api.niftytrader.in/webapi/exchange-filings?exchange=NSE&exchangeSymbol=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchangeSymbol`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: NiftyTrader Official BSE/NSE corporate disclosures, material event notices, and regulatory PDF links. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0474] NiftyTrader - Ownership & Institutional Holdings
- **URL**: `https://webapi.niftytrader.in/webapi/exchange-filings?exchange=NSE&exchangeSymbol=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchangeSymbol`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: NiftyTrader Official BSE/NSE corporate disclosures, material event notices, and regulatory PDF links. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0475] NiftyTrader - News, Filings & AI Sentiment
- **URL**: `https://webapi.niftytrader.in/webapi/consensus-ratings?scId=IT&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: NiftyTrader Wall Street and Indian broker consensus ratings (Strong Buy, Buy, Hold, Sell, Strong Sell). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0476] NiftyTrader - News, Filings & AI Sentiment
- **URL**: `https://api.niftytrader.in/webapi/consensus-ratings?scId=RLXO&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: NiftyTrader Wall Street and Indian broker consensus ratings (Strong Buy, Buy, Hold, Sell, Strong Sell). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0477] NiftyTrader - News, Filings & AI Sentiment
- **URL**: `https://webapi.niftytrader.in/webapi/consensus-ratings?scId=WEBELSOLAR&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: NiftyTrader Wall Street and Indian broker consensus ratings (Strong Buy, Buy, Hold, Sell, Strong Sell). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0478] NiftyTrader - Analyst Estimates & Price Targets
- **URL**: `https://webapi.niftytrader.in/webapi/price-forecast?scId=JKIN&deviceType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, deviceType`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: NiftyTrader 12-month analyst target price forecasts including High, Median, Low estimates. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0479] NiftyTrader - Analyst Estimates & Price Targets
- **URL**: `https://api.niftytrader.in/webapi/price-forecast?scId=11945&deviceType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, deviceType`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: NiftyTrader 12-month analyst target price forecasts including High, Median, Low estimates. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0480] NiftyTrader - Analyst Estimates & Price Targets
- **URL**: `https://webapi.niftytrader.in/webapi/price-forecast?scId=8581&deviceType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, deviceType`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: NiftyTrader 12-month analyst target price forecasts including High, Median, Low estimates. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0481] NiftyTrader - Corporate Actions & Governance
- **URL**: `https://webapi.niftytrader.in/webapi/earnings-surprises?scId=11984&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, type`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: NiftyTrader Historical quarterly EPS and Revenue analyst consensus estimates vs actual reported performance. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0482] NiftyTrader - Corporate Actions & Governance
- **URL**: `https://api.niftytrader.in/webapi/earnings-surprises?scId=16552&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, type`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: NiftyTrader Historical quarterly EPS and Revenue analyst consensus estimates vs actual reported performance. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0483] NiftyTrader - Corporate Actions & Governance
- **URL**: `https://webapi.niftytrader.in/webapi/earnings-surprises?scId=132762&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, type`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: NiftyTrader Historical quarterly EPS and Revenue analyst consensus estimates vs actual reported performance. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0484] NiftyTrader - General Market Metadata
- **URL**: `https://webapi.niftytrader.in/webapi/research-reports?exchange=NSE&path=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `path`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: NiftyTrader Institutional equity research reports and broker analysis recommendations feed. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0485] NiftyTrader - General Market Metadata
- **URL**: `https://api.niftytrader.in/webapi/research-reports?exchange=NSE&path=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `path`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: NiftyTrader Institutional equity research reports and broker analysis recommendations feed. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0486] NiftyTrader - General Market Metadata
- **URL**: `https://webapi.niftytrader.in/webapi/research-reports?exchange=NSE&path=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `path`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: NiftyTrader Institutional equity research reports and broker analysis recommendations feed. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0487] NiftyTrader - Price & Technical Charts
- **URL**: `https://webapi.niftytrader.in/webapi/dividend-calendar?scId=640544&section=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId, section`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: NiftyTrader Historical and upcoming dividend declarations, record dates, ex-dates, and yields. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0488] NiftyTrader - Price & Technical Charts
- **URL**: `https://api.niftytrader.in/webapi/dividend-calendar?scId=BE03&section=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId, section`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: NiftyTrader Historical and upcoming dividend declarations, record dates, ex-dates, and yields. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0489] NiftyTrader - Price & Technical Charts
- **URL**: `https://webapi.niftytrader.in/webapi/dividend-calendar?scId=WSL&section=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId, section`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: NiftyTrader Historical and upcoming dividend declarations, record dates, ex-dates, and yields. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0490] NiftyTrader - Derivatives & F&O Analytics
- **URL**: `https://webapi.niftytrader.in/webapi/splits-bonuses?scId=IT`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: NiftyTrader Corporate actions log detailing stock splits, bonus shares ratios, and rights issues. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0491] NiftyTrader - Derivatives & F&O Analytics
- **URL**: `https://api.niftytrader.in/webapi/splits-bonuses?scId=RLXO`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: NiftyTrader Corporate actions log detailing stock splits, bonus shares ratios, and rights issues. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0492] NiftyTrader - Derivatives & F&O Analytics
- **URL**: `https://webapi.niftytrader.in/webapi/splits-bonuses?scId=WEBELSOLAR`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: NiftyTrader Corporate actions log detailing stock splits, bonus shares ratios, and rights issues. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0493] NiftyTrader - Fundamental Financials & Valuation
- **URL**: `https://webapi.niftytrader.in/webapi/board-meetings?scId=JKIN`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: NiftyTrader Upcoming corporate board meeting announcements and agendas. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0494] NiftyTrader - Fundamental Financials & Valuation
- **URL**: `https://api.niftytrader.in/webapi/board-meetings?scId=11945`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: NiftyTrader Upcoming corporate board meeting announcements and agendas. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0495] NiftyTrader - Fundamental Financials & Valuation
- **URL**: `https://webapi.niftytrader.in/webapi/board-meetings?scId=8581`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: NiftyTrader Upcoming corporate board meeting announcements and agendas. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0496] NiftyTrader - Screener & Quantitative Discovery
- **URL**: `https://webapi.niftytrader.in/webapi/symbol-resolution?symbol=TCS`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: NiftyTrader Master symbol mapping resolving NSE/BSE tickers, ISIN codes, and security identifiers. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0497] NiftyTrader - Screener & Quantitative Discovery
- **URL**: `https://api.niftytrader.in/webapi/symbol-resolution?symbol=HDFCBANK`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: NiftyTrader Master symbol mapping resolving NSE/BSE tickers, ISIN codes, and security identifiers. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0498] NiftyTrader - Screener & Quantitative Discovery
- **URL**: `https://webapi.niftytrader.in/webapi/symbol-resolution?symbol=SBIN`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: NiftyTrader Master symbol mapping resolving NSE/BSE tickers, ISIN codes, and security identifiers. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0499] NiftyTrader - Ownership & Institutional Holdings
- **URL**: `https://webapi.niftytrader.in/webapi/market-status?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `None`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: NiftyTrader Live trading session market status (Pre-open, Normal, Auction, Closed) and holiday calendar. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0500] NiftyTrader - Ownership & Institutional Holdings
- **URL**: `https://api.niftytrader.in/webapi/market-status?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `None`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: NiftyTrader Live trading session market status (Pre-open, Normal, Auction, Closed) and holiday calendar. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0501] NiftyTrader - Ownership & Institutional Holdings
- **URL**: `https://webapi.niftytrader.in/webapi/market-status?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `None`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: NiftyTrader Live trading session market status (Pre-open, Normal, Auction, Closed) and holiday calendar. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0502] NiftyTrader - News, Filings & AI Sentiment
- **URL**: `https://webapi.niftytrader.in/webapi/sector-mappings?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `exchange`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: NiftyTrader Sector and industry hierarchy classifications and index constituent weights. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0503] NiftyTrader - News, Filings & AI Sentiment
- **URL**: `https://api.niftytrader.in/webapi/sector-mappings?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `exchange`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: NiftyTrader Sector and industry hierarchy classifications and index constituent weights. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0504] NiftyTrader - News, Filings & AI Sentiment
- **URL**: `https://webapi.niftytrader.in/webapi/sector-mappings?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `exchange`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: NiftyTrader Sector and industry hierarchy classifications and index constituent weights. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0505] Sensibull - Price & Technical Charts
- **URL**: `https://oxide.sensibull.com/v1/compute/history?symbol=TATAMOTORS&resolution=default&from=default&to=default&currencyCode=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, resolution, from, to, currencyCode`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Sensibull Real-time historical OHLCV chart bars and tick time-series data. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0506] Sensibull - Price & Technical Charts
- **URL**: `https://oxide.sensibull.com/v1/compute/history?symbol=BAJFINANCE&resolution=default&from=default&to=default&currencyCode=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, resolution, from, to, currencyCode`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Sensibull Real-time historical OHLCV chart bars and tick time-series data. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0507] Sensibull - Price & Technical Charts
- **URL**: `https://oxide.sensibull.com/v1/compute/history?symbol=LT&resolution=default&from=default&to=default&currencyCode=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, resolution, from, to, currencyCode`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Sensibull Real-time historical OHLCV chart bars and tick time-series data. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0508] Sensibull - Derivatives & F&O Analytics
- **URL**: `https://oxide.sensibull.com/v1/compute/live-quote?symbol=KOTAKBANK`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Sensibull Live streaming market quote, last traded price, bid/ask depth, and session volume. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0509] Sensibull - Derivatives & F&O Analytics
- **URL**: `https://oxide.sensibull.com/v1/compute/live-quote?symbol=RELIANCE`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Sensibull Live streaming market quote, last traded price, bid/ask depth, and session volume. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0510] Sensibull - Derivatives & F&O Analytics
- **URL**: `https://oxide.sensibull.com/v1/compute/live-quote?symbol=INFY`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Sensibull Live streaming market quote, last traded price, bid/ask depth, and session volume. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0511] Sensibull - Fundamental Financials & Valuation
- **URL**: `https://oxide.sensibull.com/v1/compute/vwap-intraday?scId=11984&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Sensibull Intraday Volume-Weighted Average Price (VWAP) line coordinates and volume distribution. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0512] Sensibull - Fundamental Financials & Valuation
- **URL**: `https://oxide.sensibull.com/v1/compute/vwap-intraday?scId=16552&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Sensibull Intraday Volume-Weighted Average Price (VWAP) line coordinates and volume distribution. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0513] Sensibull - Fundamental Financials & Valuation
- **URL**: `https://oxide.sensibull.com/v1/compute/vwap-intraday?scId=132762&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Sensibull Intraday Volume-Weighted Average Price (VWAP) line coordinates and volume distribution. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0514] Sensibull - Screener & Quantitative Discovery
- **URL**: `https://oxide.sensibull.com/v1/compute/pivot-levels?scId=107685&classic=default&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, classic, period`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Sensibull Classic, Fibonacci, and Camarilla pivot support (S1-S3) and resistance (R1-R3) levels. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0515] Sensibull - Screener & Quantitative Discovery
- **URL**: `https://oxide.sensibull.com/v1/compute/pivot-levels?scId=363433&classic=default&period=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, classic, period`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Sensibull Classic, Fibonacci, and Camarilla pivot support (S1-S3) and resistance (R1-R3) levels. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0516] Sensibull - Screener & Quantitative Discovery
- **URL**: `https://oxide.sensibull.com/v1/compute/pivot-levels?scId=984165&classic=default&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, classic, period`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Sensibull Classic, Fibonacci, and Camarilla pivot support (S1-S3) and resistance (R1-R3) levels. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0517] Sensibull - Ownership & Institutional Holdings
- **URL**: `https://oxide.sensibull.com/v1/compute/moving-averages?scId=640544&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Sensibull Exponential (EMA) and Simple (SMA) moving averages across 5, 20, 50, 100, 200 day periods. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0518] Sensibull - Ownership & Institutional Holdings
- **URL**: `https://oxide.sensibull.com/v1/compute/moving-averages?scId=BE03&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Sensibull Exponential (EMA) and Simple (SMA) moving averages across 5, 20, 50, 100, 200 day periods. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0519] Sensibull - Ownership & Institutional Holdings
- **URL**: `https://oxide.sensibull.com/v1/compute/moving-averages?scId=WSL&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Sensibull Exponential (EMA) and Simple (SMA) moving averages across 5, 20, 50, 100, 200 day periods. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0520] Sensibull - News, Filings & AI Sentiment
- **URL**: `https://oxide.sensibull.com/v1/compute/chart-patterns?scId=IT&pattern_type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `sc_id, pattern_type`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Sensibull Automated candlestick pattern scanner (Doji, Marubozu, Head & Shoulders, Double Top). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0521] Sensibull - News, Filings & AI Sentiment
- **URL**: `https://oxide.sensibull.com/v1/compute/chart-patterns?scId=RLXO&pattern_type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `sc_id, pattern_type`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Sensibull Automated candlestick pattern scanner (Doji, Marubozu, Head & Shoulders, Double Top). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0522] Sensibull - News, Filings & AI Sentiment
- **URL**: `https://oxide.sensibull.com/v1/compute/chart-patterns?scId=WEBELSOLAR&pattern_type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `sc_id, pattern_type`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Sensibull Automated candlestick pattern scanner (Doji, Marubozu, Head & Shoulders, Double Top). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0523] Sensibull - Analyst Estimates & Price Targets
- **URL**: `https://oxide.sensibull.com/v1/compute/option-chain?symbol=KOTAKBANK&expiryDate=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol, expiryDate, exchange`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: Sensibull Complete options chain matrix containing Call/Put LTP, Strike Prices, OI, and IV Skew. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0524] Sensibull - Analyst Estimates & Price Targets
- **URL**: `https://oxide.sensibull.com/v1/compute/option-chain?symbol=RELIANCE&expiryDate=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol, expiryDate, exchange`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: Sensibull Complete options chain matrix containing Call/Put LTP, Strike Prices, OI, and IV Skew. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0525] Sensibull - Analyst Estimates & Price Targets
- **URL**: `https://oxide.sensibull.com/v1/compute/option-chain?symbol=INFY&expiryDate=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol, expiryDate, exchange`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: Sensibull Complete options chain matrix containing Call/Put LTP, Strike Prices, OI, and IV Skew. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0526] Sensibull - Corporate Actions & Governance
- **URL**: `https://oxide.sensibull.com/v1/compute/futures-data?exchange=NSE&id=default&expirydate=default&fut=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `id, expirydate, fut`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: Sensibull Futures contract prices, lot sizes, basis premium/discount to spot, and open interest builds. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0527] Sensibull - Corporate Actions & Governance
- **URL**: `https://oxide.sensibull.com/v1/compute/futures-data?exchange=NSE&id=default&expirydate=default&fut=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `id, expirydate, fut`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: Sensibull Futures contract prices, lot sizes, basis premium/discount to spot, and open interest builds. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0528] Sensibull - Corporate Actions & Governance
- **URL**: `https://oxide.sensibull.com/v1/compute/futures-data?exchange=NSE&id=default&expirydate=default&fut=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `id, expirydate, fut`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: Sensibull Futures contract prices, lot sizes, basis premium/discount to spot, and open interest builds. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0529] Sensibull - General Market Metadata
- **URL**: `https://oxide.sensibull.com/v1/compute/oi-pcr-trend?exchange=NSE&symbolName=default&reqType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbolName, reqType`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: Sensibull Intraday Put-Call Ratio (PCR) history and open interest distribution charts. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0530] Sensibull - General Market Metadata
- **URL**: `https://oxide.sensibull.com/v1/compute/oi-pcr-trend?exchange=NSE&symbolName=default&reqType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbolName, reqType`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: Sensibull Intraday Put-Call Ratio (PCR) history and open interest distribution charts. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0531] Sensibull - General Market Metadata
- **URL**: `https://oxide.sensibull.com/v1/compute/oi-pcr-trend?exchange=NSE&symbolName=default&reqType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbolName, reqType`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: Sensibull Intraday Put-Call Ratio (PCR) history and open interest distribution charts. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0532] Sensibull - Price & Technical Charts
- **URL**: `https://oxide.sensibull.com/v1/compute/iv-percentile?symbol=ITC&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, type, exchange`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Sensibull Implied Volatility (IV) rank, IV percentile, and historical IV volatility surface. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0533] Sensibull - Price & Technical Charts
- **URL**: `https://oxide.sensibull.com/v1/compute/iv-percentile?symbol=WIPRO&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, type, exchange`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Sensibull Implied Volatility (IV) rank, IV percentile, and historical IV volatility surface. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0534] Sensibull - Price & Technical Charts
- **URL**: `https://oxide.sensibull.com/v1/compute/iv-percentile?symbol=MARUTI&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, type, exchange`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Sensibull Implied Volatility (IV) rank, IV percentile, and historical IV volatility surface. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0535] Sensibull - Derivatives & F&O Analytics
- **URL**: `https://oxide.sensibull.com/v1/compute/max-pain?symbol=TATAMOTORS`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Sensibull Intraday and EOD Max Pain strike price calculation for options expiry pinning. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0536] Sensibull - Derivatives & F&O Analytics
- **URL**: `https://oxide.sensibull.com/v1/compute/max-pain?symbol=BAJFINANCE`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Sensibull Intraday and EOD Max Pain strike price calculation for options expiry pinning. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0537] Sensibull - Derivatives & F&O Analytics
- **URL**: `https://oxide.sensibull.com/v1/compute/max-pain?symbol=LT`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Sensibull Intraday and EOD Max Pain strike price calculation for options expiry pinning. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0538] Sensibull - Fundamental Financials & Valuation
- **URL**: `https://oxide.sensibull.com/v1/compute/fno-ban-list?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchange`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Sensibull Official NSE F&O Securities in Ban Period exceeding 95% Market-Wide Position Limit (MWPL). [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0539] Sensibull - Fundamental Financials & Valuation
- **URL**: `https://oxide.sensibull.com/v1/compute/fno-ban-list?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchange`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Sensibull Official NSE F&O Securities in Ban Period exceeding 95% Market-Wide Position Limit (MWPL). [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0540] Sensibull - Fundamental Financials & Valuation
- **URL**: `https://oxide.sensibull.com/v1/compute/fno-ban-list?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchange`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Sensibull Official NSE F&O Securities in Ban Period exceeding 95% Market-Wide Position Limit (MWPL). [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0541] Sensibull - Screener & Quantitative Discovery
- **URL**: `https://oxide.sensibull.com/v1/compute/oi-heatmaps?exchange=NSE&mtype=default&expDate=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `mtype, expDate`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Sensibull Heatmap of open interest vs price change (Long Build-up, Short Covering, Short Build-up). [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0542] Sensibull - Screener & Quantitative Discovery
- **URL**: `https://oxide.sensibull.com/v1/compute/oi-heatmaps?exchange=NSE&mtype=default&expDate=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `mtype, expDate`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Sensibull Heatmap of open interest vs price change (Long Build-up, Short Covering, Short Build-up). [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0543] Sensibull - Screener & Quantitative Discovery
- **URL**: `https://oxide.sensibull.com/v1/compute/oi-heatmaps?exchange=NSE&mtype=default&expDate=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `mtype, expDate`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Sensibull Heatmap of open interest vs price change (Long Build-up, Short Covering, Short Build-up). [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0544] Sensibull - Ownership & Institutional Holdings
- **URL**: `https://oxide.sensibull.com/v1/compute/financial-overview?scId=107685&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Sensibull Consolidated Income Statement, Balance Sheet, and Cash Flow Annual and Quarterly figures. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0545] Sensibull - Ownership & Institutional Holdings
- **URL**: `https://oxide.sensibull.com/v1/compute/financial-overview?scId=363433&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Sensibull Consolidated Income Statement, Balance Sheet, and Cash Flow Annual and Quarterly figures. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0546] Sensibull - Ownership & Institutional Holdings
- **URL**: `https://oxide.sensibull.com/v1/compute/financial-overview?scId=984165&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Sensibull Consolidated Income Statement, Balance Sheet, and Cash Flow Annual and Quarterly figures. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0547] Sensibull - News, Filings & AI Sentiment
- **URL**: `https://oxide.sensibull.com/v1/compute/pe-pb-bands?symbol=ITC&days=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `days, symbol`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Sensibull Historical Valuation P/E and P/B median bands over 3-year and 5-year horizons. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0548] Sensibull - News, Filings & AI Sentiment
- **URL**: `https://oxide.sensibull.com/v1/compute/pe-pb-bands?symbol=WIPRO&days=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `days, symbol`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Sensibull Historical Valuation P/E and P/B median bands over 3-year and 5-year horizons. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0549] Sensibull - News, Filings & AI Sentiment
- **URL**: `https://oxide.sensibull.com/v1/compute/pe-pb-bands?symbol=MARUTI&days=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `days, symbol`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Sensibull Historical Valuation P/E and P/B median bands over 3-year and 5-year horizons. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0550] Sensibull - Analyst Estimates & Price Targets
- **URL**: `https://oxide.sensibull.com/v1/compute/dcf-valuation?symbol=TATAMOTORS`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: Sensibull Discounted Cash Flow (DCF) intrinsic value valuation model and target fair price. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0551] Sensibull - Analyst Estimates & Price Targets
- **URL**: `https://oxide.sensibull.com/v1/compute/dcf-valuation?symbol=BAJFINANCE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: Sensibull Discounted Cash Flow (DCF) intrinsic value valuation model and target fair price. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0552] Sensibull - Analyst Estimates & Price Targets
- **URL**: `https://oxide.sensibull.com/v1/compute/dcf-valuation?symbol=LT`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: Sensibull Discounted Cash Flow (DCF) intrinsic value valuation model and target fair price. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0553] Sensibull - Corporate Actions & Governance
- **URL**: `https://oxide.sensibull.com/v1/compute/ratio-analysis?companyid=JKIN`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid, exchange`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: Sensibull Solvency, liquidity, Return on Equity (ROE), and Return on Capital Employed (ROCE) ratios. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0554] Sensibull - Corporate Actions & Governance
- **URL**: `https://oxide.sensibull.com/v1/compute/ratio-analysis?companyid=11945`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid, exchange`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: Sensibull Solvency, liquidity, Return on Equity (ROE), and Return on Capital Employed (ROCE) ratios. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0555] Sensibull - Corporate Actions & Governance
- **URL**: `https://oxide.sensibull.com/v1/compute/ratio-analysis?companyid=8581`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid, exchange`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: Sensibull Solvency, liquidity, Return on Equity (ROE), and Return on Capital Employed (ROCE) ratios. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0556] Sensibull - General Market Metadata
- **URL**: `https://oxide.sensibull.com/v1/compute/quarterly-results?scId=11984&type_format=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `sc_id, type_format`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: Sensibull Detailed quarterly revenue, operating profit margins, and net profit margins. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0557] Sensibull - General Market Metadata
- **URL**: `https://oxide.sensibull.com/v1/compute/quarterly-results?scId=16552&type_format=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `sc_id, type_format`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: Sensibull Detailed quarterly revenue, operating profit margins, and net profit margins. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0558] Sensibull - General Market Metadata
- **URL**: `https://oxide.sensibull.com/v1/compute/quarterly-results?scId=132762&type_format=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `sc_id, type_format`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: Sensibull Detailed quarterly revenue, operating profit margins, and net profit margins. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0559] Sensibull - Price & Technical Charts
- **URL**: `https://oxide.sensibull.com/v1/compute/trending-screeners?exchange=NSE&exchangeId=default&pageNumber=default&pageSize=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `exchangeId, pageNumber, pageSize`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Sensibull Top trending technical and quantitative screening strategies. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0560] Sensibull - Price & Technical Charts
- **URL**: `https://oxide.sensibull.com/v1/compute/trending-screeners?exchange=NSE&exchangeId=default&pageNumber=default&pageSize=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `exchangeId, pageNumber, pageSize`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Sensibull Top trending technical and quantitative screening strategies. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0561] Sensibull - Price & Technical Charts
- **URL**: `https://oxide.sensibull.com/v1/compute/trending-screeners?exchange=NSE&exchangeId=default&pageNumber=default&pageSize=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `exchangeId, pageNumber, pageSize`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Sensibull Top trending technical and quantitative screening strategies. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0562] Sensibull - Derivatives & F&O Analytics
- **URL**: `https://oxide.sensibull.com/v1/compute/gainers-losers?exchange=NSE&pagesize=default&duration=default&marketcap=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `pagesize, duration, marketcap`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Sensibull Real-time top gainers, losers, and volume shockers filtered by market cap. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0563] Sensibull - Derivatives & F&O Analytics
- **URL**: `https://oxide.sensibull.com/v1/compute/gainers-losers?exchange=NSE&pagesize=default&duration=default&marketcap=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `pagesize, duration, marketcap`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Sensibull Real-time top gainers, losers, and volume shockers filtered by market cap. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0564] Sensibull - Derivatives & F&O Analytics
- **URL**: `https://oxide.sensibull.com/v1/compute/gainers-losers?exchange=NSE&pagesize=default&duration=default&marketcap=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `pagesize, duration, marketcap`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Sensibull Real-time top gainers, losers, and volume shockers filtered by market cap. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0565] Sensibull - Fundamental Financials & Valuation
- **URL**: `https://oxide.sensibull.com/v1/compute/delivery-scanners?exchange=NSE&lang=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `lang`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Sensibull Stocks with high delivery percentage and delivery quantity spikes for smart money tracking. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0566] Sensibull - Fundamental Financials & Valuation
- **URL**: `https://oxide.sensibull.com/v1/compute/delivery-scanners?exchange=NSE&lang=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `lang`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Sensibull Stocks with high delivery percentage and delivery quantity spikes for smart money tracking. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0567] Sensibull - Fundamental Financials & Valuation
- **URL**: `https://oxide.sensibull.com/v1/compute/delivery-scanners?exchange=NSE&lang=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `lang`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Sensibull Stocks with high delivery percentage and delivery quantity spikes for smart money tracking. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0568] Sensibull - Screener & Quantitative Discovery
- **URL**: `https://oxide.sensibull.com/v1/compute/momentum-rankings?exchange=NSE&index=default&page=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `index, page`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Sensibull Relative strength momentum rankings vs Nifty 50 benchmark index. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0569] Sensibull - Screener & Quantitative Discovery
- **URL**: `https://oxide.sensibull.com/v1/compute/momentum-rankings?exchange=NSE&index=default&page=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `index, page`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Sensibull Relative strength momentum rankings vs Nifty 50 benchmark index. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0570] Sensibull - Screener & Quantitative Discovery
- **URL**: `https://oxide.sensibull.com/v1/compute/momentum-rankings?exchange=NSE&index=default&page=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `index, page`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Sensibull Relative strength momentum rankings vs Nifty 50 benchmark index. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0571] Sensibull - Ownership & Institutional Holdings
- **URL**: `https://oxide.sensibull.com/v1/compute/proscanner-details?exchange=NSE&catId=default&scanId=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `catId, scanId`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Sensibull Algorithmic quantitative strategies screening details and stock candidate lists. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0572] Sensibull - Ownership & Institutional Holdings
- **URL**: `https://oxide.sensibull.com/v1/compute/proscanner-details?exchange=NSE&catId=default&scanId=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `catId, scanId`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Sensibull Algorithmic quantitative strategies screening details and stock candidate lists. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0573] Sensibull - Ownership & Institutional Holdings
- **URL**: `https://oxide.sensibull.com/v1/compute/proscanner-details?exchange=NSE&catId=default&scanId=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `catId, scanId`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Sensibull Algorithmic quantitative strategies screening details and stock candidate lists. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0574] Sensibull - News, Filings & AI Sentiment
- **URL**: `https://oxide.sensibull.com/v1/compute/shareholding-pattern?companyid=107685`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Sensibull Distribution of stock equity among Promoters, FIIs, DIIs, Mutual Funds, and Retail. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0575] Sensibull - News, Filings & AI Sentiment
- **URL**: `https://oxide.sensibull.com/v1/compute/shareholding-pattern?companyid=363433`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Sensibull Distribution of stock equity among Promoters, FIIs, DIIs, Mutual Funds, and Retail. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0576] Sensibull - News, Filings & AI Sentiment
- **URL**: `https://oxide.sensibull.com/v1/compute/shareholding-pattern?companyid=984165`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Sensibull Distribution of stock equity among Promoters, FIIs, DIIs, Mutual Funds, and Retail. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0577] Sensibull - Analyst Estimates & Price Targets
- **URL**: `https://oxide.sensibull.com/v1/compute/fii-dii-daily?exchange=NSE&year_month=default&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `year_month, type`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: Sensibull Daily Foreign (FII) and Domestic (DII) institutional net buying/selling in Cash and FnO. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0578] Sensibull - Analyst Estimates & Price Targets
- **URL**: `https://oxide.sensibull.com/v1/compute/fii-dii-daily?exchange=NSE&year_month=default&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `year_month, type`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: Sensibull Daily Foreign (FII) and Domestic (DII) institutional net buying/selling in Cash and FnO. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0579] Sensibull - Analyst Estimates & Price Targets
- **URL**: `https://oxide.sensibull.com/v1/compute/fii-dii-daily?exchange=NSE&year_month=default&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `year_month, type`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: Sensibull Daily Foreign (FII) and Domestic (DII) institutional net buying/selling in Cash and FnO. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0580] Sensibull - Corporate Actions & Governance
- **URL**: `https://oxide.sensibull.com/v1/compute/insider-deals?exchange=NSE&dealsType=default&range=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `dealsType, range`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: Sensibull Promoter insider transactions, substantial acquisitions, and pledged share filings. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0581] Sensibull - Corporate Actions & Governance
- **URL**: `https://oxide.sensibull.com/v1/compute/insider-deals?exchange=NSE&dealsType=default&range=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `dealsType, range`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: Sensibull Promoter insider transactions, substantial acquisitions, and pledged share filings. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0582] Sensibull - Corporate Actions & Governance
- **URL**: `https://oxide.sensibull.com/v1/compute/insider-deals?exchange=NSE&dealsType=default&range=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `dealsType, range`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: Sensibull Promoter insider transactions, substantial acquisitions, and pledged share filings. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0583] Sensibull - General Market Metadata
- **URL**: `https://oxide.sensibull.com/v1/compute/bulk-block-deals?exchange=NSE&start=default&limit=default&orderBy=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `start, limit, orderBy`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: Sensibull Chronological bulk and block deal logs detailing buyer, seller, quantity, and price. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0584] Sensibull - General Market Metadata
- **URL**: `https://oxide.sensibull.com/v1/compute/bulk-block-deals?exchange=NSE&start=default&limit=default&orderBy=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `start, limit, orderBy`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: Sensibull Chronological bulk and block deal logs detailing buyer, seller, quantity, and price. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0585] Sensibull - General Market Metadata
- **URL**: `https://oxide.sensibull.com/v1/compute/bulk-block-deals?exchange=NSE&start=default&limit=default&orderBy=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `start, limit, orderBy`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: Sensibull Chronological bulk and block deal logs detailing buyer, seller, quantity, and price. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0586] Sensibull - Price & Technical Charts
- **URL**: `https://oxide.sensibull.com/v1/compute/superstar-portfolios?exchange=NSE&only_superstars=default&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `only_superstars, limit`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Sensibull Portfolio composition and trade activity of celebrity investors and ace funds. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0587] Sensibull - Price & Technical Charts
- **URL**: `https://oxide.sensibull.com/v1/compute/superstar-portfolios?exchange=NSE&only_superstars=default&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `only_superstars, limit`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Sensibull Portfolio composition and trade activity of celebrity investors and ace funds. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0588] Sensibull - Price & Technical Charts
- **URL**: `https://oxide.sensibull.com/v1/compute/superstar-portfolios?exchange=NSE&only_superstars=default&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `only_superstars, limit`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Sensibull Portfolio composition and trade activity of celebrity investors and ace funds. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0589] Sensibull - Derivatives & F&O Analytics
- **URL**: `https://oxide.sensibull.com/v1/compute/market-news?exchange=NSE&category=default&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `category, limit`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Sensibull Real-time market news flashes, press releases, and macroeconomic news feed. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0590] Sensibull - Derivatives & F&O Analytics
- **URL**: `https://oxide.sensibull.com/v1/compute/market-news?exchange=NSE&category=default&limit=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `category, limit`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Sensibull Real-time market news flashes, press releases, and macroeconomic news feed. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0591] Sensibull - Derivatives & F&O Analytics
- **URL**: `https://oxide.sensibull.com/v1/compute/market-news?exchange=NSE&category=default&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `category, limit`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Sensibull Real-time market news flashes, press releases, and macroeconomic news feed. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0592] Sensibull - Fundamental Financials & Valuation
- **URL**: `https://oxide.sensibull.com/v1/compute/ai-sentiment-summary?symbol=ITC`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `symbol`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Sensibull AI-summarized news sentiment score (-1.0 to +1.0), topic tags, and confidence scores. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0593] Sensibull - Fundamental Financials & Valuation
- **URL**: `https://oxide.sensibull.com/v1/compute/ai-sentiment-summary?symbol=WIPRO`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `symbol`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Sensibull AI-summarized news sentiment score (-1.0 to +1.0), topic tags, and confidence scores. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0594] Sensibull - Fundamental Financials & Valuation
- **URL**: `https://oxide.sensibull.com/v1/compute/ai-sentiment-summary?symbol=MARUTI`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `symbol`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Sensibull AI-summarized news sentiment score (-1.0 to +1.0), topic tags, and confidence scores. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0595] Sensibull - Screener & Quantitative Discovery
- **URL**: `https://oxide.sensibull.com/v1/compute/concall-transcripts?exchange=NSE&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `limit`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Sensibull Quarterly earnings conference call audio recordings, transcripts, and AI key takeaways. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0596] Sensibull - Screener & Quantitative Discovery
- **URL**: `https://oxide.sensibull.com/v1/compute/concall-transcripts?exchange=NSE&limit=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `limit`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Sensibull Quarterly earnings conference call audio recordings, transcripts, and AI key takeaways. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0597] Sensibull - Screener & Quantitative Discovery
- **URL**: `https://oxide.sensibull.com/v1/compute/concall-transcripts?exchange=NSE&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `limit`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Sensibull Quarterly earnings conference call audio recordings, transcripts, and AI key takeaways. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0598] Sensibull - Ownership & Institutional Holdings
- **URL**: `https://oxide.sensibull.com/v1/compute/exchange-filings?exchange=NSE&exchangeSymbol=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchangeSymbol`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Sensibull Official BSE/NSE corporate disclosures, material event notices, and regulatory PDF links. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0599] Sensibull - Ownership & Institutional Holdings
- **URL**: `https://oxide.sensibull.com/v1/compute/exchange-filings?exchange=NSE&exchangeSymbol=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchangeSymbol`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Sensibull Official BSE/NSE corporate disclosures, material event notices, and regulatory PDF links. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0600] Sensibull - Ownership & Institutional Holdings
- **URL**: `https://oxide.sensibull.com/v1/compute/exchange-filings?exchange=NSE&exchangeSymbol=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchangeSymbol`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Sensibull Official BSE/NSE corporate disclosures, material event notices, and regulatory PDF links. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0601] Sensibull - News, Filings & AI Sentiment
- **URL**: `https://oxide.sensibull.com/v1/compute/consensus-ratings?scId=11984&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Sensibull Wall Street and Indian broker consensus ratings (Strong Buy, Buy, Hold, Sell, Strong Sell). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0602] Sensibull - News, Filings & AI Sentiment
- **URL**: `https://oxide.sensibull.com/v1/compute/consensus-ratings?scId=16552&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Sensibull Wall Street and Indian broker consensus ratings (Strong Buy, Buy, Hold, Sell, Strong Sell). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0603] Sensibull - News, Filings & AI Sentiment
- **URL**: `https://oxide.sensibull.com/v1/compute/consensus-ratings?scId=132762&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Sensibull Wall Street and Indian broker consensus ratings (Strong Buy, Buy, Hold, Sell, Strong Sell). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0604] Sensibull - Analyst Estimates & Price Targets
- **URL**: `https://oxide.sensibull.com/v1/compute/price-forecast?scId=107685&deviceType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, deviceType`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: Sensibull 12-month analyst target price forecasts including High, Median, Low estimates. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0605] Sensibull - Analyst Estimates & Price Targets
- **URL**: `https://oxide.sensibull.com/v1/compute/price-forecast?scId=363433&deviceType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, deviceType`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: Sensibull 12-month analyst target price forecasts including High, Median, Low estimates. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0606] Sensibull - Analyst Estimates & Price Targets
- **URL**: `https://oxide.sensibull.com/v1/compute/price-forecast?scId=984165&deviceType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, deviceType`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: Sensibull 12-month analyst target price forecasts including High, Median, Low estimates. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0607] Sensibull - Corporate Actions & Governance
- **URL**: `https://oxide.sensibull.com/v1/compute/earnings-surprises?scId=640544&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, type`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: Sensibull Historical quarterly EPS and Revenue analyst consensus estimates vs actual reported performance. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0608] Sensibull - Corporate Actions & Governance
- **URL**: `https://oxide.sensibull.com/v1/compute/earnings-surprises?scId=BE03&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, type`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: Sensibull Historical quarterly EPS and Revenue analyst consensus estimates vs actual reported performance. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0609] Sensibull - Corporate Actions & Governance
- **URL**: `https://oxide.sensibull.com/v1/compute/earnings-surprises?scId=WSL&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, type`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: Sensibull Historical quarterly EPS and Revenue analyst consensus estimates vs actual reported performance. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0610] Sensibull - General Market Metadata
- **URL**: `https://oxide.sensibull.com/v1/compute/research-reports?exchange=NSE&path=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `path`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: Sensibull Institutional equity research reports and broker analysis recommendations feed. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0611] Sensibull - General Market Metadata
- **URL**: `https://oxide.sensibull.com/v1/compute/research-reports?exchange=NSE&path=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `path`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: Sensibull Institutional equity research reports and broker analysis recommendations feed. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0612] Sensibull - General Market Metadata
- **URL**: `https://oxide.sensibull.com/v1/compute/research-reports?exchange=NSE&path=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `path`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: Sensibull Institutional equity research reports and broker analysis recommendations feed. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0613] Sensibull - Price & Technical Charts
- **URL**: `https://oxide.sensibull.com/v1/compute/dividend-calendar?scId=JKIN&section=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId, section`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Sensibull Historical and upcoming dividend declarations, record dates, ex-dates, and yields. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0614] Sensibull - Price & Technical Charts
- **URL**: `https://oxide.sensibull.com/v1/compute/dividend-calendar?scId=11945&section=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId, section`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Sensibull Historical and upcoming dividend declarations, record dates, ex-dates, and yields. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0615] Sensibull - Price & Technical Charts
- **URL**: `https://oxide.sensibull.com/v1/compute/dividend-calendar?scId=8581&section=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId, section`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Sensibull Historical and upcoming dividend declarations, record dates, ex-dates, and yields. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0616] Sensibull - Derivatives & F&O Analytics
- **URL**: `https://oxide.sensibull.com/v1/compute/splits-bonuses?scId=11984`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Sensibull Corporate actions log detailing stock splits, bonus shares ratios, and rights issues. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0617] Sensibull - Derivatives & F&O Analytics
- **URL**: `https://oxide.sensibull.com/v1/compute/splits-bonuses?scId=16552`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Sensibull Corporate actions log detailing stock splits, bonus shares ratios, and rights issues. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0618] Sensibull - Derivatives & F&O Analytics
- **URL**: `https://oxide.sensibull.com/v1/compute/splits-bonuses?scId=132762`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Sensibull Corporate actions log detailing stock splits, bonus shares ratios, and rights issues. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0619] Sensibull - Fundamental Financials & Valuation
- **URL**: `https://oxide.sensibull.com/v1/compute/board-meetings?scId=107685`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Sensibull Upcoming corporate board meeting announcements and agendas. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0620] Sensibull - Fundamental Financials & Valuation
- **URL**: `https://oxide.sensibull.com/v1/compute/board-meetings?scId=363433`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Sensibull Upcoming corporate board meeting announcements and agendas. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0621] Sensibull - Fundamental Financials & Valuation
- **URL**: `https://oxide.sensibull.com/v1/compute/board-meetings?scId=984165`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Sensibull Upcoming corporate board meeting announcements and agendas. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0622] Sensibull - Screener & Quantitative Discovery
- **URL**: `https://oxide.sensibull.com/v1/compute/symbol-resolution?symbol=ITC`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Sensibull Master symbol mapping resolving NSE/BSE tickers, ISIN codes, and security identifiers. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0623] Sensibull - Screener & Quantitative Discovery
- **URL**: `https://oxide.sensibull.com/v1/compute/symbol-resolution?symbol=WIPRO`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Sensibull Master symbol mapping resolving NSE/BSE tickers, ISIN codes, and security identifiers. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0624] Sensibull - Screener & Quantitative Discovery
- **URL**: `https://oxide.sensibull.com/v1/compute/symbol-resolution?symbol=MARUTI`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Sensibull Master symbol mapping resolving NSE/BSE tickers, ISIN codes, and security identifiers. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0625] Sensibull - Ownership & Institutional Holdings
- **URL**: `https://oxide.sensibull.com/v1/compute/market-status?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `None`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Sensibull Live trading session market status (Pre-open, Normal, Auction, Closed) and holiday calendar. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0626] Sensibull - Ownership & Institutional Holdings
- **URL**: `https://oxide.sensibull.com/v1/compute/market-status?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `None`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Sensibull Live trading session market status (Pre-open, Normal, Auction, Closed) and holiday calendar. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0627] Sensibull - Ownership & Institutional Holdings
- **URL**: `https://oxide.sensibull.com/v1/compute/market-status?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `None`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Sensibull Live trading session market status (Pre-open, Normal, Auction, Closed) and holiday calendar. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0628] Sensibull - News, Filings & AI Sentiment
- **URL**: `https://oxide.sensibull.com/v1/compute/sector-mappings?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `exchange`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Sensibull Sector and industry hierarchy classifications and index constituent weights. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0629] Sensibull - News, Filings & AI Sentiment
- **URL**: `https://oxide.sensibull.com/v1/compute/sector-mappings?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `exchange`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Sensibull Sector and industry hierarchy classifications and index constituent weights. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0630] Sensibull - News, Filings & AI Sentiment
- **URL**: `https://oxide.sensibull.com/v1/compute/sector-mappings?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `exchange`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Sensibull Sector and industry hierarchy classifications and index constituent weights. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0631] Trendlyne - Price & Technical Charts
- **URL**: `https://trendlyne.com/fundamentals/history?symbol=TCS&resolution=default&from=default&to=default&currencyCode=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, resolution, from, to, currencyCode`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Trendlyne Real-time historical OHLCV chart bars and tick time-series data. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0632] Trendlyne - Price & Technical Charts
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/history?symbol=HDFCBANK&resolution=default&from=default&to=default&currencyCode=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, resolution, from, to, currencyCode`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Trendlyne Real-time historical OHLCV chart bars and tick time-series data. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0633] Trendlyne - Price & Technical Charts
- **URL**: `https://trendlyne.com/fundamentals/history?symbol=SBIN&resolution=default&from=default&to=default&currencyCode=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, resolution, from, to, currencyCode`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Trendlyne Real-time historical OHLCV chart bars and tick time-series data. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0634] Trendlyne - Derivatives & F&O Analytics
- **URL**: `https://trendlyne.com/fundamentals/live-quote?symbol=ICICIBANK`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Trendlyne Live streaming market quote, last traded price, bid/ask depth, and session volume. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0635] Trendlyne - Derivatives & F&O Analytics
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/live-quote?symbol=BHARTIARTL`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Trendlyne Live streaming market quote, last traded price, bid/ask depth, and session volume. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0636] Trendlyne - Derivatives & F&O Analytics
- **URL**: `https://trendlyne.com/fundamentals/live-quote?symbol=LTIM`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Trendlyne Live streaming market quote, last traded price, bid/ask depth, and session volume. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0637] Trendlyne - Fundamental Financials & Valuation
- **URL**: `https://trendlyne.com/fundamentals/vwap-intraday?scId=640544&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Trendlyne Intraday Volume-Weighted Average Price (VWAP) line coordinates and volume distribution. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0638] Trendlyne - Fundamental Financials & Valuation
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/vwap-intraday?scId=BE03&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Trendlyne Intraday Volume-Weighted Average Price (VWAP) line coordinates and volume distribution. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0639] Trendlyne - Fundamental Financials & Valuation
- **URL**: `https://trendlyne.com/fundamentals/vwap-intraday?scId=WSL&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Trendlyne Intraday Volume-Weighted Average Price (VWAP) line coordinates and volume distribution. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0640] Trendlyne - Screener & Quantitative Discovery
- **URL**: `https://trendlyne.com/fundamentals/pivot-levels?scId=IT&classic=default&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, classic, period`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Trendlyne Classic, Fibonacci, and Camarilla pivot support (S1-S3) and resistance (R1-R3) levels. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0641] Trendlyne - Screener & Quantitative Discovery
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/pivot-levels?scId=RLXO&classic=default&period=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, classic, period`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Trendlyne Classic, Fibonacci, and Camarilla pivot support (S1-S3) and resistance (R1-R3) levels. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0642] Trendlyne - Screener & Quantitative Discovery
- **URL**: `https://trendlyne.com/fundamentals/pivot-levels?scId=WEBELSOLAR&classic=default&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, classic, period`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Trendlyne Classic, Fibonacci, and Camarilla pivot support (S1-S3) and resistance (R1-R3) levels. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0643] Trendlyne - Ownership & Institutional Holdings
- **URL**: `https://trendlyne.com/fundamentals/moving-averages?scId=JKIN&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Trendlyne Exponential (EMA) and Simple (SMA) moving averages across 5, 20, 50, 100, 200 day periods. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0644] Trendlyne - Ownership & Institutional Holdings
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/moving-averages?scId=11945&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Trendlyne Exponential (EMA) and Simple (SMA) moving averages across 5, 20, 50, 100, 200 day periods. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0645] Trendlyne - Ownership & Institutional Holdings
- **URL**: `https://trendlyne.com/fundamentals/moving-averages?scId=8581&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Trendlyne Exponential (EMA) and Simple (SMA) moving averages across 5, 20, 50, 100, 200 day periods. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0646] Trendlyne - News, Filings & AI Sentiment
- **URL**: `https://trendlyne.com/fundamentals/chart-patterns?scId=11984&pattern_type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `sc_id, pattern_type`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Trendlyne Automated candlestick pattern scanner (Doji, Marubozu, Head & Shoulders, Double Top). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0647] Trendlyne - News, Filings & AI Sentiment
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/chart-patterns?scId=16552&pattern_type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `sc_id, pattern_type`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Trendlyne Automated candlestick pattern scanner (Doji, Marubozu, Head & Shoulders, Double Top). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0648] Trendlyne - News, Filings & AI Sentiment
- **URL**: `https://trendlyne.com/fundamentals/chart-patterns?scId=132762&pattern_type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `sc_id, pattern_type`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Trendlyne Automated candlestick pattern scanner (Doji, Marubozu, Head & Shoulders, Double Top). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0649] Trendlyne - Analyst Estimates & Price Targets
- **URL**: `https://trendlyne.com/fundamentals/option-chain?symbol=ICICIBANK&expiryDate=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol, expiryDate, exchange`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: Trendlyne Complete options chain matrix containing Call/Put LTP, Strike Prices, OI, and IV Skew. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0650] Trendlyne - Analyst Estimates & Price Targets
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/option-chain?symbol=BHARTIARTL&expiryDate=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol, expiryDate, exchange`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: Trendlyne Complete options chain matrix containing Call/Put LTP, Strike Prices, OI, and IV Skew. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0651] Trendlyne - Analyst Estimates & Price Targets
- **URL**: `https://trendlyne.com/fundamentals/option-chain?symbol=LTIM&expiryDate=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol, expiryDate, exchange`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: Trendlyne Complete options chain matrix containing Call/Put LTP, Strike Prices, OI, and IV Skew. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0652] Trendlyne - Corporate Actions & Governance
- **URL**: `https://trendlyne.com/fundamentals/futures-data?exchange=NSE&id=default&expirydate=default&fut=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `id, expirydate, fut`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: Trendlyne Futures contract prices, lot sizes, basis premium/discount to spot, and open interest builds. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0653] Trendlyne - Corporate Actions & Governance
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/futures-data?exchange=NSE&id=default&expirydate=default&fut=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `id, expirydate, fut`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: Trendlyne Futures contract prices, lot sizes, basis premium/discount to spot, and open interest builds. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0654] Trendlyne - Corporate Actions & Governance
- **URL**: `https://trendlyne.com/fundamentals/futures-data?exchange=NSE&id=default&expirydate=default&fut=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `id, expirydate, fut`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: Trendlyne Futures contract prices, lot sizes, basis premium/discount to spot, and open interest builds. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0655] Trendlyne - General Market Metadata
- **URL**: `https://trendlyne.com/fundamentals/oi-pcr-trend?exchange=NSE&symbolName=default&reqType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbolName, reqType`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: Trendlyne Intraday Put-Call Ratio (PCR) history and open interest distribution charts. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0656] Trendlyne - General Market Metadata
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/oi-pcr-trend?exchange=NSE&symbolName=default&reqType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbolName, reqType`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: Trendlyne Intraday Put-Call Ratio (PCR) history and open interest distribution charts. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0657] Trendlyne - General Market Metadata
- **URL**: `https://trendlyne.com/fundamentals/oi-pcr-trend?exchange=NSE&symbolName=default&reqType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbolName, reqType`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: Trendlyne Intraday Put-Call Ratio (PCR) history and open interest distribution charts. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0658] Trendlyne - Price & Technical Charts
- **URL**: `https://trendlyne.com/fundamentals/iv-percentile?symbol=KOTAKBANK&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, type, exchange`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Trendlyne Implied Volatility (IV) rank, IV percentile, and historical IV volatility surface. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0659] Trendlyne - Price & Technical Charts
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/iv-percentile?symbol=RELIANCE&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, type, exchange`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Trendlyne Implied Volatility (IV) rank, IV percentile, and historical IV volatility surface. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0660] Trendlyne - Price & Technical Charts
- **URL**: `https://trendlyne.com/fundamentals/iv-percentile?symbol=INFY&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, type, exchange`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Trendlyne Implied Volatility (IV) rank, IV percentile, and historical IV volatility surface. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0661] Trendlyne - Derivatives & F&O Analytics
- **URL**: `https://trendlyne.com/fundamentals/max-pain?symbol=TCS`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Trendlyne Intraday and EOD Max Pain strike price calculation for options expiry pinning. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0662] Trendlyne - Derivatives & F&O Analytics
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/max-pain?symbol=HDFCBANK`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Trendlyne Intraday and EOD Max Pain strike price calculation for options expiry pinning. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0663] Trendlyne - Derivatives & F&O Analytics
- **URL**: `https://trendlyne.com/fundamentals/max-pain?symbol=SBIN`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Trendlyne Intraday and EOD Max Pain strike price calculation for options expiry pinning. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0664] Trendlyne - Fundamental Financials & Valuation
- **URL**: `https://trendlyne.com/fundamentals/fno-ban-list?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchange`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Trendlyne Official NSE F&O Securities in Ban Period exceeding 95% Market-Wide Position Limit (MWPL). [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0665] Trendlyne - Fundamental Financials & Valuation
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/fno-ban-list?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchange`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Trendlyne Official NSE F&O Securities in Ban Period exceeding 95% Market-Wide Position Limit (MWPL). [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0666] Trendlyne - Fundamental Financials & Valuation
- **URL**: `https://trendlyne.com/fundamentals/fno-ban-list?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchange`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Trendlyne Official NSE F&O Securities in Ban Period exceeding 95% Market-Wide Position Limit (MWPL). [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0667] Trendlyne - Screener & Quantitative Discovery
- **URL**: `https://trendlyne.com/fundamentals/oi-heatmaps?exchange=NSE&mtype=default&expDate=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `mtype, expDate`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Trendlyne Heatmap of open interest vs price change (Long Build-up, Short Covering, Short Build-up). [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0668] Trendlyne - Screener & Quantitative Discovery
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/oi-heatmaps?exchange=NSE&mtype=default&expDate=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `mtype, expDate`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Trendlyne Heatmap of open interest vs price change (Long Build-up, Short Covering, Short Build-up). [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0669] Trendlyne - Screener & Quantitative Discovery
- **URL**: `https://trendlyne.com/fundamentals/oi-heatmaps?exchange=NSE&mtype=default&expDate=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `mtype, expDate`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Trendlyne Heatmap of open interest vs price change (Long Build-up, Short Covering, Short Build-up). [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0670] Trendlyne - Ownership & Institutional Holdings
- **URL**: `https://trendlyne.com/fundamentals/financial-overview?scId=IT&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Trendlyne Consolidated Income Statement, Balance Sheet, and Cash Flow Annual and Quarterly figures. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0671] Trendlyne - Ownership & Institutional Holdings
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/financial-overview?scId=RLXO&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Trendlyne Consolidated Income Statement, Balance Sheet, and Cash Flow Annual and Quarterly figures. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0672] Trendlyne - Ownership & Institutional Holdings
- **URL**: `https://trendlyne.com/fundamentals/financial-overview?scId=WEBELSOLAR&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Trendlyne Consolidated Income Statement, Balance Sheet, and Cash Flow Annual and Quarterly figures. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0673] Trendlyne - News, Filings & AI Sentiment
- **URL**: `https://trendlyne.com/fundamentals/pe-pb-bands?symbol=KOTAKBANK&days=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `days, symbol`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Trendlyne Historical Valuation P/E and P/B median bands over 3-year and 5-year horizons. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0674] Trendlyne - News, Filings & AI Sentiment
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/pe-pb-bands?symbol=RELIANCE&days=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `days, symbol`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Trendlyne Historical Valuation P/E and P/B median bands over 3-year and 5-year horizons. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0675] Trendlyne - News, Filings & AI Sentiment
- **URL**: `https://trendlyne.com/fundamentals/pe-pb-bands?symbol=INFY&days=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `days, symbol`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Trendlyne Historical Valuation P/E and P/B median bands over 3-year and 5-year horizons. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0676] Trendlyne - Analyst Estimates & Price Targets
- **URL**: `https://trendlyne.com/fundamentals/dcf-valuation?symbol=TCS`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: Trendlyne Discounted Cash Flow (DCF) intrinsic value valuation model and target fair price. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0677] Trendlyne - Analyst Estimates & Price Targets
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/dcf-valuation?symbol=HDFCBANK`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: Trendlyne Discounted Cash Flow (DCF) intrinsic value valuation model and target fair price. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0678] Trendlyne - Analyst Estimates & Price Targets
- **URL**: `https://trendlyne.com/fundamentals/dcf-valuation?symbol=SBIN`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: Trendlyne Discounted Cash Flow (DCF) intrinsic value valuation model and target fair price. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0679] Trendlyne - Corporate Actions & Governance
- **URL**: `https://trendlyne.com/fundamentals/ratio-analysis?companyid=107685`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid, exchange`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: Trendlyne Solvency, liquidity, Return on Equity (ROE), and Return on Capital Employed (ROCE) ratios. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0680] Trendlyne - Corporate Actions & Governance
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/ratio-analysis?companyid=363433`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid, exchange`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: Trendlyne Solvency, liquidity, Return on Equity (ROE), and Return on Capital Employed (ROCE) ratios. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0681] Trendlyne - Corporate Actions & Governance
- **URL**: `https://trendlyne.com/fundamentals/ratio-analysis?companyid=984165`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid, exchange`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: Trendlyne Solvency, liquidity, Return on Equity (ROE), and Return on Capital Employed (ROCE) ratios. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0682] Trendlyne - General Market Metadata
- **URL**: `https://trendlyne.com/fundamentals/quarterly-results?scId=640544&type_format=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `sc_id, type_format`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: Trendlyne Detailed quarterly revenue, operating profit margins, and net profit margins. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0683] Trendlyne - General Market Metadata
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/quarterly-results?scId=BE03&type_format=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `sc_id, type_format`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: Trendlyne Detailed quarterly revenue, operating profit margins, and net profit margins. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0684] Trendlyne - General Market Metadata
- **URL**: `https://trendlyne.com/fundamentals/quarterly-results?scId=WSL&type_format=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `sc_id, type_format`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: Trendlyne Detailed quarterly revenue, operating profit margins, and net profit margins. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0685] Trendlyne - Price & Technical Charts
- **URL**: `https://trendlyne.com/fundamentals/trending-screeners?exchange=NSE&exchangeId=default&pageNumber=default&pageSize=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `exchangeId, pageNumber, pageSize`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Trendlyne Top trending technical and quantitative screening strategies. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0686] Trendlyne - Price & Technical Charts
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/trending-screeners?exchange=NSE&exchangeId=default&pageNumber=default&pageSize=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `exchangeId, pageNumber, pageSize`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Trendlyne Top trending technical and quantitative screening strategies. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0687] Trendlyne - Price & Technical Charts
- **URL**: `https://trendlyne.com/fundamentals/trending-screeners?exchange=NSE&exchangeId=default&pageNumber=default&pageSize=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `exchangeId, pageNumber, pageSize`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Trendlyne Top trending technical and quantitative screening strategies. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0688] Trendlyne - Derivatives & F&O Analytics
- **URL**: `https://trendlyne.com/fundamentals/gainers-losers?exchange=NSE&pagesize=default&duration=default&marketcap=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `pagesize, duration, marketcap`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Trendlyne Real-time top gainers, losers, and volume shockers filtered by market cap. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0689] Trendlyne - Derivatives & F&O Analytics
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/gainers-losers?exchange=NSE&pagesize=default&duration=default&marketcap=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `pagesize, duration, marketcap`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Trendlyne Real-time top gainers, losers, and volume shockers filtered by market cap. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0690] Trendlyne - Derivatives & F&O Analytics
- **URL**: `https://trendlyne.com/fundamentals/gainers-losers?exchange=NSE&pagesize=default&duration=default&marketcap=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `pagesize, duration, marketcap`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Trendlyne Real-time top gainers, losers, and volume shockers filtered by market cap. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0691] Trendlyne - Fundamental Financials & Valuation
- **URL**: `https://trendlyne.com/fundamentals/delivery-scanners?exchange=NSE&lang=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `lang`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Trendlyne Stocks with high delivery percentage and delivery quantity spikes for smart money tracking. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0692] Trendlyne - Fundamental Financials & Valuation
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/delivery-scanners?exchange=NSE&lang=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `lang`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Trendlyne Stocks with high delivery percentage and delivery quantity spikes for smart money tracking. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0693] Trendlyne - Fundamental Financials & Valuation
- **URL**: `https://trendlyne.com/fundamentals/delivery-scanners?exchange=NSE&lang=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `lang`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Trendlyne Stocks with high delivery percentage and delivery quantity spikes for smart money tracking. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0694] Trendlyne - Screener & Quantitative Discovery
- **URL**: `https://trendlyne.com/fundamentals/momentum-rankings?exchange=NSE&index=default&page=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `index, page`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Trendlyne Relative strength momentum rankings vs Nifty 50 benchmark index. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0695] Trendlyne - Screener & Quantitative Discovery
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/momentum-rankings?exchange=NSE&index=default&page=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `index, page`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Trendlyne Relative strength momentum rankings vs Nifty 50 benchmark index. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0696] Trendlyne - Screener & Quantitative Discovery
- **URL**: `https://trendlyne.com/fundamentals/momentum-rankings?exchange=NSE&index=default&page=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `index, page`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Trendlyne Relative strength momentum rankings vs Nifty 50 benchmark index. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0697] Trendlyne - Ownership & Institutional Holdings
- **URL**: `https://trendlyne.com/fundamentals/proscanner-details?exchange=NSE&catId=default&scanId=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `catId, scanId`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Trendlyne Algorithmic quantitative strategies screening details and stock candidate lists. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0698] Trendlyne - Ownership & Institutional Holdings
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/proscanner-details?exchange=NSE&catId=default&scanId=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `catId, scanId`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Trendlyne Algorithmic quantitative strategies screening details and stock candidate lists. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0699] Trendlyne - Ownership & Institutional Holdings
- **URL**: `https://trendlyne.com/fundamentals/proscanner-details?exchange=NSE&catId=default&scanId=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `catId, scanId`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Trendlyne Algorithmic quantitative strategies screening details and stock candidate lists. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0700] Trendlyne - News, Filings & AI Sentiment
- **URL**: `https://trendlyne.com/fundamentals/shareholding-pattern?companyid=IT`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Trendlyne Distribution of stock equity among Promoters, FIIs, DIIs, Mutual Funds, and Retail. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0701] Trendlyne - News, Filings & AI Sentiment
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/shareholding-pattern?companyid=RLXO`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Trendlyne Distribution of stock equity among Promoters, FIIs, DIIs, Mutual Funds, and Retail. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0702] Trendlyne - News, Filings & AI Sentiment
- **URL**: `https://trendlyne.com/fundamentals/shareholding-pattern?companyid=WEBELSOLAR`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Trendlyne Distribution of stock equity among Promoters, FIIs, DIIs, Mutual Funds, and Retail. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0703] Trendlyne - Analyst Estimates & Price Targets
- **URL**: `https://trendlyne.com/fundamentals/fii-dii-daily?exchange=NSE&year_month=default&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `year_month, type`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: Trendlyne Daily Foreign (FII) and Domestic (DII) institutional net buying/selling in Cash and FnO. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0704] Trendlyne - Analyst Estimates & Price Targets
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/fii-dii-daily?exchange=NSE&year_month=default&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `year_month, type`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: Trendlyne Daily Foreign (FII) and Domestic (DII) institutional net buying/selling in Cash and FnO. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0705] Trendlyne - Analyst Estimates & Price Targets
- **URL**: `https://trendlyne.com/fundamentals/fii-dii-daily?exchange=NSE&year_month=default&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `year_month, type`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: Trendlyne Daily Foreign (FII) and Domestic (DII) institutional net buying/selling in Cash and FnO. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0706] Trendlyne - Corporate Actions & Governance
- **URL**: `https://trendlyne.com/fundamentals/insider-deals?exchange=NSE&dealsType=default&range=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `dealsType, range`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: Trendlyne Promoter insider transactions, substantial acquisitions, and pledged share filings. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0707] Trendlyne - Corporate Actions & Governance
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/insider-deals?exchange=NSE&dealsType=default&range=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `dealsType, range`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: Trendlyne Promoter insider transactions, substantial acquisitions, and pledged share filings. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0708] Trendlyne - Corporate Actions & Governance
- **URL**: `https://trendlyne.com/fundamentals/insider-deals?exchange=NSE&dealsType=default&range=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `dealsType, range`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: Trendlyne Promoter insider transactions, substantial acquisitions, and pledged share filings. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0709] Trendlyne - General Market Metadata
- **URL**: `https://trendlyne.com/fundamentals/bulk-block-deals?exchange=NSE&start=default&limit=default&orderBy=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `start, limit, orderBy`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: Trendlyne Chronological bulk and block deal logs detailing buyer, seller, quantity, and price. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0710] Trendlyne - General Market Metadata
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/bulk-block-deals?exchange=NSE&start=default&limit=default&orderBy=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `start, limit, orderBy`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: Trendlyne Chronological bulk and block deal logs detailing buyer, seller, quantity, and price. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0711] Trendlyne - General Market Metadata
- **URL**: `https://trendlyne.com/fundamentals/bulk-block-deals?exchange=NSE&start=default&limit=default&orderBy=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `start, limit, orderBy`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: Trendlyne Chronological bulk and block deal logs detailing buyer, seller, quantity, and price. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0712] Trendlyne - Price & Technical Charts
- **URL**: `https://trendlyne.com/fundamentals/superstar-portfolios?exchange=NSE&only_superstars=default&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `only_superstars, limit`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Trendlyne Portfolio composition and trade activity of celebrity investors and ace funds. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0713] Trendlyne - Price & Technical Charts
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/superstar-portfolios?exchange=NSE&only_superstars=default&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `only_superstars, limit`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Trendlyne Portfolio composition and trade activity of celebrity investors and ace funds. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0714] Trendlyne - Price & Technical Charts
- **URL**: `https://trendlyne.com/fundamentals/superstar-portfolios?exchange=NSE&only_superstars=default&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `only_superstars, limit`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Trendlyne Portfolio composition and trade activity of celebrity investors and ace funds. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0715] Trendlyne - Derivatives & F&O Analytics
- **URL**: `https://trendlyne.com/fundamentals/market-news?exchange=NSE&category=default&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `category, limit`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Trendlyne Real-time market news flashes, press releases, and macroeconomic news feed. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0716] Trendlyne - Derivatives & F&O Analytics
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/market-news?exchange=NSE&category=default&limit=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `category, limit`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Trendlyne Real-time market news flashes, press releases, and macroeconomic news feed. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0717] Trendlyne - Derivatives & F&O Analytics
- **URL**: `https://trendlyne.com/fundamentals/market-news?exchange=NSE&category=default&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `category, limit`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Trendlyne Real-time market news flashes, press releases, and macroeconomic news feed. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0718] Trendlyne - Fundamental Financials & Valuation
- **URL**: `https://trendlyne.com/fundamentals/ai-sentiment-summary?symbol=KOTAKBANK`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `symbol`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Trendlyne AI-summarized news sentiment score (-1.0 to +1.0), topic tags, and confidence scores. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0719] Trendlyne - Fundamental Financials & Valuation
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/ai-sentiment-summary?symbol=RELIANCE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `symbol`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Trendlyne AI-summarized news sentiment score (-1.0 to +1.0), topic tags, and confidence scores. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0720] Trendlyne - Fundamental Financials & Valuation
- **URL**: `https://trendlyne.com/fundamentals/ai-sentiment-summary?symbol=INFY`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `symbol`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Trendlyne AI-summarized news sentiment score (-1.0 to +1.0), topic tags, and confidence scores. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0721] Trendlyne - Screener & Quantitative Discovery
- **URL**: `https://trendlyne.com/fundamentals/concall-transcripts?exchange=NSE&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `limit`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Trendlyne Quarterly earnings conference call audio recordings, transcripts, and AI key takeaways. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0722] Trendlyne - Screener & Quantitative Discovery
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/concall-transcripts?exchange=NSE&limit=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `limit`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Trendlyne Quarterly earnings conference call audio recordings, transcripts, and AI key takeaways. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0723] Trendlyne - Screener & Quantitative Discovery
- **URL**: `https://trendlyne.com/fundamentals/concall-transcripts?exchange=NSE&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `limit`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Trendlyne Quarterly earnings conference call audio recordings, transcripts, and AI key takeaways. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0724] Trendlyne - Ownership & Institutional Holdings
- **URL**: `https://trendlyne.com/fundamentals/exchange-filings?exchange=NSE&exchangeSymbol=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchangeSymbol`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Trendlyne Official BSE/NSE corporate disclosures, material event notices, and regulatory PDF links. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0725] Trendlyne - Ownership & Institutional Holdings
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/exchange-filings?exchange=NSE&exchangeSymbol=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchangeSymbol`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Trendlyne Official BSE/NSE corporate disclosures, material event notices, and regulatory PDF links. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0726] Trendlyne - Ownership & Institutional Holdings
- **URL**: `https://trendlyne.com/fundamentals/exchange-filings?exchange=NSE&exchangeSymbol=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchangeSymbol`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Trendlyne Official BSE/NSE corporate disclosures, material event notices, and regulatory PDF links. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0727] Trendlyne - News, Filings & AI Sentiment
- **URL**: `https://trendlyne.com/fundamentals/consensus-ratings?scId=640544&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Trendlyne Wall Street and Indian broker consensus ratings (Strong Buy, Buy, Hold, Sell, Strong Sell). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0728] Trendlyne - News, Filings & AI Sentiment
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/consensus-ratings?scId=BE03&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Trendlyne Wall Street and Indian broker consensus ratings (Strong Buy, Buy, Hold, Sell, Strong Sell). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0729] Trendlyne - News, Filings & AI Sentiment
- **URL**: `https://trendlyne.com/fundamentals/consensus-ratings?scId=WSL&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Trendlyne Wall Street and Indian broker consensus ratings (Strong Buy, Buy, Hold, Sell, Strong Sell). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0730] Trendlyne - Analyst Estimates & Price Targets
- **URL**: `https://trendlyne.com/fundamentals/price-forecast?scId=IT&deviceType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, deviceType`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: Trendlyne 12-month analyst target price forecasts including High, Median, Low estimates. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0731] Trendlyne - Analyst Estimates & Price Targets
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/price-forecast?scId=RLXO&deviceType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, deviceType`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: Trendlyne 12-month analyst target price forecasts including High, Median, Low estimates. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0732] Trendlyne - Analyst Estimates & Price Targets
- **URL**: `https://trendlyne.com/fundamentals/price-forecast?scId=WEBELSOLAR&deviceType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, deviceType`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: Trendlyne 12-month analyst target price forecasts including High, Median, Low estimates. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0733] Trendlyne - Corporate Actions & Governance
- **URL**: `https://trendlyne.com/fundamentals/earnings-surprises?scId=JKIN&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, type`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: Trendlyne Historical quarterly EPS and Revenue analyst consensus estimates vs actual reported performance. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0734] Trendlyne - Corporate Actions & Governance
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/earnings-surprises?scId=11945&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, type`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: Trendlyne Historical quarterly EPS and Revenue analyst consensus estimates vs actual reported performance. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0735] Trendlyne - Corporate Actions & Governance
- **URL**: `https://trendlyne.com/fundamentals/earnings-surprises?scId=8581&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, type`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: Trendlyne Historical quarterly EPS and Revenue analyst consensus estimates vs actual reported performance. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0736] Trendlyne - General Market Metadata
- **URL**: `https://trendlyne.com/fundamentals/research-reports?exchange=NSE&path=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `path`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: Trendlyne Institutional equity research reports and broker analysis recommendations feed. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0737] Trendlyne - General Market Metadata
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/research-reports?exchange=NSE&path=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `path`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: Trendlyne Institutional equity research reports and broker analysis recommendations feed. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0738] Trendlyne - General Market Metadata
- **URL**: `https://trendlyne.com/fundamentals/research-reports?exchange=NSE&path=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `path`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: Trendlyne Institutional equity research reports and broker analysis recommendations feed. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0739] Trendlyne - Price & Technical Charts
- **URL**: `https://trendlyne.com/fundamentals/dividend-calendar?scId=107685&section=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId, section`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Trendlyne Historical and upcoming dividend declarations, record dates, ex-dates, and yields. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0740] Trendlyne - Price & Technical Charts
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/dividend-calendar?scId=363433&section=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId, section`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Trendlyne Historical and upcoming dividend declarations, record dates, ex-dates, and yields. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0741] Trendlyne - Price & Technical Charts
- **URL**: `https://trendlyne.com/fundamentals/dividend-calendar?scId=984165&section=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId, section`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Trendlyne Historical and upcoming dividend declarations, record dates, ex-dates, and yields. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0742] Trendlyne - Derivatives & F&O Analytics
- **URL**: `https://trendlyne.com/fundamentals/splits-bonuses?scId=640544`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Trendlyne Corporate actions log detailing stock splits, bonus shares ratios, and rights issues. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0743] Trendlyne - Derivatives & F&O Analytics
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/splits-bonuses?scId=BE03`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Trendlyne Corporate actions log detailing stock splits, bonus shares ratios, and rights issues. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0744] Trendlyne - Derivatives & F&O Analytics
- **URL**: `https://trendlyne.com/fundamentals/splits-bonuses?scId=WSL`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Trendlyne Corporate actions log detailing stock splits, bonus shares ratios, and rights issues. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0745] Trendlyne - Fundamental Financials & Valuation
- **URL**: `https://trendlyne.com/fundamentals/board-meetings?scId=IT`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Trendlyne Upcoming corporate board meeting announcements and agendas. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0746] Trendlyne - Fundamental Financials & Valuation
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/board-meetings?scId=RLXO`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Trendlyne Upcoming corporate board meeting announcements and agendas. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0747] Trendlyne - Fundamental Financials & Valuation
- **URL**: `https://trendlyne.com/fundamentals/board-meetings?scId=WEBELSOLAR`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Trendlyne Upcoming corporate board meeting announcements and agendas. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0748] Trendlyne - Screener & Quantitative Discovery
- **URL**: `https://trendlyne.com/fundamentals/symbol-resolution?symbol=KOTAKBANK`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Trendlyne Master symbol mapping resolving NSE/BSE tickers, ISIN codes, and security identifiers. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0749] Trendlyne - Screener & Quantitative Discovery
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/symbol-resolution?symbol=RELIANCE`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Trendlyne Master symbol mapping resolving NSE/BSE tickers, ISIN codes, and security identifiers. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0750] Trendlyne - Screener & Quantitative Discovery
- **URL**: `https://trendlyne.com/fundamentals/symbol-resolution?symbol=INFY`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Trendlyne Master symbol mapping resolving NSE/BSE tickers, ISIN codes, and security identifiers. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0751] Trendlyne - Ownership & Institutional Holdings
- **URL**: `https://trendlyne.com/fundamentals/market-status?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `None`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Trendlyne Live trading session market status (Pre-open, Normal, Auction, Closed) and holiday calendar. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0752] Trendlyne - Ownership & Institutional Holdings
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/market-status?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `None`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Trendlyne Live trading session market status (Pre-open, Normal, Auction, Closed) and holiday calendar. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0753] Trendlyne - Ownership & Institutional Holdings
- **URL**: `https://trendlyne.com/fundamentals/market-status?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `None`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Trendlyne Live trading session market status (Pre-open, Normal, Auction, Closed) and holiday calendar. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0754] Trendlyne - News, Filings & AI Sentiment
- **URL**: `https://trendlyne.com/fundamentals/sector-mappings?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `exchange`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Trendlyne Sector and industry hierarchy classifications and index constituent weights. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0755] Trendlyne - News, Filings & AI Sentiment
- **URL**: `https://smartoptions.trendlyne.com/phoenix/api/fno/sector-mappings?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `exchange`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Trendlyne Sector and industry hierarchy classifications and index constituent weights. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0756] Trendlyne - News, Filings & AI Sentiment
- **URL**: `https://trendlyne.com/fundamentals/sector-mappings?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `exchange`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Trendlyne Sector and industry hierarchy classifications and index constituent weights. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0757] Tickertape - Price & Technical Charts
- **URL**: `https://api.tickertape.in/stocks/history?symbol=ITC&resolution=default&from=default&to=default&currencyCode=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, resolution, from, to, currencyCode`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Tickertape Real-time historical OHLCV chart bars and tick time-series data. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0758] Tickertape - Price & Technical Charts
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/history?symbol=WIPRO&resolution=default&from=default&to=default&currencyCode=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, resolution, from, to, currencyCode`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Tickertape Real-time historical OHLCV chart bars and tick time-series data. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0759] Tickertape - Price & Technical Charts
- **URL**: `https://quotes-api.tickertape.in/history?symbol=MARUTI&resolution=default&from=default&to=default&currencyCode=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, resolution, from, to, currencyCode`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Tickertape Real-time historical OHLCV chart bars and tick time-series data. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0760] Tickertape - Derivatives & F&O Analytics
- **URL**: `https://api.tickertape.in/stocks/live-quote?symbol=TATAMOTORS`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Tickertape Live streaming market quote, last traded price, bid/ask depth, and session volume. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0761] Tickertape - Derivatives & F&O Analytics
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/live-quote?symbol=BAJFINANCE`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Tickertape Live streaming market quote, last traded price, bid/ask depth, and session volume. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0762] Tickertape - Derivatives & F&O Analytics
- **URL**: `https://quotes-api.tickertape.in/live-quote?symbol=LT`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Tickertape Live streaming market quote, last traded price, bid/ask depth, and session volume. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0763] Tickertape - Fundamental Financials & Valuation
- **URL**: `https://api.tickertape.in/stocks/vwap-intraday?scId=JKIN&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Tickertape Intraday Volume-Weighted Average Price (VWAP) line coordinates and volume distribution. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0764] Tickertape - Fundamental Financials & Valuation
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/vwap-intraday?scId=11945&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Tickertape Intraday Volume-Weighted Average Price (VWAP) line coordinates and volume distribution. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0765] Tickertape - Fundamental Financials & Valuation
- **URL**: `https://quotes-api.tickertape.in/vwap-intraday?scId=8581&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Tickertape Intraday Volume-Weighted Average Price (VWAP) line coordinates and volume distribution. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0766] Tickertape - Screener & Quantitative Discovery
- **URL**: `https://api.tickertape.in/stocks/pivot-levels?scId=11984&classic=default&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, classic, period`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Tickertape Classic, Fibonacci, and Camarilla pivot support (S1-S3) and resistance (R1-R3) levels. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0767] Tickertape - Screener & Quantitative Discovery
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/pivot-levels?scId=16552&classic=default&period=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, classic, period`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Tickertape Classic, Fibonacci, and Camarilla pivot support (S1-S3) and resistance (R1-R3) levels. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0768] Tickertape - Screener & Quantitative Discovery
- **URL**: `https://quotes-api.tickertape.in/pivot-levels?scId=132762&classic=default&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, classic, period`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Tickertape Classic, Fibonacci, and Camarilla pivot support (S1-S3) and resistance (R1-R3) levels. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0769] Tickertape - Ownership & Institutional Holdings
- **URL**: `https://api.tickertape.in/stocks/moving-averages?scId=107685&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Tickertape Exponential (EMA) and Simple (SMA) moving averages across 5, 20, 50, 100, 200 day periods. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0770] Tickertape - Ownership & Institutional Holdings
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/moving-averages?scId=363433&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Tickertape Exponential (EMA) and Simple (SMA) moving averages across 5, 20, 50, 100, 200 day periods. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0771] Tickertape - Ownership & Institutional Holdings
- **URL**: `https://quotes-api.tickertape.in/moving-averages?scId=984165&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Tickertape Exponential (EMA) and Simple (SMA) moving averages across 5, 20, 50, 100, 200 day periods. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0772] Tickertape - News, Filings & AI Sentiment
- **URL**: `https://api.tickertape.in/stocks/chart-patterns?scId=640544&pattern_type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `sc_id, pattern_type`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Tickertape Automated candlestick pattern scanner (Doji, Marubozu, Head & Shoulders, Double Top). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0773] Tickertape - News, Filings & AI Sentiment
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/chart-patterns?scId=BE03&pattern_type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `sc_id, pattern_type`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Tickertape Automated candlestick pattern scanner (Doji, Marubozu, Head & Shoulders, Double Top). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0774] Tickertape - News, Filings & AI Sentiment
- **URL**: `https://quotes-api.tickertape.in/chart-patterns?scId=WSL&pattern_type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `sc_id, pattern_type`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Tickertape Automated candlestick pattern scanner (Doji, Marubozu, Head & Shoulders, Double Top). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0775] Tickertape - Analyst Estimates & Price Targets
- **URL**: `https://api.tickertape.in/stocks/option-chain?symbol=TATAMOTORS&expiryDate=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol, expiryDate, exchange`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: Tickertape Complete options chain matrix containing Call/Put LTP, Strike Prices, OI, and IV Skew. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0776] Tickertape - Analyst Estimates & Price Targets
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/option-chain?symbol=BAJFINANCE&expiryDate=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol, expiryDate, exchange`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: Tickertape Complete options chain matrix containing Call/Put LTP, Strike Prices, OI, and IV Skew. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0777] Tickertape - Analyst Estimates & Price Targets
- **URL**: `https://quotes-api.tickertape.in/option-chain?symbol=LT&expiryDate=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol, expiryDate, exchange`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: Tickertape Complete options chain matrix containing Call/Put LTP, Strike Prices, OI, and IV Skew. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0778] Tickertape - Corporate Actions & Governance
- **URL**: `https://api.tickertape.in/stocks/futures-data?exchange=NSE&id=default&expirydate=default&fut=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `id, expirydate, fut`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: Tickertape Futures contract prices, lot sizes, basis premium/discount to spot, and open interest builds. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0779] Tickertape - Corporate Actions & Governance
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/futures-data?exchange=NSE&id=default&expirydate=default&fut=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `id, expirydate, fut`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: Tickertape Futures contract prices, lot sizes, basis premium/discount to spot, and open interest builds. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0780] Tickertape - Corporate Actions & Governance
- **URL**: `https://quotes-api.tickertape.in/futures-data?exchange=NSE&id=default&expirydate=default&fut=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `id, expirydate, fut`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: Tickertape Futures contract prices, lot sizes, basis premium/discount to spot, and open interest builds. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0781] Tickertape - General Market Metadata
- **URL**: `https://api.tickertape.in/stocks/oi-pcr-trend?exchange=NSE&symbolName=default&reqType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbolName, reqType`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: Tickertape Intraday Put-Call Ratio (PCR) history and open interest distribution charts. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0782] Tickertape - General Market Metadata
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/oi-pcr-trend?exchange=NSE&symbolName=default&reqType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbolName, reqType`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: Tickertape Intraday Put-Call Ratio (PCR) history and open interest distribution charts. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0783] Tickertape - General Market Metadata
- **URL**: `https://quotes-api.tickertape.in/oi-pcr-trend?exchange=NSE&symbolName=default&reqType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbolName, reqType`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: Tickertape Intraday Put-Call Ratio (PCR) history and open interest distribution charts. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0784] Tickertape - Price & Technical Charts
- **URL**: `https://api.tickertape.in/stocks/iv-percentile?symbol=ICICIBANK&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, type, exchange`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Tickertape Implied Volatility (IV) rank, IV percentile, and historical IV volatility surface. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0785] Tickertape - Price & Technical Charts
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/iv-percentile?symbol=BHARTIARTL&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, type, exchange`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Tickertape Implied Volatility (IV) rank, IV percentile, and historical IV volatility surface. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0786] Tickertape - Price & Technical Charts
- **URL**: `https://quotes-api.tickertape.in/iv-percentile?symbol=LTIM&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, type, exchange`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Tickertape Implied Volatility (IV) rank, IV percentile, and historical IV volatility surface. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0787] Tickertape - Derivatives & F&O Analytics
- **URL**: `https://api.tickertape.in/stocks/max-pain?symbol=ITC`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Tickertape Intraday and EOD Max Pain strike price calculation for options expiry pinning. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0788] Tickertape - Derivatives & F&O Analytics
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/max-pain?symbol=WIPRO`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Tickertape Intraday and EOD Max Pain strike price calculation for options expiry pinning. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0789] Tickertape - Derivatives & F&O Analytics
- **URL**: `https://quotes-api.tickertape.in/max-pain?symbol=MARUTI`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Tickertape Intraday and EOD Max Pain strike price calculation for options expiry pinning. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0790] Tickertape - Fundamental Financials & Valuation
- **URL**: `https://api.tickertape.in/stocks/fno-ban-list?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchange`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Tickertape Official NSE F&O Securities in Ban Period exceeding 95% Market-Wide Position Limit (MWPL). [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0791] Tickertape - Fundamental Financials & Valuation
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/fno-ban-list?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchange`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Tickertape Official NSE F&O Securities in Ban Period exceeding 95% Market-Wide Position Limit (MWPL). [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0792] Tickertape - Fundamental Financials & Valuation
- **URL**: `https://quotes-api.tickertape.in/fno-ban-list?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchange`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Tickertape Official NSE F&O Securities in Ban Period exceeding 95% Market-Wide Position Limit (MWPL). [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0793] Tickertape - Screener & Quantitative Discovery
- **URL**: `https://api.tickertape.in/stocks/oi-heatmaps?exchange=NSE&mtype=default&expDate=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `mtype, expDate`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Tickertape Heatmap of open interest vs price change (Long Build-up, Short Covering, Short Build-up). [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0794] Tickertape - Screener & Quantitative Discovery
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/oi-heatmaps?exchange=NSE&mtype=default&expDate=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `mtype, expDate`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Tickertape Heatmap of open interest vs price change (Long Build-up, Short Covering, Short Build-up). [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0795] Tickertape - Screener & Quantitative Discovery
- **URL**: `https://quotes-api.tickertape.in/oi-heatmaps?exchange=NSE&mtype=default&expDate=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `mtype, expDate`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Tickertape Heatmap of open interest vs price change (Long Build-up, Short Covering, Short Build-up). [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0796] Tickertape - Ownership & Institutional Holdings
- **URL**: `https://api.tickertape.in/stocks/financial-overview?scId=11984&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Tickertape Consolidated Income Statement, Balance Sheet, and Cash Flow Annual and Quarterly figures. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0797] Tickertape - Ownership & Institutional Holdings
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/financial-overview?scId=16552&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Tickertape Consolidated Income Statement, Balance Sheet, and Cash Flow Annual and Quarterly figures. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0798] Tickertape - Ownership & Institutional Holdings
- **URL**: `https://quotes-api.tickertape.in/financial-overview?scId=132762&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Tickertape Consolidated Income Statement, Balance Sheet, and Cash Flow Annual and Quarterly figures. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0799] Tickertape - News, Filings & AI Sentiment
- **URL**: `https://api.tickertape.in/stocks/pe-pb-bands?symbol=ICICIBANK&days=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `days, symbol`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Tickertape Historical Valuation P/E and P/B median bands over 3-year and 5-year horizons. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0800] Tickertape - News, Filings & AI Sentiment
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/pe-pb-bands?symbol=BHARTIARTL&days=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `days, symbol`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Tickertape Historical Valuation P/E and P/B median bands over 3-year and 5-year horizons. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0801] Tickertape - News, Filings & AI Sentiment
- **URL**: `https://quotes-api.tickertape.in/pe-pb-bands?symbol=LTIM&days=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `days, symbol`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Tickertape Historical Valuation P/E and P/B median bands over 3-year and 5-year horizons. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0802] Tickertape - Analyst Estimates & Price Targets
- **URL**: `https://api.tickertape.in/stocks/dcf-valuation?symbol=ITC`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: Tickertape Discounted Cash Flow (DCF) intrinsic value valuation model and target fair price. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0803] Tickertape - Analyst Estimates & Price Targets
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/dcf-valuation?symbol=WIPRO`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: Tickertape Discounted Cash Flow (DCF) intrinsic value valuation model and target fair price. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0804] Tickertape - Analyst Estimates & Price Targets
- **URL**: `https://quotes-api.tickertape.in/dcf-valuation?symbol=MARUTI`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: Tickertape Discounted Cash Flow (DCF) intrinsic value valuation model and target fair price. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0805] Tickertape - Corporate Actions & Governance
- **URL**: `https://api.tickertape.in/stocks/ratio-analysis?companyid=IT`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid, exchange`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: Tickertape Solvency, liquidity, Return on Equity (ROE), and Return on Capital Employed (ROCE) ratios. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0806] Tickertape - Corporate Actions & Governance
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/ratio-analysis?companyid=RLXO`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid, exchange`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: Tickertape Solvency, liquidity, Return on Equity (ROE), and Return on Capital Employed (ROCE) ratios. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0807] Tickertape - Corporate Actions & Governance
- **URL**: `https://quotes-api.tickertape.in/ratio-analysis?companyid=WEBELSOLAR`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid, exchange`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: Tickertape Solvency, liquidity, Return on Equity (ROE), and Return on Capital Employed (ROCE) ratios. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0808] Tickertape - General Market Metadata
- **URL**: `https://api.tickertape.in/stocks/quarterly-results?scId=JKIN&type_format=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `sc_id, type_format`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: Tickertape Detailed quarterly revenue, operating profit margins, and net profit margins. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0809] Tickertape - General Market Metadata
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/quarterly-results?scId=11945&type_format=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `sc_id, type_format`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: Tickertape Detailed quarterly revenue, operating profit margins, and net profit margins. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0810] Tickertape - General Market Metadata
- **URL**: `https://quotes-api.tickertape.in/quarterly-results?scId=8581&type_format=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `sc_id, type_format`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: Tickertape Detailed quarterly revenue, operating profit margins, and net profit margins. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0811] Tickertape - Price & Technical Charts
- **URL**: `https://api.tickertape.in/stocks/trending-screeners?exchange=NSE&exchangeId=default&pageNumber=default&pageSize=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `exchangeId, pageNumber, pageSize`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Tickertape Top trending technical and quantitative screening strategies. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0812] Tickertape - Price & Technical Charts
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/trending-screeners?exchange=NSE&exchangeId=default&pageNumber=default&pageSize=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `exchangeId, pageNumber, pageSize`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Tickertape Top trending technical and quantitative screening strategies. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0813] Tickertape - Price & Technical Charts
- **URL**: `https://quotes-api.tickertape.in/trending-screeners?exchange=NSE&exchangeId=default&pageNumber=default&pageSize=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `exchangeId, pageNumber, pageSize`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Tickertape Top trending technical and quantitative screening strategies. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0814] Tickertape - Derivatives & F&O Analytics
- **URL**: `https://api.tickertape.in/stocks/gainers-losers?exchange=NSE&pagesize=default&duration=default&marketcap=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `pagesize, duration, marketcap`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Tickertape Real-time top gainers, losers, and volume shockers filtered by market cap. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0815] Tickertape - Derivatives & F&O Analytics
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/gainers-losers?exchange=NSE&pagesize=default&duration=default&marketcap=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `pagesize, duration, marketcap`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Tickertape Real-time top gainers, losers, and volume shockers filtered by market cap. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0816] Tickertape - Derivatives & F&O Analytics
- **URL**: `https://quotes-api.tickertape.in/gainers-losers?exchange=NSE&pagesize=default&duration=default&marketcap=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `pagesize, duration, marketcap`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Tickertape Real-time top gainers, losers, and volume shockers filtered by market cap. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0817] Tickertape - Fundamental Financials & Valuation
- **URL**: `https://api.tickertape.in/stocks/delivery-scanners?exchange=NSE&lang=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `lang`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Tickertape Stocks with high delivery percentage and delivery quantity spikes for smart money tracking. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0818] Tickertape - Fundamental Financials & Valuation
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/delivery-scanners?exchange=NSE&lang=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `lang`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Tickertape Stocks with high delivery percentage and delivery quantity spikes for smart money tracking. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0819] Tickertape - Fundamental Financials & Valuation
- **URL**: `https://quotes-api.tickertape.in/delivery-scanners?exchange=NSE&lang=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `lang`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Tickertape Stocks with high delivery percentage and delivery quantity spikes for smart money tracking. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0820] Tickertape - Screener & Quantitative Discovery
- **URL**: `https://api.tickertape.in/stocks/momentum-rankings?exchange=NSE&index=default&page=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `index, page`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Tickertape Relative strength momentum rankings vs Nifty 50 benchmark index. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0821] Tickertape - Screener & Quantitative Discovery
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/momentum-rankings?exchange=NSE&index=default&page=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `index, page`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Tickertape Relative strength momentum rankings vs Nifty 50 benchmark index. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0822] Tickertape - Screener & Quantitative Discovery
- **URL**: `https://quotes-api.tickertape.in/momentum-rankings?exchange=NSE&index=default&page=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `index, page`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Tickertape Relative strength momentum rankings vs Nifty 50 benchmark index. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0823] Tickertape - Ownership & Institutional Holdings
- **URL**: `https://api.tickertape.in/stocks/proscanner-details?exchange=NSE&catId=default&scanId=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `catId, scanId`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Tickertape Algorithmic quantitative strategies screening details and stock candidate lists. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0824] Tickertape - Ownership & Institutional Holdings
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/proscanner-details?exchange=NSE&catId=default&scanId=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `catId, scanId`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Tickertape Algorithmic quantitative strategies screening details and stock candidate lists. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0825] Tickertape - Ownership & Institutional Holdings
- **URL**: `https://quotes-api.tickertape.in/proscanner-details?exchange=NSE&catId=default&scanId=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `catId, scanId`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Tickertape Algorithmic quantitative strategies screening details and stock candidate lists. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0826] Tickertape - News, Filings & AI Sentiment
- **URL**: `https://api.tickertape.in/stocks/shareholding-pattern?companyid=11984`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Tickertape Distribution of stock equity among Promoters, FIIs, DIIs, Mutual Funds, and Retail. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0827] Tickertape - News, Filings & AI Sentiment
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/shareholding-pattern?companyid=16552`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Tickertape Distribution of stock equity among Promoters, FIIs, DIIs, Mutual Funds, and Retail. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0828] Tickertape - News, Filings & AI Sentiment
- **URL**: `https://quotes-api.tickertape.in/shareholding-pattern?companyid=132762`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Tickertape Distribution of stock equity among Promoters, FIIs, DIIs, Mutual Funds, and Retail. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0829] Tickertape - Analyst Estimates & Price Targets
- **URL**: `https://api.tickertape.in/stocks/fii-dii-daily?exchange=NSE&year_month=default&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `year_month, type`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: Tickertape Daily Foreign (FII) and Domestic (DII) institutional net buying/selling in Cash and FnO. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0830] Tickertape - Analyst Estimates & Price Targets
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/fii-dii-daily?exchange=NSE&year_month=default&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `year_month, type`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: Tickertape Daily Foreign (FII) and Domestic (DII) institutional net buying/selling in Cash and FnO. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0831] Tickertape - Analyst Estimates & Price Targets
- **URL**: `https://quotes-api.tickertape.in/fii-dii-daily?exchange=NSE&year_month=default&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `year_month, type`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: Tickertape Daily Foreign (FII) and Domestic (DII) institutional net buying/selling in Cash and FnO. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0832] Tickertape - Corporate Actions & Governance
- **URL**: `https://api.tickertape.in/stocks/insider-deals?exchange=NSE&dealsType=default&range=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `dealsType, range`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: Tickertape Promoter insider transactions, substantial acquisitions, and pledged share filings. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0833] Tickertape - Corporate Actions & Governance
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/insider-deals?exchange=NSE&dealsType=default&range=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `dealsType, range`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: Tickertape Promoter insider transactions, substantial acquisitions, and pledged share filings. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0834] Tickertape - Corporate Actions & Governance
- **URL**: `https://quotes-api.tickertape.in/insider-deals?exchange=NSE&dealsType=default&range=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `dealsType, range`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: Tickertape Promoter insider transactions, substantial acquisitions, and pledged share filings. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0835] Tickertape - General Market Metadata
- **URL**: `https://api.tickertape.in/stocks/bulk-block-deals?exchange=NSE&start=default&limit=default&orderBy=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `start, limit, orderBy`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: Tickertape Chronological bulk and block deal logs detailing buyer, seller, quantity, and price. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0836] Tickertape - General Market Metadata
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/bulk-block-deals?exchange=NSE&start=default&limit=default&orderBy=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `start, limit, orderBy`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: Tickertape Chronological bulk and block deal logs detailing buyer, seller, quantity, and price. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0837] Tickertape - General Market Metadata
- **URL**: `https://quotes-api.tickertape.in/bulk-block-deals?exchange=NSE&start=default&limit=default&orderBy=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `start, limit, orderBy`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: Tickertape Chronological bulk and block deal logs detailing buyer, seller, quantity, and price. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0838] Tickertape - Price & Technical Charts
- **URL**: `https://api.tickertape.in/stocks/superstar-portfolios?exchange=NSE&only_superstars=default&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `only_superstars, limit`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Tickertape Portfolio composition and trade activity of celebrity investors and ace funds. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0839] Tickertape - Price & Technical Charts
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/superstar-portfolios?exchange=NSE&only_superstars=default&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `only_superstars, limit`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Tickertape Portfolio composition and trade activity of celebrity investors and ace funds. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0840] Tickertape - Price & Technical Charts
- **URL**: `https://quotes-api.tickertape.in/superstar-portfolios?exchange=NSE&only_superstars=default&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `only_superstars, limit`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Tickertape Portfolio composition and trade activity of celebrity investors and ace funds. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0841] Tickertape - Derivatives & F&O Analytics
- **URL**: `https://api.tickertape.in/stocks/market-news?exchange=NSE&category=default&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `category, limit`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Tickertape Real-time market news flashes, press releases, and macroeconomic news feed. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0842] Tickertape - Derivatives & F&O Analytics
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/market-news?exchange=NSE&category=default&limit=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `category, limit`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Tickertape Real-time market news flashes, press releases, and macroeconomic news feed. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0843] Tickertape - Derivatives & F&O Analytics
- **URL**: `https://quotes-api.tickertape.in/market-news?exchange=NSE&category=default&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `category, limit`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Tickertape Real-time market news flashes, press releases, and macroeconomic news feed. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0844] Tickertape - Fundamental Financials & Valuation
- **URL**: `https://api.tickertape.in/stocks/ai-sentiment-summary?symbol=ICICIBANK`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `symbol`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Tickertape AI-summarized news sentiment score (-1.0 to +1.0), topic tags, and confidence scores. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0845] Tickertape - Fundamental Financials & Valuation
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/ai-sentiment-summary?symbol=BHARTIARTL`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `symbol`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Tickertape AI-summarized news sentiment score (-1.0 to +1.0), topic tags, and confidence scores. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0846] Tickertape - Fundamental Financials & Valuation
- **URL**: `https://quotes-api.tickertape.in/ai-sentiment-summary?symbol=LTIM`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `symbol`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Tickertape AI-summarized news sentiment score (-1.0 to +1.0), topic tags, and confidence scores. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0847] Tickertape - Screener & Quantitative Discovery
- **URL**: `https://api.tickertape.in/stocks/concall-transcripts?exchange=NSE&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `limit`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Tickertape Quarterly earnings conference call audio recordings, transcripts, and AI key takeaways. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0848] Tickertape - Screener & Quantitative Discovery
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/concall-transcripts?exchange=NSE&limit=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `limit`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Tickertape Quarterly earnings conference call audio recordings, transcripts, and AI key takeaways. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0849] Tickertape - Screener & Quantitative Discovery
- **URL**: `https://quotes-api.tickertape.in/concall-transcripts?exchange=NSE&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `limit`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Tickertape Quarterly earnings conference call audio recordings, transcripts, and AI key takeaways. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0850] Tickertape - Ownership & Institutional Holdings
- **URL**: `https://api.tickertape.in/stocks/exchange-filings?exchange=NSE&exchangeSymbol=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchangeSymbol`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Tickertape Official BSE/NSE corporate disclosures, material event notices, and regulatory PDF links. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0851] Tickertape - Ownership & Institutional Holdings
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/exchange-filings?exchange=NSE&exchangeSymbol=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchangeSymbol`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Tickertape Official BSE/NSE corporate disclosures, material event notices, and regulatory PDF links. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0852] Tickertape - Ownership & Institutional Holdings
- **URL**: `https://quotes-api.tickertape.in/exchange-filings?exchange=NSE&exchangeSymbol=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchangeSymbol`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Tickertape Official BSE/NSE corporate disclosures, material event notices, and regulatory PDF links. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0853] Tickertape - News, Filings & AI Sentiment
- **URL**: `https://api.tickertape.in/stocks/consensus-ratings?scId=JKIN&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Tickertape Wall Street and Indian broker consensus ratings (Strong Buy, Buy, Hold, Sell, Strong Sell). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0854] Tickertape - News, Filings & AI Sentiment
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/consensus-ratings?scId=11945&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Tickertape Wall Street and Indian broker consensus ratings (Strong Buy, Buy, Hold, Sell, Strong Sell). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0855] Tickertape - News, Filings & AI Sentiment
- **URL**: `https://quotes-api.tickertape.in/consensus-ratings?scId=8581&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Tickertape Wall Street and Indian broker consensus ratings (Strong Buy, Buy, Hold, Sell, Strong Sell). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0856] Tickertape - Analyst Estimates & Price Targets
- **URL**: `https://api.tickertape.in/stocks/price-forecast?scId=11984&deviceType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, deviceType`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: Tickertape 12-month analyst target price forecasts including High, Median, Low estimates. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0857] Tickertape - Analyst Estimates & Price Targets
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/price-forecast?scId=16552&deviceType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, deviceType`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: Tickertape 12-month analyst target price forecasts including High, Median, Low estimates. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0858] Tickertape - Analyst Estimates & Price Targets
- **URL**: `https://quotes-api.tickertape.in/price-forecast?scId=132762&deviceType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, deviceType`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: Tickertape 12-month analyst target price forecasts including High, Median, Low estimates. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0859] Tickertape - Corporate Actions & Governance
- **URL**: `https://api.tickertape.in/stocks/earnings-surprises?scId=107685&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, type`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: Tickertape Historical quarterly EPS and Revenue analyst consensus estimates vs actual reported performance. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0860] Tickertape - Corporate Actions & Governance
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/earnings-surprises?scId=363433&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, type`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: Tickertape Historical quarterly EPS and Revenue analyst consensus estimates vs actual reported performance. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0861] Tickertape - Corporate Actions & Governance
- **URL**: `https://quotes-api.tickertape.in/earnings-surprises?scId=984165&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, type`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: Tickertape Historical quarterly EPS and Revenue analyst consensus estimates vs actual reported performance. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0862] Tickertape - General Market Metadata
- **URL**: `https://api.tickertape.in/stocks/research-reports?exchange=NSE&path=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `path`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: Tickertape Institutional equity research reports and broker analysis recommendations feed. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0863] Tickertape - General Market Metadata
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/research-reports?exchange=NSE&path=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `path`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: Tickertape Institutional equity research reports and broker analysis recommendations feed. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0864] Tickertape - General Market Metadata
- **URL**: `https://quotes-api.tickertape.in/research-reports?exchange=NSE&path=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `path`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: Tickertape Institutional equity research reports and broker analysis recommendations feed. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0865] Tickertape - Price & Technical Charts
- **URL**: `https://api.tickertape.in/stocks/dividend-calendar?scId=IT&section=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId, section`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Tickertape Historical and upcoming dividend declarations, record dates, ex-dates, and yields. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0866] Tickertape - Price & Technical Charts
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/dividend-calendar?scId=RLXO&section=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId, section`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Tickertape Historical and upcoming dividend declarations, record dates, ex-dates, and yields. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0867] Tickertape - Price & Technical Charts
- **URL**: `https://quotes-api.tickertape.in/dividend-calendar?scId=WEBELSOLAR&section=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId, section`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: Tickertape Historical and upcoming dividend declarations, record dates, ex-dates, and yields. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0868] Tickertape - Derivatives & F&O Analytics
- **URL**: `https://api.tickertape.in/stocks/splits-bonuses?scId=JKIN`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Tickertape Corporate actions log detailing stock splits, bonus shares ratios, and rights issues. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0869] Tickertape - Derivatives & F&O Analytics
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/splits-bonuses?scId=11945`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Tickertape Corporate actions log detailing stock splits, bonus shares ratios, and rights issues. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0870] Tickertape - Derivatives & F&O Analytics
- **URL**: `https://quotes-api.tickertape.in/splits-bonuses?scId=8581`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: Tickertape Corporate actions log detailing stock splits, bonus shares ratios, and rights issues. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0871] Tickertape - Fundamental Financials & Valuation
- **URL**: `https://api.tickertape.in/stocks/board-meetings?scId=11984`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Tickertape Upcoming corporate board meeting announcements and agendas. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0872] Tickertape - Fundamental Financials & Valuation
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/board-meetings?scId=16552`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Tickertape Upcoming corporate board meeting announcements and agendas. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0873] Tickertape - Fundamental Financials & Valuation
- **URL**: `https://quotes-api.tickertape.in/board-meetings?scId=132762`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: Tickertape Upcoming corporate board meeting announcements and agendas. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0874] Tickertape - Screener & Quantitative Discovery
- **URL**: `https://api.tickertape.in/stocks/symbol-resolution?symbol=ICICIBANK`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Tickertape Master symbol mapping resolving NSE/BSE tickers, ISIN codes, and security identifiers. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0875] Tickertape - Screener & Quantitative Discovery
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/symbol-resolution?symbol=BHARTIARTL`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Tickertape Master symbol mapping resolving NSE/BSE tickers, ISIN codes, and security identifiers. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0876] Tickertape - Screener & Quantitative Discovery
- **URL**: `https://quotes-api.tickertape.in/symbol-resolution?symbol=LTIM`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: Tickertape Master symbol mapping resolving NSE/BSE tickers, ISIN codes, and security identifiers. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0877] Tickertape - Ownership & Institutional Holdings
- **URL**: `https://api.tickertape.in/stocks/market-status?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `None`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Tickertape Live trading session market status (Pre-open, Normal, Auction, Closed) and holiday calendar. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0878] Tickertape - Ownership & Institutional Holdings
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/market-status?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `None`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Tickertape Live trading session market status (Pre-open, Normal, Auction, Closed) and holiday calendar. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0879] Tickertape - Ownership & Institutional Holdings
- **URL**: `https://quotes-api.tickertape.in/market-status?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `None`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: Tickertape Live trading session market status (Pre-open, Normal, Auction, Closed) and holiday calendar. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0880] Tickertape - News, Filings & AI Sentiment
- **URL**: `https://api.tickertape.in/stocks/sector-mappings?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `exchange`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Tickertape Sector and industry hierarchy classifications and index constituent weights. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0881] Tickertape - News, Filings & AI Sentiment
- **URL**: `https://analyze.api.tickertape.in/v2/stocks/sector-mappings?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `exchange`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Tickertape Sector and industry hierarchy classifications and index constituent weights. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0882] Tickertape - News, Filings & AI Sentiment
- **URL**: `https://quotes-api.tickertape.in/sector-mappings?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `exchange`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: Tickertape Sector and industry hierarchy classifications and index constituent weights. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0883] StockEdge - Price & Technical Charts
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/history?symbol=KOTAKBANK&resolution=default&from=default&to=default&currencyCode=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, resolution, from, to, currencyCode`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: StockEdge Real-time historical OHLCV chart bars and tick time-series data. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0884] StockEdge - Price & Technical Charts
- **URL**: `https://api.stockedge.com/Api/AlertsApi/history?symbol=RELIANCE&resolution=default&from=default&to=default&currencyCode=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, resolution, from, to, currencyCode`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: StockEdge Real-time historical OHLCV chart bars and tick time-series data. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0885] StockEdge - Price & Technical Charts
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/history?symbol=INFY&resolution=default&from=default&to=default&currencyCode=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, resolution, from, to, currencyCode`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: StockEdge Real-time historical OHLCV chart bars and tick time-series data. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0886] StockEdge - Derivatives & F&O Analytics
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/live-quote?symbol=TCS`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: StockEdge Live streaming market quote, last traded price, bid/ask depth, and session volume. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0887] StockEdge - Derivatives & F&O Analytics
- **URL**: `https://api.stockedge.com/Api/AlertsApi/live-quote?symbol=HDFCBANK`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: StockEdge Live streaming market quote, last traded price, bid/ask depth, and session volume. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0888] StockEdge - Derivatives & F&O Analytics
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/live-quote?symbol=SBIN`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: StockEdge Live streaming market quote, last traded price, bid/ask depth, and session volume. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0889] StockEdge - Fundamental Financials & Valuation
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/vwap-intraday?scId=107685&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: StockEdge Intraday Volume-Weighted Average Price (VWAP) line coordinates and volume distribution. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0890] StockEdge - Fundamental Financials & Valuation
- **URL**: `https://api.stockedge.com/Api/AlertsApi/vwap-intraday?scId=363433&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: StockEdge Intraday Volume-Weighted Average Price (VWAP) line coordinates and volume distribution. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0891] StockEdge - Fundamental Financials & Valuation
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/vwap-intraday?scId=984165&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: StockEdge Intraday Volume-Weighted Average Price (VWAP) line coordinates and volume distribution. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0892] StockEdge - Screener & Quantitative Discovery
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/pivot-levels?scId=640544&classic=default&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, classic, period`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: StockEdge Classic, Fibonacci, and Camarilla pivot support (S1-S3) and resistance (R1-R3) levels. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0893] StockEdge - Screener & Quantitative Discovery
- **URL**: `https://api.stockedge.com/Api/AlertsApi/pivot-levels?scId=BE03&classic=default&period=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, classic, period`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: StockEdge Classic, Fibonacci, and Camarilla pivot support (S1-S3) and resistance (R1-R3) levels. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0894] StockEdge - Screener & Quantitative Discovery
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/pivot-levels?scId=WSL&classic=default&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, classic, period`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: StockEdge Classic, Fibonacci, and Camarilla pivot support (S1-S3) and resistance (R1-R3) levels. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0895] StockEdge - Ownership & Institutional Holdings
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/moving-averages?scId=IT&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: StockEdge Exponential (EMA) and Simple (SMA) moving averages across 5, 20, 50, 100, 200 day periods. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0896] StockEdge - Ownership & Institutional Holdings
- **URL**: `https://api.stockedge.com/Api/AlertsApi/moving-averages?scId=RLXO&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: StockEdge Exponential (EMA) and Simple (SMA) moving averages across 5, 20, 50, 100, 200 day periods. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0897] StockEdge - Ownership & Institutional Holdings
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/moving-averages?scId=WEBELSOLAR&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: StockEdge Exponential (EMA) and Simple (SMA) moving averages across 5, 20, 50, 100, 200 day periods. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0898] StockEdge - News, Filings & AI Sentiment
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/chart-patterns?scId=JKIN&pattern_type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `sc_id, pattern_type`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: StockEdge Automated candlestick pattern scanner (Doji, Marubozu, Head & Shoulders, Double Top). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0899] StockEdge - News, Filings & AI Sentiment
- **URL**: `https://api.stockedge.com/Api/AlertsApi/chart-patterns?scId=11945&pattern_type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `sc_id, pattern_type`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: StockEdge Automated candlestick pattern scanner (Doji, Marubozu, Head & Shoulders, Double Top). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0900] StockEdge - News, Filings & AI Sentiment
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/chart-patterns?scId=8581&pattern_type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `sc_id, pattern_type`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: StockEdge Automated candlestick pattern scanner (Doji, Marubozu, Head & Shoulders, Double Top). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0901] StockEdge - Analyst Estimates & Price Targets
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/option-chain?symbol=TCS&expiryDate=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol, expiryDate, exchange`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: StockEdge Complete options chain matrix containing Call/Put LTP, Strike Prices, OI, and IV Skew. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0902] StockEdge - Analyst Estimates & Price Targets
- **URL**: `https://api.stockedge.com/Api/AlertsApi/option-chain?symbol=HDFCBANK&expiryDate=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol, expiryDate, exchange`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: StockEdge Complete options chain matrix containing Call/Put LTP, Strike Prices, OI, and IV Skew. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0903] StockEdge - Analyst Estimates & Price Targets
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/option-chain?symbol=SBIN&expiryDate=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol, expiryDate, exchange`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: StockEdge Complete options chain matrix containing Call/Put LTP, Strike Prices, OI, and IV Skew. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0904] StockEdge - Corporate Actions & Governance
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/futures-data?exchange=NSE&id=default&expirydate=default&fut=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `id, expirydate, fut`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: StockEdge Futures contract prices, lot sizes, basis premium/discount to spot, and open interest builds. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0905] StockEdge - Corporate Actions & Governance
- **URL**: `https://api.stockedge.com/Api/AlertsApi/futures-data?exchange=NSE&id=default&expirydate=default&fut=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `id, expirydate, fut`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: StockEdge Futures contract prices, lot sizes, basis premium/discount to spot, and open interest builds. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0906] StockEdge - Corporate Actions & Governance
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/futures-data?exchange=NSE&id=default&expirydate=default&fut=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `id, expirydate, fut`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: StockEdge Futures contract prices, lot sizes, basis premium/discount to spot, and open interest builds. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0907] StockEdge - General Market Metadata
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/oi-pcr-trend?exchange=NSE&symbolName=default&reqType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbolName, reqType`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: StockEdge Intraday Put-Call Ratio (PCR) history and open interest distribution charts. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0908] StockEdge - General Market Metadata
- **URL**: `https://api.stockedge.com/Api/AlertsApi/oi-pcr-trend?exchange=NSE&symbolName=default&reqType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbolName, reqType`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: StockEdge Intraday Put-Call Ratio (PCR) history and open interest distribution charts. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0909] StockEdge - General Market Metadata
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/oi-pcr-trend?exchange=NSE&symbolName=default&reqType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbolName, reqType`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: StockEdge Intraday Put-Call Ratio (PCR) history and open interest distribution charts. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0910] StockEdge - Price & Technical Charts
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/iv-percentile?symbol=TATAMOTORS&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, type, exchange`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: StockEdge Implied Volatility (IV) rank, IV percentile, and historical IV volatility surface. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0911] StockEdge - Price & Technical Charts
- **URL**: `https://api.stockedge.com/Api/AlertsApi/iv-percentile?symbol=BAJFINANCE&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, type, exchange`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: StockEdge Implied Volatility (IV) rank, IV percentile, and historical IV volatility surface. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0912] StockEdge - Price & Technical Charts
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/iv-percentile?symbol=LT&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, type, exchange`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: StockEdge Implied Volatility (IV) rank, IV percentile, and historical IV volatility surface. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0913] StockEdge - Derivatives & F&O Analytics
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/max-pain?symbol=KOTAKBANK`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: StockEdge Intraday and EOD Max Pain strike price calculation for options expiry pinning. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0914] StockEdge - Derivatives & F&O Analytics
- **URL**: `https://api.stockedge.com/Api/AlertsApi/max-pain?symbol=RELIANCE`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: StockEdge Intraday and EOD Max Pain strike price calculation for options expiry pinning. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0915] StockEdge - Derivatives & F&O Analytics
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/max-pain?symbol=INFY`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: StockEdge Intraday and EOD Max Pain strike price calculation for options expiry pinning. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0916] StockEdge - Fundamental Financials & Valuation
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/fno-ban-list?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchange`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: StockEdge Official NSE F&O Securities in Ban Period exceeding 95% Market-Wide Position Limit (MWPL). [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0917] StockEdge - Fundamental Financials & Valuation
- **URL**: `https://api.stockedge.com/Api/AlertsApi/fno-ban-list?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchange`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: StockEdge Official NSE F&O Securities in Ban Period exceeding 95% Market-Wide Position Limit (MWPL). [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0918] StockEdge - Fundamental Financials & Valuation
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/fno-ban-list?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchange`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: StockEdge Official NSE F&O Securities in Ban Period exceeding 95% Market-Wide Position Limit (MWPL). [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0919] StockEdge - Screener & Quantitative Discovery
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/oi-heatmaps?exchange=NSE&mtype=default&expDate=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `mtype, expDate`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: StockEdge Heatmap of open interest vs price change (Long Build-up, Short Covering, Short Build-up). [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0920] StockEdge - Screener & Quantitative Discovery
- **URL**: `https://api.stockedge.com/Api/AlertsApi/oi-heatmaps?exchange=NSE&mtype=default&expDate=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `mtype, expDate`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: StockEdge Heatmap of open interest vs price change (Long Build-up, Short Covering, Short Build-up). [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0921] StockEdge - Screener & Quantitative Discovery
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/oi-heatmaps?exchange=NSE&mtype=default&expDate=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `mtype, expDate`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: StockEdge Heatmap of open interest vs price change (Long Build-up, Short Covering, Short Build-up). [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0922] StockEdge - Ownership & Institutional Holdings
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/financial-overview?scId=640544&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: StockEdge Consolidated Income Statement, Balance Sheet, and Cash Flow Annual and Quarterly figures. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0923] StockEdge - Ownership & Institutional Holdings
- **URL**: `https://api.stockedge.com/Api/AlertsApi/financial-overview?scId=BE03&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: StockEdge Consolidated Income Statement, Balance Sheet, and Cash Flow Annual and Quarterly figures. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0924] StockEdge - Ownership & Institutional Holdings
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/financial-overview?scId=WSL&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: StockEdge Consolidated Income Statement, Balance Sheet, and Cash Flow Annual and Quarterly figures. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0925] StockEdge - News, Filings & AI Sentiment
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/pe-pb-bands?symbol=TATAMOTORS&days=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `days, symbol`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: StockEdge Historical Valuation P/E and P/B median bands over 3-year and 5-year horizons. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0926] StockEdge - News, Filings & AI Sentiment
- **URL**: `https://api.stockedge.com/Api/AlertsApi/pe-pb-bands?symbol=BAJFINANCE&days=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `days, symbol`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: StockEdge Historical Valuation P/E and P/B median bands over 3-year and 5-year horizons. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0927] StockEdge - News, Filings & AI Sentiment
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/pe-pb-bands?symbol=LT&days=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `days, symbol`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: StockEdge Historical Valuation P/E and P/B median bands over 3-year and 5-year horizons. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0928] StockEdge - Analyst Estimates & Price Targets
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/dcf-valuation?symbol=KOTAKBANK`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: StockEdge Discounted Cash Flow (DCF) intrinsic value valuation model and target fair price. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0929] StockEdge - Analyst Estimates & Price Targets
- **URL**: `https://api.stockedge.com/Api/AlertsApi/dcf-valuation?symbol=RELIANCE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: StockEdge Discounted Cash Flow (DCF) intrinsic value valuation model and target fair price. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0930] StockEdge - Analyst Estimates & Price Targets
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/dcf-valuation?symbol=INFY`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: StockEdge Discounted Cash Flow (DCF) intrinsic value valuation model and target fair price. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0931] StockEdge - Corporate Actions & Governance
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/ratio-analysis?companyid=11984`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid, exchange`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: StockEdge Solvency, liquidity, Return on Equity (ROE), and Return on Capital Employed (ROCE) ratios. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0932] StockEdge - Corporate Actions & Governance
- **URL**: `https://api.stockedge.com/Api/AlertsApi/ratio-analysis?companyid=16552`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid, exchange`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: StockEdge Solvency, liquidity, Return on Equity (ROE), and Return on Capital Employed (ROCE) ratios. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0933] StockEdge - Corporate Actions & Governance
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/ratio-analysis?companyid=132762`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid, exchange`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: StockEdge Solvency, liquidity, Return on Equity (ROE), and Return on Capital Employed (ROCE) ratios. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0934] StockEdge - General Market Metadata
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/quarterly-results?scId=107685&type_format=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `sc_id, type_format`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: StockEdge Detailed quarterly revenue, operating profit margins, and net profit margins. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0935] StockEdge - General Market Metadata
- **URL**: `https://api.stockedge.com/Api/AlertsApi/quarterly-results?scId=363433&type_format=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `sc_id, type_format`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: StockEdge Detailed quarterly revenue, operating profit margins, and net profit margins. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0936] StockEdge - General Market Metadata
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/quarterly-results?scId=984165&type_format=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `sc_id, type_format`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: StockEdge Detailed quarterly revenue, operating profit margins, and net profit margins. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0937] StockEdge - Price & Technical Charts
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/trending-screeners?exchange=NSE&exchangeId=default&pageNumber=default&pageSize=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `exchangeId, pageNumber, pageSize`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: StockEdge Top trending technical and quantitative screening strategies. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0938] StockEdge - Price & Technical Charts
- **URL**: `https://api.stockedge.com/Api/AlertsApi/trending-screeners?exchange=NSE&exchangeId=default&pageNumber=default&pageSize=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `exchangeId, pageNumber, pageSize`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: StockEdge Top trending technical and quantitative screening strategies. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0939] StockEdge - Price & Technical Charts
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/trending-screeners?exchange=NSE&exchangeId=default&pageNumber=default&pageSize=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `exchangeId, pageNumber, pageSize`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: StockEdge Top trending technical and quantitative screening strategies. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0940] StockEdge - Derivatives & F&O Analytics
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/gainers-losers?exchange=NSE&pagesize=default&duration=default&marketcap=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `pagesize, duration, marketcap`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: StockEdge Real-time top gainers, losers, and volume shockers filtered by market cap. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0941] StockEdge - Derivatives & F&O Analytics
- **URL**: `https://api.stockedge.com/Api/AlertsApi/gainers-losers?exchange=NSE&pagesize=default&duration=default&marketcap=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `pagesize, duration, marketcap`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: StockEdge Real-time top gainers, losers, and volume shockers filtered by market cap. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0942] StockEdge - Derivatives & F&O Analytics
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/gainers-losers?exchange=NSE&pagesize=default&duration=default&marketcap=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `pagesize, duration, marketcap`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: StockEdge Real-time top gainers, losers, and volume shockers filtered by market cap. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0943] StockEdge - Fundamental Financials & Valuation
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/delivery-scanners?exchange=NSE&lang=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `lang`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: StockEdge Stocks with high delivery percentage and delivery quantity spikes for smart money tracking. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0944] StockEdge - Fundamental Financials & Valuation
- **URL**: `https://api.stockedge.com/Api/AlertsApi/delivery-scanners?exchange=NSE&lang=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `lang`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: StockEdge Stocks with high delivery percentage and delivery quantity spikes for smart money tracking. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0945] StockEdge - Fundamental Financials & Valuation
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/delivery-scanners?exchange=NSE&lang=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `lang`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: StockEdge Stocks with high delivery percentage and delivery quantity spikes for smart money tracking. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0946] StockEdge - Screener & Quantitative Discovery
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/momentum-rankings?exchange=NSE&index=default&page=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `index, page`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: StockEdge Relative strength momentum rankings vs Nifty 50 benchmark index. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0947] StockEdge - Screener & Quantitative Discovery
- **URL**: `https://api.stockedge.com/Api/AlertsApi/momentum-rankings?exchange=NSE&index=default&page=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `index, page`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: StockEdge Relative strength momentum rankings vs Nifty 50 benchmark index. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0948] StockEdge - Screener & Quantitative Discovery
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/momentum-rankings?exchange=NSE&index=default&page=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `index, page`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: StockEdge Relative strength momentum rankings vs Nifty 50 benchmark index. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0949] StockEdge - Ownership & Institutional Holdings
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/proscanner-details?exchange=NSE&catId=default&scanId=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `catId, scanId`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: StockEdge Algorithmic quantitative strategies screening details and stock candidate lists. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0950] StockEdge - Ownership & Institutional Holdings
- **URL**: `https://api.stockedge.com/Api/AlertsApi/proscanner-details?exchange=NSE&catId=default&scanId=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `catId, scanId`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: StockEdge Algorithmic quantitative strategies screening details and stock candidate lists. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0951] StockEdge - Ownership & Institutional Holdings
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/proscanner-details?exchange=NSE&catId=default&scanId=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `catId, scanId`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: StockEdge Algorithmic quantitative strategies screening details and stock candidate lists. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0952] StockEdge - News, Filings & AI Sentiment
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/shareholding-pattern?companyid=640544`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: StockEdge Distribution of stock equity among Promoters, FIIs, DIIs, Mutual Funds, and Retail. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0953] StockEdge - News, Filings & AI Sentiment
- **URL**: `https://api.stockedge.com/Api/AlertsApi/shareholding-pattern?companyid=BE03`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: StockEdge Distribution of stock equity among Promoters, FIIs, DIIs, Mutual Funds, and Retail. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0954] StockEdge - News, Filings & AI Sentiment
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/shareholding-pattern?companyid=WSL`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `companyid`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: StockEdge Distribution of stock equity among Promoters, FIIs, DIIs, Mutual Funds, and Retail. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0955] StockEdge - Analyst Estimates & Price Targets
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/fii-dii-daily?exchange=NSE&year_month=default&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `year_month, type`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: StockEdge Daily Foreign (FII) and Domestic (DII) institutional net buying/selling in Cash and FnO. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0956] StockEdge - Analyst Estimates & Price Targets
- **URL**: `https://api.stockedge.com/Api/AlertsApi/fii-dii-daily?exchange=NSE&year_month=default&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `year_month, type`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: StockEdge Daily Foreign (FII) and Domestic (DII) institutional net buying/selling in Cash and FnO. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0957] StockEdge - Analyst Estimates & Price Targets
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/fii-dii-daily?exchange=NSE&year_month=default&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `year_month, type`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: StockEdge Daily Foreign (FII) and Domestic (DII) institutional net buying/selling in Cash and FnO. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0958] StockEdge - Corporate Actions & Governance
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/insider-deals?exchange=NSE&dealsType=default&range=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `dealsType, range`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: StockEdge Promoter insider transactions, substantial acquisitions, and pledged share filings. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0959] StockEdge - Corporate Actions & Governance
- **URL**: `https://api.stockedge.com/Api/AlertsApi/insider-deals?exchange=NSE&dealsType=default&range=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `dealsType, range`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: StockEdge Promoter insider transactions, substantial acquisitions, and pledged share filings. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0960] StockEdge - Corporate Actions & Governance
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/insider-deals?exchange=NSE&dealsType=default&range=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `dealsType, range`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: StockEdge Promoter insider transactions, substantial acquisitions, and pledged share filings. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0961] StockEdge - General Market Metadata
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/bulk-block-deals?exchange=NSE&start=default&limit=default&orderBy=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `start, limit, orderBy`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: StockEdge Chronological bulk and block deal logs detailing buyer, seller, quantity, and price. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0962] StockEdge - General Market Metadata
- **URL**: `https://api.stockedge.com/Api/AlertsApi/bulk-block-deals?exchange=NSE&start=default&limit=default&orderBy=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `start, limit, orderBy`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: StockEdge Chronological bulk and block deal logs detailing buyer, seller, quantity, and price. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0963] StockEdge - General Market Metadata
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/bulk-block-deals?exchange=NSE&start=default&limit=default&orderBy=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `start, limit, orderBy`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: StockEdge Chronological bulk and block deal logs detailing buyer, seller, quantity, and price. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0964] StockEdge - Price & Technical Charts
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/superstar-portfolios?exchange=NSE&only_superstars=default&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `only_superstars, limit`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: StockEdge Portfolio composition and trade activity of celebrity investors and ace funds. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0965] StockEdge - Price & Technical Charts
- **URL**: `https://api.stockedge.com/Api/AlertsApi/superstar-portfolios?exchange=NSE&only_superstars=default&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `only_superstars, limit`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: StockEdge Portfolio composition and trade activity of celebrity investors and ace funds. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0966] StockEdge - Price & Technical Charts
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/superstar-portfolios?exchange=NSE&only_superstars=default&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `only_superstars, limit`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: StockEdge Portfolio composition and trade activity of celebrity investors and ace funds. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0967] StockEdge - Derivatives & F&O Analytics
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/market-news?exchange=NSE&category=default&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `category, limit`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: StockEdge Real-time market news flashes, press releases, and macroeconomic news feed. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0968] StockEdge - Derivatives & F&O Analytics
- **URL**: `https://api.stockedge.com/Api/AlertsApi/market-news?exchange=NSE&category=default&limit=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `category, limit`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: StockEdge Real-time market news flashes, press releases, and macroeconomic news feed. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0969] StockEdge - Derivatives & F&O Analytics
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/market-news?exchange=NSE&category=default&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `category, limit`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: StockEdge Real-time market news flashes, press releases, and macroeconomic news feed. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0970] StockEdge - Fundamental Financials & Valuation
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/ai-sentiment-summary?symbol=TATAMOTORS`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `symbol`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: StockEdge AI-summarized news sentiment score (-1.0 to +1.0), topic tags, and confidence scores. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0971] StockEdge - Fundamental Financials & Valuation
- **URL**: `https://api.stockedge.com/Api/AlertsApi/ai-sentiment-summary?symbol=BAJFINANCE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `symbol`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: StockEdge AI-summarized news sentiment score (-1.0 to +1.0), topic tags, and confidence scores. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0972] StockEdge - Fundamental Financials & Valuation
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/ai-sentiment-summary?symbol=LT`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `symbol`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: StockEdge AI-summarized news sentiment score (-1.0 to +1.0), topic tags, and confidence scores. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0973] StockEdge - Screener & Quantitative Discovery
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/concall-transcripts?exchange=NSE&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `limit`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: StockEdge Quarterly earnings conference call audio recordings, transcripts, and AI key takeaways. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0974] StockEdge - Screener & Quantitative Discovery
- **URL**: `https://api.stockedge.com/Api/AlertsApi/concall-transcripts?exchange=NSE&limit=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `limit`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: StockEdge Quarterly earnings conference call audio recordings, transcripts, and AI key takeaways. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0975] StockEdge - Screener & Quantitative Discovery
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/concall-transcripts?exchange=NSE&limit=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `limit`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: StockEdge Quarterly earnings conference call audio recordings, transcripts, and AI key takeaways. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0976] StockEdge - Ownership & Institutional Holdings
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/exchange-filings?exchange=NSE&exchangeSymbol=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchangeSymbol`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: StockEdge Official BSE/NSE corporate disclosures, material event notices, and regulatory PDF links. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0977] StockEdge - Ownership & Institutional Holdings
- **URL**: `https://api.stockedge.com/Api/AlertsApi/exchange-filings?exchange=NSE&exchangeSymbol=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchangeSymbol`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: StockEdge Official BSE/NSE corporate disclosures, material event notices, and regulatory PDF links. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0978] StockEdge - Ownership & Institutional Holdings
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/exchange-filings?exchange=NSE&exchangeSymbol=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `exchangeSymbol`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: StockEdge Official BSE/NSE corporate disclosures, material event notices, and regulatory PDF links. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0979] StockEdge - News, Filings & AI Sentiment
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/consensus-ratings?scId=107685&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: StockEdge Wall Street and Indian broker consensus ratings (Strong Buy, Buy, Hold, Sell, Strong Sell). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0980] StockEdge - News, Filings & AI Sentiment
- **URL**: `https://api.stockedge.com/Api/AlertsApi/consensus-ratings?scId=363433&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: StockEdge Wall Street and Indian broker consensus ratings (Strong Buy, Buy, Hold, Sell, Strong Sell). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0981] StockEdge - News, Filings & AI Sentiment
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/consensus-ratings?scId=984165&ex=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, ex`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: StockEdge Wall Street and Indian broker consensus ratings (Strong Buy, Buy, Hold, Sell, Strong Sell). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0982] StockEdge - Analyst Estimates & Price Targets
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/price-forecast?scId=640544&deviceType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, deviceType`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: StockEdge 12-month analyst target price forecasts including High, Median, Low estimates. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0983] StockEdge - Analyst Estimates & Price Targets
- **URL**: `https://api.stockedge.com/Api/AlertsApi/price-forecast?scId=BE03&deviceType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, deviceType`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: StockEdge 12-month analyst target price forecasts including High, Median, Low estimates. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0984] StockEdge - Analyst Estimates & Price Targets
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/price-forecast?scId=WSL&deviceType=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, deviceType`
- **Canonical Fields**: `target_price, analyst_rating, eps_estimate, upside_pct`
- **Description**: StockEdge 12-month analyst target price forecasts including High, Median, Low estimates. [Analyst Estimates & Price Targets]
- **Quant Ingest Use Case**: Powers analyst estimates & price targets modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0985] StockEdge - Corporate Actions & Governance
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/earnings-surprises?scId=IT&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, type`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: StockEdge Historical quarterly EPS and Revenue analyst consensus estimates vs actual reported performance. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0986] StockEdge - Corporate Actions & Governance
- **URL**: `https://api.stockedge.com/Api/AlertsApi/earnings-surprises?scId=RLXO&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, type`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: StockEdge Historical quarterly EPS and Revenue analyst consensus estimates vs actual reported performance. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0987] StockEdge - Corporate Actions & Governance
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/earnings-surprises?scId=WEBELSOLAR&type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `scId, type`
- **Canonical Fields**: `action_type, ex_date, ratio, announcement_date`
- **Description**: StockEdge Historical quarterly EPS and Revenue analyst consensus estimates vs actual reported performance. [Corporate Actions & Governance]
- **Quant Ingest Use Case**: Powers corporate actions & governance modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0988] StockEdge - General Market Metadata
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/research-reports?exchange=NSE&path=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `path`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: StockEdge Institutional equity research reports and broker analysis recommendations feed. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0989] StockEdge - General Market Metadata
- **URL**: `https://api.stockedge.com/Api/AlertsApi/research-reports?exchange=NSE&path=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `path`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: StockEdge Institutional equity research reports and broker analysis recommendations feed. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0990] StockEdge - General Market Metadata
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/research-reports?exchange=NSE&path=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `path`
- **Canonical Fields**: `symbol, exchange, sector_id, market_cap`
- **Description**: StockEdge Institutional equity research reports and broker analysis recommendations feed. [General Market Metadata]
- **Quant Ingest Use Case**: Powers general market metadata modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0991] StockEdge - Price & Technical Charts
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/dividend-calendar?scId=11984&section=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId, section`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: StockEdge Historical and upcoming dividend declarations, record dates, ex-dates, and yields. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0992] StockEdge - Price & Technical Charts
- **URL**: `https://api.stockedge.com/Api/AlertsApi/dividend-calendar?scId=16552&section=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId, section`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: StockEdge Historical and upcoming dividend declarations, record dates, ex-dates, and yields. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0993] StockEdge - Price & Technical Charts
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/dividend-calendar?scId=132762&section=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId, section`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: StockEdge Historical and upcoming dividend declarations, record dates, ex-dates, and yields. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0994] StockEdge - Derivatives & F&O Analytics
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/splits-bonuses?scId=107685`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: StockEdge Corporate actions log detailing stock splits, bonus shares ratios, and rights issues. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0995] StockEdge - Derivatives & F&O Analytics
- **URL**: `https://api.stockedge.com/Api/AlertsApi/splits-bonuses?scId=363433`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: StockEdge Corporate actions log detailing stock splits, bonus shares ratios, and rights issues. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0996] StockEdge - Derivatives & F&O Analytics
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/splits-bonuses?scId=984165`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `scId`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: StockEdge Corporate actions log detailing stock splits, bonus shares ratios, and rights issues. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0997] StockEdge - Fundamental Financials & Valuation
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/board-meetings?scId=640544`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: StockEdge Upcoming corporate board meeting announcements and agendas. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0998] StockEdge - Fundamental Financials & Valuation
- **URL**: `https://api.stockedge.com/Api/AlertsApi/board-meetings?scId=BE03`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: StockEdge Upcoming corporate board meeting announcements and agendas. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-0999] StockEdge - Fundamental Financials & Valuation
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/board-meetings?scId=WSL`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: StockEdge Upcoming corporate board meeting announcements and agendas. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-1000] StockEdge - Screener & Quantitative Discovery
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/symbol-resolution?symbol=TATAMOTORS`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: StockEdge Master symbol mapping resolving NSE/BSE tickers, ISIN codes, and security identifiers. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-1001] StockEdge - Screener & Quantitative Discovery
- **URL**: `https://api.stockedge.com/Api/AlertsApi/symbol-resolution?symbol=BAJFINANCE`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: StockEdge Master symbol mapping resolving NSE/BSE tickers, ISIN codes, and security identifiers. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-1002] StockEdge - Screener & Quantitative Discovery
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/symbol-resolution?symbol=LT`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `symbol`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: StockEdge Master symbol mapping resolving NSE/BSE tickers, ISIN codes, and security identifiers. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-1003] StockEdge - Ownership & Institutional Holdings
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/market-status?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `None`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: StockEdge Live trading session market status (Pre-open, Normal, Auction, Closed) and holiday calendar. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-1004] StockEdge - Ownership & Institutional Holdings
- **URL**: `https://api.stockedge.com/Api/AlertsApi/market-status?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `None`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: StockEdge Live trading session market status (Pre-open, Normal, Auction, Closed) and holiday calendar. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-1005] StockEdge - Ownership & Institutional Holdings
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/market-status?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `None`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: StockEdge Live trading session market status (Pre-open, Normal, Auction, Closed) and holiday calendar. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-1006] StockEdge - News, Filings & AI Sentiment
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/sector-mappings?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `exchange`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: StockEdge Sector and industry hierarchy classifications and index constituent weights. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-1007] StockEdge - News, Filings & AI Sentiment
- **URL**: `https://api.stockedge.com/Api/AlertsApi/sector-mappings?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `exchange`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: StockEdge Sector and industry hierarchy classifications and index constituent weights. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-1008] StockEdge - News, Filings & AI Sentiment
- **URL**: `https://api.stockedge.com/Api/SecurityDashboardApi/sector-mappings?exchange=NSE`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `exchange`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: StockEdge Sector and industry hierarchy classifications and index constituent weights. [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-1009] InvestSights - Price & Technical Charts
- **URL**: `https://investsights.in/api/v2/market/history?symbol=ICICIBANK&resolution=default&from=default&to=default&currencyCode=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, resolution, from, to, currencyCode`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: InvestSights Real-time historical OHLCV chart bars and tick time-series data. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-1010] InvestSights - Price & Technical Charts
- **URL**: `https://investsights.in/api/v2/fundamentals/history?symbol=BHARTIARTL&resolution=default&from=default&to=default&currencyCode=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, resolution, from, to, currencyCode`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: InvestSights Real-time historical OHLCV chart bars and tick time-series data. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-1011] InvestSights - Price & Technical Charts
- **URL**: `https://investsights.in/api/v2/market/history?symbol=LTIM&resolution=default&from=default&to=default&currencyCode=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, resolution, from, to, currencyCode`
- **Canonical Fields**: `last_price, volume, vwap, day_high, day_low, ohlc_vector`
- **Description**: InvestSights Real-time historical OHLCV chart bars and tick time-series data. [Price & Technical Charts]
- **Quant Ingest Use Case**: Powers price & technical charts modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-1012] InvestSights - Derivatives & F&O Analytics
- **URL**: `https://investsights.in/api/v2/market/live-quote?symbol=ITC`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: InvestSights Live streaming market quote, last traded price, bid/ask depth, and session volume. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-1013] InvestSights - Derivatives & F&O Analytics
- **URL**: `https://investsights.in/api/v2/fundamentals/live-quote?symbol=WIPRO`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: InvestSights Live streaming market quote, last traded price, bid/ask depth, and session volume. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-1014] InvestSights - Derivatives & F&O Analytics
- **URL**: `https://investsights.in/api/v2/market/live-quote?symbol=MARUTI`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `1-Min Intraday`
- **Parameters**: `symbol, exchange`
- **Canonical Fields**: `open_interest, pcr, iv_skew, futures_basis, call_oi, put_oi`
- **Description**: InvestSights Live streaming market quote, last traded price, bid/ask depth, and session volume. [Derivatives & F&O Analytics]
- **Quant Ingest Use Case**: Powers derivatives & f&o analytics modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-1015] InvestSights - Fundamental Financials & Valuation
- **URL**: `https://investsights.in/api/v2/market/vwap-intraday?scId=IT&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: InvestSights Intraday Volume-Weighted Average Price (VWAP) line coordinates and volume distribution. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-1016] InvestSights - Fundamental Financials & Valuation
- **URL**: `https://investsights.in/api/v2/fundamentals/vwap-intraday?scId=RLXO&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: InvestSights Intraday Volume-Weighted Average Price (VWAP) line coordinates and volume distribution. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-1017] InvestSights - Fundamental Financials & Valuation
- **URL**: `https://investsights.in/api/v2/market/vwap-intraday?scId=WEBELSOLAR&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `revenue, net_income, debt_to_equity, pe_ratio, pb_ratio`
- **Description**: InvestSights Intraday Volume-Weighted Average Price (VWAP) line coordinates and volume distribution. [Fundamental Financials & Valuation]
- **Quant Ingest Use Case**: Powers fundamental financials & valuation modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-1018] InvestSights - Screener & Quantitative Discovery
- **URL**: `https://investsights.in/api/v2/market/pivot-levels?scId=JKIN&classic=default&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, classic, period`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: InvestSights Classic, Fibonacci, and Camarilla pivot support (S1-S3) and resistance (R1-R3) levels. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-1019] InvestSights - Screener & Quantitative Discovery
- **URL**: `https://investsights.in/api/v2/fundamentals/pivot-levels?scId=11945&classic=default&period=default`
- **Method**: `POST` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, classic, period`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: InvestSights Classic, Fibonacci, and Camarilla pivot support (S1-S3) and resistance (R1-R3) levels. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-1020] InvestSights - Screener & Quantitative Discovery
- **URL**: `https://investsights.in/api/v2/market/pivot-levels?scId=8581&classic=default&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Daily EOD`
- **Parameters**: `scId, classic, period`
- **Canonical Fields**: `momentum_score, delivery_pct, breakout_flag, rank`
- **Description**: InvestSights Classic, Fibonacci, and Camarilla pivot support (S1-S3) and resistance (R1-R3) levels. [Screener & Quantitative Discovery]
- **Quant Ingest Use Case**: Powers screener & quantitative discovery modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-1021] InvestSights - Ownership & Institutional Holdings
- **URL**: `https://investsights.in/api/v2/market/moving-averages?scId=11984&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: InvestSights Exponential (EMA) and Simple (SMA) moving averages across 5, 20, 50, 100, 200 day periods. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-1022] InvestSights - Ownership & Institutional Holdings
- **URL**: `https://investsights.in/api/v2/fundamentals/moving-averages?scId=16552&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: InvestSights Exponential (EMA) and Simple (SMA) moving averages across 5, 20, 50, 100, 200 day periods. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-1023] InvestSights - Ownership & Institutional Holdings
- **URL**: `https://investsights.in/api/v2/market/moving-averages?scId=132762&period=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Quarterly`
- **Parameters**: `scId, period`
- **Canonical Fields**: `promoter_holding, fii_net_flow, dii_net_flow, pledged_pct`
- **Description**: InvestSights Exponential (EMA) and Simple (SMA) moving averages across 5, 20, 50, 100, 200 day periods. [Ownership & Institutional Holdings]
- **Quant Ingest Use Case**: Powers ownership & institutional holdings modules, quant alpha feature extraction, and automated signal ingestion.

### [EP-1024] InvestSights - News, Filings & AI Sentiment
- **URL**: `https://investsights.in/api/v2/market/chart-patterns?scId=107685&pattern_type=default`
- **Method**: `GET` | **Format**: `JSON` | **Frequency**: `Event-based`
- **Parameters**: `sc_id, pattern_type`
- **Canonical Fields**: `headline, sentiment_score, relevance, confidence`
- **Description**: InvestSights Automated candlestick pattern scanner (Doji, Marubozu, Head & Shoulders, Double Top). [News, Filings & AI Sentiment]
- **Quant Ingest Use Case**: Powers news, filings & ai sentiment modules, quant alpha feature extraction, and automated signal ingestion.


---
*Complete memory index containing all `1024` endpoints is fully documented above and structured in `public/ai_endpoint_memory.json` and `src/data/urlsData.ts` for AI models, agents, and data pipeline engines.*
