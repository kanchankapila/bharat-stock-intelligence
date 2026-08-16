# Data Source Integration Guide

Verified against the repository on 2026-08-12.

This document catalogs the external market, fundamental, news, alternative-data, AI, and
operational integrations used by Bharat Stock Intelligence. It is written so that another
project can reproduce the integrations without inheriting this application's scoring or UI.

It documents endpoint families rather than promising that undocumented third-party APIs are
stable. These providers can change payloads, block automated traffic, or impose licensing terms
without notice. Confirm permission, terms of use, and live response shape before production use.

## 1. Integration Architecture

### 1.1 Canonical security identifier

Use the uppercase NSE symbol as the canonical stock key everywhere:

```text
HDFCBANK, INFY, RELIANCE, BAJAJ-AUTO
```

Never make a provider ID canonical and never infer an opaque provider ID from another provider.
The authoritative mappings are in:

- `src/data/stocklist.ts`: TypeScript provider-ID mapping table.
- `src/data/nseStocks.ts`: broad NSE universe without all provider IDs.
- `src/server/stockMapping.ts`: lookup and MoneyControl autocomplete fallback.
- `scripts/stocklist.json`: Python-facing provider-ID map used by whole-universe fetchers.

| Provider | Mapping field | Example | Resolution rule |
|---|---|---|---|
| NSE/internal | `symbol` | `HDFCBANK` | Canonical |
| Yahoo Finance | derived | `HDFCBANK.NS` | NSE symbol plus `.NS` |
| MoneyControl | `mcsymbol` | `HDF01` | Explicit map, then autocomplete |
| Trendlyne | `tlid`, `tlname` | `533`, `hdfc-bank-ltd` | Explicit map |
| ET/Indiatimes | `companyid` | `9195` | Explicit map |
| ISIN | `isin` | `INE040A01034` | Explicit universal identifier |
| MoneyControl/MarketsMojo | `stockid` | `592009` | Explicit shared ID |
| TickerTape | `tickertape_sid` | provider slug | Explicit map |
| BSE | `scripcode`, `fincode` | numeric | Explicit map |

For indices, keep a separate mapping. `src/server/stockMapping.ts` contains MoneyControl index
IDs and symbols because equity IDs and index IDs are different namespaces.

### 1.1.1 Mapping `stocklist.json` into stock URL templates

As measured on 2026-08-12, `scripts/stocklist.json` has 2,005 rows and 2,001 unique NSE symbols.
Four symbols are duplicated (`RNAVAL`, `WOCKPHARMA`, `KOPRAN`, and `RATEGAIN`), so a whole-universe
runner must validate or deduplicate by uppercase `symbol` before scheduling requests. Provider-field
coverage is intentionally incomplete:

| Field | Mapped rows | URL parameter/path forms |
|---|---:|---|
| `symbol` | 2,005 | `symbol`, `symbolName`, `exchangeSymbol`; Yahoo path as `{symbol}.NS` |
| `mcsymbol` | 1,982 | `scId`, `sc_id`, `sc_did`, `scDid`; MoneyControl path segments |
| `tlid` / `tlname` | 2,004 / 2,004 | Trendlyne numeric ID and company slug |
| `isin` | 1,981 | Provider endpoints that accept ISIN |
| `stockid` | 1,832 | `sid`, `stockid`, `stockID`; MarketsMojo and Trading80 |
| `companyid` | 1,972 | `companyid`, `companyId`; ET/Indiatimes |
| `tickertape_sid` | 1,812 | TickerTape stock slug/path ID |
| `fincode` | 1,894 | Finology/Indiatimes `fincode` |
| `scripcode` | 1,787 | BSE numeric security code |

The generic registry in `endpoint_registry.py` owns this parameter-to-field translation. Each
endpoint is stored as a template such as:

```text
https://marketservices.indiatimes.com/marketservices/shareholding?companyid={companyid}
https://frapi.marketsmojo.com/stocks_quality/vcardinfo?sid={stockid}
https://api.moneycontrol.com/mcapi/v1/stock/financials?scId={mcsymbol}
https://query2.finance.yahoo.com/v8/finance/chart/{symbol}.NS
```

For every concrete URL in `urls.normalized.txt`, first classify its scope and replace only known
stock-specific values with the corresponding placeholder. Preserve all constants such as period,
page size, exchange, scan ID, or event type. Do not assume every numeric query value is a stock ID.
The registry recognizes these stock parameter aliases:

```python
STOCK_FIELD_PARAMS = {
  "symbol": "symbol", "symbolName": "symbol", "exchangeSymbol": "symbol",
  "scId": "mcsymbol", "sc_id": "mcsymbol", "sc_did": "mcsymbol", "scDid": "mcsymbol",
  "companyid": "companyid", "companyId": "companyid",
  "sid": "stockid", "stockid": "stockid", "stockID": "stockid",
  "tlid": "tlid", "fincode": "fincode", "scripcode": "scripcode",
}
```

Path IDs and derived IDs must be declared explicitly because query-key inspection cannot discover
them. Examples are `{tlname}`, `{tickertape_sid}`, `{mcsymbol}` in a path, and Yahoo's derived
`{symbol}.NS`. Store each endpoint's `required_ids`; render it only when the row has every required
field. Missing provider IDs are coverage gaps to report, not reasons to substitute the NSE symbol.

The repository's `extra_endpoints_fetcher.py` uses this whole-mapped-universe algorithm:

```python
stocks_by_symbol = {}
for row in json.load(open("scripts/stocklist.json", encoding="utf-8")):
  symbol = row["symbol"].upper()
  if symbol in stocks_by_symbol and stocks_by_symbol[symbol] != row:
    raise ValueError(f"conflicting duplicate mapping: {symbol}")
  stocks_by_symbol[symbol] = row

tasks = []
missing_by_endpoint = {}
for symbol, stock in sorted(stocks_by_symbol.items()):
  for endpoint in stock_endpoints:
    missing = [field for field in endpoint.required_ids if not stock.get(field)]
    if missing:
      missing_by_endpoint.setdefault(endpoint.name, []).append((symbol, missing))
      continue
    tasks.append((symbol, endpoint.name, endpoint.url_template.format(**stock)))
```

Run market-scoped endpoints once, then run the generated stock tasks with bounded concurrency,
per-provider rate limits, retries, and a durable `(symbol, endpoint_name)` result key. Report for
each endpoint: eligible unique symbols, skipped missing mappings, successful non-empty responses,
schema failures, and HTTP failures. “Whole universe” for an opaque-ID endpoint means every unique
symbol with that provider ID, not all 2,366 entries in `nseStocks.ts`.

To expand beyond the 2,001-symbol mapped universe, start from active `nse_stocks`/
`src/data/nseStocks.ts`, resolve the provider ID through an exact provider search or ISIN-supported
endpoint, validate the returned NSE symbol/ISIN, and persist the mapping with provenance. Never
guess `companyid`, `stockid`, `tlid`, `mcsymbol`, `fincode`, or `scripcode`.

### 1.1.2 Indices: use a separate provider map

Do not pass index names through `stocklist.json`. The canonical index name maps independently to a
provider-specific ID or bridge symbol:

| Provider/use | Mapping source | Example |
|---|---|---|
| MoneyControl read-through | `indexMapping.ts` / `stockMapping.ts` | `NIFTY 50 -> id=9, symbol=in;NSX` |
| Python ingestion | `index_provider_map` via `load_index_map[_inv]()` | `(NIFTY 50, mc_ohlc, 9)` |
| Yahoo | `index_provider_map`, provider `yahoo` | explicit Yahoo index symbol |
| Trendlyne | `index_provider_map`, provider `trendlyne` | provider `tlid` discovered by `sync_tl_index_map.py` |
| NiftyTrader | `index_provider_map`, providers `nt_index`/`nt_index_bse` | API symbol, never an MC ID |

Use the ID required by each endpoint; the same index can need both values:

```ts
for (const index of INDEX_MAPPING) {
  await fetchIndexFullDetails(index.id);           // ind_id=9
  await fetchIndexFundamentals(index.id);          // indId=9
  await fetchIndexConstituents(index.id);           // ind_id=9
  await fetchIndexTechnicals('D', index.symbol);   // path in%3BNSX
}
```

`sync_mc_index_map.py`, `sync_tl_index_map.py`, and `sync_nt_fno_symbols.py` discover and upsert
provider mappings. Run those before an all-index ingestion and log indices missing the requested
provider key. Index constituents returned by a provider must be mapped back to canonical NSE
symbols by an explicit provider ID, exact symbol, or ISIN; never store an index bridge symbol as an
equity ticker.

### 1.1.3 Sectors and industries

There are two different operations, and neither is an equity-ID substitution:

1. **Fetch a provider's aggregate/constituent endpoint.** Use that provider's taxonomy value. For
   example, MoneyControl accepts `section=sector|industry`, provider sector names in
   `categoryValue`, or a provider slug in `sector/get-all-stocks/financials`. The 12 currently
   live-verified MoneyControl slugs are `finance`, `banks`, `fmcg`, `oil-gas`, `power`,
   `metals-mining`, `healthcare`, `capital-goods`, `telecom`, `chemicals`, `textiles`, and
   `infrastructure`. Do not derive unverified slugs from display labels.
2. **Run stock endpoints for every constituent of an internal sector/industry.** Query active
   canonical symbols from `nse_stocks`, then join those symbols to the deduplicated stock mapping
   and apply the same `required_ids` renderer used for the whole universe.

```sql
SELECT symbol FROM nse_stocks
WHERE status = 'ACTIVE' AND sector = ?
ORDER BY symbol;

SELECT symbol FROM nse_stocks
WHERE status = 'ACTIVE' AND industry = ?
ORDER BY symbol;
```

Enumerate taxonomy values with separate `SELECT DISTINCT sector FROM nse_stocks WHERE status =
'ACTIVE'` and `SELECT DISTINCT industry FROM nse_stocks WHERE status = 'ACTIVE'` queries, excluding
null/blank/`Unknown` values. Sector and industry metadata do not live in `scripts/stocklist.json`;
they are enriched in `nse_stocks` from Yahoo/MoneyControl and retain the provider taxonomy. Maintain
an explicit alias/crosswalk table when comparing taxonomies. A label such as `Software & IT
Services` must not be silently converted to a guessed URL slug.

For provider aggregate endpoints, persist under `(source, taxonomy_type, provider_taxonomy_id,
as_of_date)`. For constituent-level responses, persist the canonical `symbol` as well as the source
taxonomy label and provider-returned constituent ID. This preserves the ability to audit both the
provider's grouping and the platform's internal sector/industry grouping.

### 1.2 Provider-issued keys

Any stored provider-issued screener, scan, deal, or rating ID must include the provider in its
key. Use `(source, provider_id)`, never a bare integer. MoneyControl, Trendlyne, ETNow, and ET
Marketstats issue overlapping IDs.

### 1.3 Integration classes

| Class | Meaning | Required controls |
|---|---|---|
| Ingestion | Writes provider data to a database table | Parser test, live test, freshness check, idempotent upsert |
| Read-through | Calls a provider for an API/UI response | Timeout, cache, explicit unavailable state |
| Discovery | Resolves IDs or inventories screeners | Cache, exact-match validation, manual review fallback |
| Supplemental | Adds fields to an existing canonical dataset | Provenance column and null-safe merge |
| Internal service | Local API/model used by ingestion | Health check and versioned contract |

### 1.4 Common request rules

- Set a realistic `User-Agent`, an explicit timeout, and bounded retries with jitter.
- Set the real provider `Referer`/`Origin` where required.
- Cache immutable ID mappings and short-lived read-through responses.
- Preserve raw provider payloads for debugging when licensing/storage policy permits.
- Store `source`, provider timestamp, fetch timestamp, and canonical NSE symbol.
- Treat HTTP 200 with empty, stale, HTML, or schema-changed content as failure.
- Do not silently substitute fabricated values. Return unavailable or a timestamped stale cache.
- Filter non-finite numeric values before writing.
- Use the exchange trading calendar, not weekday arithmetic or `date.today()` write anchors.

## 2. Core Market and Exchange Sources

### 2.1 NSE India and NSE Archives

**Status:** Active primary exchange source. Some endpoints require cookie/session priming.

| Data | Endpoint family | Identifier | Principal outputs | Implementation |
|---|---|---|---|---|
| Equity bhavcopy/OHLCV | `archives.nseindia.com/products/content/sec_bhavdata_full_DDMMYYYY.csv` | NSE symbol | `stock_ohlcv`, `nse_universe_history` | `nse_bhavcopy_fetcher.py`, `deliveryFetcher.ts` |
| Delivery volume | `nsearchives.nseindia.com/archives/equities/mto/MTO_DDMMYYYY.DAT` | NSE symbol | `stock_delivery_volume` | `delivery_volume_fetcher.py`, `delivery_trend_fetcher.py` |
| Block/bulk deals | `nseindia.com/api/block-deal` | NSE symbol | `bulk_block_deals` | `block_deal_fetcher.py` |
| Insider/PIT filings | `nseindia.com/api/corporates-pit` | NSE symbol | `insider_transactions` | `insider_transactions_fetcher.py` |
| FII/DII cash flow | `nseindia.com/api/fiidiiTradeReact` | Market/date | `fii_dii_flow` | `fii_dii_fetcher.py`, `routers/sentiment.router.ts` |
| Index membership | NSE index CSV/API families | NSE symbol/index | index flags and membership | `index_membership_fetcher.py` |
| IPO calendar | NSE IPO API | Issue/date | `nse_ipo_calendar` | `nse_ipo_calendar_fetcher.py` |
| Credit ratings | `nseindia.com/api/corporate-credit-rating` | NSE symbol | `stock_credit_rating` | `credit_rating_fetcher.py` |
| ASM/GSM surveillance | NSE surveillance APIs/files | NSE symbol | `asm_gsm_events` | `asm_gsm_fetcher.py` |
| Derivatives archives | `nsearchives.nseindia.com/content/fo/` | Symbol/expiry | rollover/OI datasets | `fno_rollover_fetcher.py` |
| Market status/indices | `nseindia.com/api/marketStatus`, `api/allIndices` | Index | read-through market state | `marketStatusService.ts`, `market_regime_fetcher.py` |

Required headers normally include `Referer: https://www.nseindia.com/`. Long-running sessions
must refresh cookies because NSE can expire them mid-run.

### 2.2 BSE India

**Status:** Active for structured corporate announcements.

- Endpoint: `api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w`.
- Query behavior: request one date at a time; paginate results.
- Identifier: BSE scrip code/fincode from the stock mapping, then map back to NSE symbol.
- Output: `news_sentiment_items` and the legacy news table.
- Implementation: `newsSentimentService.ts`, `companyProfileSyncService.ts` where applicable.
- Required header: `Referer: https://www.bseindia.com/`.

Unmapped BSE-only companies are intentionally skipped by the NSE-centric platform.

## 3. Price, Fundamental, and Screener Providers

### 3.1 MoneyControl

**Status:** Active and broad, but undocumented APIs are schema/blocking risks. Several paths use
browser-like headers or `curl_cffi` impersonation.

**Endpoint families**

| Family | Examples | Data |
|---|---|---|
| Price feed | `priceapi.moneycontrol.com/pricefeed/nse/equitycash/{mcsymbol}` | Quote, valuation, delivery |
| Historical bars | `priceapi.moneycontrol.com/techCharts/indianMarket/stock/history` | Daily/intraday OHLCV |
| Technical indicators | `priceapi.moneycontrol.com/pricefeed/techindicator/{period}/{mcsymbol}` | MA, RSI, pivots, sentiment |
| Stock API | `api.moneycontrol.com/mcapi/v1/stock/*` | Price-volume, financials, SWOT, corporate actions |
| Index API | `api.moneycontrol.com/mcapi/v1/indices/*` | Index list, detail, breadth, valuation |
| Market/F&O JSON | `appfeeds.moneycontrol.com/jsonapi/market/*`, `/fno/*` | Charts, maps, futures/options |
| OI | `priceapi.moneycontrol.com/technicalCompanyData/oiData/*` | Index option OI/PCR |
| Screeners | `api.moneycontrol.com/mcapi/v1/proscanner/scanner-detail`, `technical-trends/*` | Screener membership |
| Earnings/calendar | `mcapi/v1/earnings/*`, `mcapi/v1/ecalendar/*` | Estimates, actuals, events |
| Premarket/research | `mcapi/v1/premarket/*` | Global cues, broker research, events |
| Deals | `mcapi/v1/deals/insight` | Institutional/top-investor activity |
| Stock vitals | `api.moneycontrol.com/swiftapi/v1/stockvitals/historical` | Historical stock metrics |

**Identifiers:** `mcsymbol` for most equities, `stockid` for selected endpoints, and explicit
index IDs. Resolve through `stockMapping.ts`; use the MoneyControl autocomplete endpoint only as
a cached fallback.

**Principal outputs:** `stock_ohlcv`, `mc_pricefeed_daily`, `index_ohlcv`, `index_option_oi`,
`index_valuation`, `market_breadth`, `mc_earnings`, `stock_earnings_beats`, `eco_calendar`,
`mc_corporate_calendar`, `mc_broker_reco`, `stock_corporate_action_history`,
`mc_chart_patterns`, `mc_stockvitals_history`, `mc_global_snapshot`, `institutional_deal_signals`,
and provider-tagged screener tables.

**Implementation inventory:**

```text
moneycontrol_fetcher.py             mc_pricefeed_fetcher.py
mc_ohlcv_backfill.py                intraday_fetcher.py
mc_index_ohlc_fetcher.py            mc_index_oi_fetcher.py
mc_advance_decline_fetcher.py       mc_global_macro_fetcher.py
mc_earnings_fetcher.py              earnings_surprise_fetcher.py
eps_surprise_fetcher.py             mc_eco_calendar_fetcher.py
mc_corporate_calendar_fetcher.py    mc_corporate_actions_fetcher.py
mc_broker_reco_fetcher.py           mc_chart_patterns_fetcher.py
mc_stockvitals_history_fetcher.py   mc_techscanner_fetcher.py
institutional_deals_fetcher.py      nifty_pe_fetcher.py
preopen_fetcher.py                  backfill_sector_mc.py
mcApiService.ts                     moneycontrolService.ts
moneycontrolScreener.ts             moneycontrol.ts
marketData.ts                       marketIntelService.ts
indexApiService.ts                  insightService.ts
stockMapping.ts
```

Do not use the old `rss.moneycontrol.com` feeds: repository live checks found them frozen in
2024 despite HTTP 200 responses.

### 3.2 Yahoo Finance

**Status:** Active primary/supplemental source for broad quotes and fundamentals; fallback for
intraday bars.

- Cookie bootstrap: `https://fc.yahoo.com`.
- Crumb: `query2.finance.yahoo.com/v1/test/getcrumb`.
- Batch quotes: `query2.finance.yahoo.com/v7/finance/quote`.
- Deep fundamentals: `query2.finance.yahoo.com/v10/finance/quoteSummary/{symbol}.NS`.
- Charts: `query1|2.finance.yahoo.com/v8/finance/chart/{symbol}.NS`.
- Identifier: derive `{NSE_SYMBOL}.NS`; index/foreign instruments require explicit Yahoo symbols.
- Outputs: `stock_fundamentals`, fundamentals history, `stock_ohlcv`, `intraday_ohlcv`, sector and
  industry metadata; live quotes may be read-through only.
- Implementations: `fundamentalsSyncService.ts`, `liveStockData.ts`, `intraday_fetcher.py`,
  `backfill_ohlcv.py`, `backfill_sector_industry.py`.

Cache the cookie/crumb pair, invalidate on authorization failure, limit quote-summary concurrency,
and retain MoneyControl as an independent fallback rather than mixing fields without provenance.

### 3.3 Trendlyne and SmartOptions

**Status:** Active. Public endpoints and authenticated web sessions coexist.

| Data | Endpoint family | Identifier | Output/implementation |
|---|---|---|---|
| Screener membership | `kayal.trendlyne.com/.../all-in-one-screener-data-get` | `screenpk` | screener tables; `trendlyneScreener.ts`, `trendlyne_screener_discovery.py` |
| Fundamentals history | `trendlyne.com/mapp/v1/stock/chart-data/{tlid}/{param}` | `tlid` | `tl_financial_quality`; `trendlyne_fundamentals_fetcher.py`, `trendlyneService.ts` |
| Overview/DVM | `equity/overview-second-part/{tlid}` | `tlid` | `trendlyne_dvm_scores`; `trendlyne_overview_fetcher.py` |
| Advanced technicals | `equity/api/stock/adv-technical-analysis/{tlid}/24` | `tlid` | `trendlyne_adv_tech_signals`; `trendlyne_adv_tech_fetcher.py` |
| Price analysis | `share-price/price-performance-analysis/{tlid}` | `tlid` | `trendlyne_price_analysis`; corresponding fetcher |
| F&O market activity | `smartoptions.trendlyne.com/phoenix/api/fno/market/filter/` | Market/filter | `trendlyne_fno_activity` |
| Option chain | `smartoptions.trendlyne.com/phoenix/api/fno/option/chain/` | NSE symbol/expiry | `so_option_chain` |
| Checklist | `kayal.trendlyne.com/clientapi/kayal/content/checklist-bypk/{tlid}` | `tlid` | read-through/checklist tables |
| Market insight/MF | `equity/api/market-insight`, `mutual-fund/getMFhome` | Market | raw extra-endpoint archive |

Authentication variables for session-backed endpoints:

```text
TRENDLYNE_USERNAME
TRENDLYNE_PASSWORD
TRENDLYNE_LOGIN_URL                 optional
TRENDLYNE_LOGIN_USERNAME_FIELD      optional
TRENDLYNE_LOGIN_PASSWORD_FIELD      optional
TRENDLYNE_LOGIN_CSRF_FIELD          optional
```

Rate-limit with delay and jitter. Parse symbols from named response fields, never positional
column fallbacks; this exact mistake previously stored profile URLs as stock symbols.

### 3.4 NiftyTrader

**Status:** Active primary F&O fallback where NSE option-chain access is blocked.

| Endpoint | Data | Output |
|---|---|---|
| `webapi.niftytrader.in/webapi/option/option-chain-data` | Per-stock option chain | `stock_option_features` |
| `/webapi/Option/oi-time-range` | OI snapshot | `nt_stock_oi_snapshot` |
| `/webapi/Option/change-oi-time-range` | OI change | `nt_oi_change` |
| `/webapi/option/oi-pcr-data` | PCR time series | `nt_index_pcr_ts` |
| `/webapi/Option/dashboard-data` | F&O dashboard | `nt_fno_dashboard` |
| `/webapi/symbol/stock-index-data` | F&O symbol inventory | mapping cache |
| `/webapi/Symbol/symbol-expiry-all` | Expiries | read-through |
| `/webapi/usstock/global-market` | Global market snapshot | read-through |
| `/webapi/symbol/top-gainers-data` | Movers | read-through |

Identifiers are NSE symbols or explicit index names. Authenticated access uses
`onboarding.niftytrader.in/webapi/Account/login` with `NIFTYTRADER_EMAIL` and
`NIFTYTRADER_PASSWORD`; token refresh is implemented in `niftytraderAuthService.ts`.

Implementations include `stock_option_chain_fetcher.py`, `nt_oi_snapshot_fetcher.py`,
`nt_change_oi_fetcher.py`, `nt_pcr_ts_fetcher.py`, `nt_dashboard_fetcher.py`,
`nt_vix_fetcher.py`, `pcr_fetcher.py`, `niftytraderService.ts`, `optionChainService.ts`,
`fnoService.ts`, `globalMarketService.ts`, and `topMoversService.ts`.

### 3.5 Economic Times, ET Markets, ETNow, and Indiatimes

**Status:** Active across several independent endpoint families.

| Family | Endpoint | ID | Data/output |
|---|---|---|---|
| ETNow screeners | `screener.indiatimes.com/screener/v2/screenerByScreenerIdForWeb` | `screenerId` plus query condition | `etnow_screeners`, membership, `screener_master` |
| ET Marketstats | `etapi.indiatimes.com/et-screener/v2/technical-data` | Full operand tuple | provider-tagged screeners |
| ET intraday stats | `etapi.indiatimes.com/et-screener/v2/intraday-stats` | API type/duration | provider-tagged screeners |
| ET Stats mobile | `etmarketsapis.indiatimes.com/ET_Stats/mobile` | `companyid` | ratios, balance sheet, cash flow |
| Shareholding | `marketservices.indiatimes.com/marketservices/shareholding` | `companyid` | external ownership features |
| MF stock holdings | `mfapps.indiatimes.com/Ulip/mfsInvestingInStock.htm` | `companyid` | `mf_stock_holdings` |
| Company/price JSON | `json.bselivefeeds.indiatimes.com/ET_Community/*` | `companyid` | archived external fields |

Implementations: `etnow.ts`, `etMarketstats.ts`, `et_stats_client.py`,
`financial_ratios_fetcher.py`, `working_capital_fetcher.py`, `mf_stock_holdings_fetcher.py`,
`extra_endpoints_fetcher.py`, and `endpoint_registry.py`.

The ET Marketstats identity is the full endpoint/filter tuple, not `viewId`; multiple filters can
reuse a view ID. Persist a hash of the tuple and include source in the primary key. The repository
contains 91 complete captured POST requests in `et-marketstats-post-requests.json` plus four
code-defined views (`23217`, `23234`, `23235`, `23236`) in `etMarketstats.ts`, for 95 definitions.

### 3.6 MarketsMojo and Trading80

**Status:** Active. MarketsMojo was onboarded as five history-producing fetchers. Trading80 is
used through the curated generic endpoint registry.

MarketsMojo endpoint families:

```text
frapi.marketsmojo.com/apiv1/financials/get-financials
frapi.marketsmojo.com/stocks/finTrendGraph
frapi.marketsmojo.com/Stocks_Shareholding/get_results
frapi.marketsmojo.com/apiv1/markets/indices
marketsmojo.com/technical_card/getCardInfo
frapi.marketsmojo.com/stocks_quality/vcardinfo
frapi.marketsmojo.com/stocks_stocksid/header_info
frapi.marketsmojo.com/Stocks_Thingsknow/thingsknow
frapi.marketsmojo.com/stocks_Stocksid/returnContri_info
```

- Identifier: shared MoneyControl `stockid`; do not create a second guessed ID.
- Required header: `Referer: https://www.marketsmojo.com/`.
- Outputs: `marketsmojo_technical_history`, `marketsmojo_financials_history`,
  `marketsmojo_fintrend_history`, `marketsmojo_shareholding_history`,
  `marketsmojo_index_history`, and raw extra-endpoint responses.
- Fetchers: `marketsmojo_{technical,financials,fintrend,shareholding,index}_fetcher.py`.

Trading80 endpoint families:

```text
frapi.trading80.com/stocks_stocksid/header_info
trading80.com/technical_card/getCardInfo
frapi.trading80.com/callsapi/getCallAlerts
```

They also use `stockid` and write through `extra_endpoints_fetcher.py` into the raw endpoint
archive before optional feature parsing.

### 3.7 TickerTape

**Status:** Active for deals, MMI, categorical scorecards, financials, and estimates.

- Deals: `analyze.api.tickertape.in/stocks/deals` -> `bulk_block_deals`.
- Scorecard: `analyze.api.tickertape.in/stocks/scorecard/{tickertape_sid}` -> scorecard metrics.
- Market Mood Index: `api.tickertape.in/mmi/now` -> `macro_asset_prices`.
- Financials: `api.tickertape.in/stocks/financials/income/{sid}/annual/normal`.
- Estimate history: `api.tickertape.in/stocks/estimates/history/{sid}`.
- Identifier: explicit `tickertape_sid` except market-wide endpoints.
- Implementations: `tickertape_client.py`, `tickertape_deals_fetcher.py`,
  `tickertape_scorecard_fetcher.py`, `mmi_fetcher.py`, `endpoint_registry.py`.

Unauthenticated scorecards may expose categorical labels while withholding numeric premium data.
Do not convert missing premium values into zero.

### 3.8 Complete Screener Fetch Matrix

This is the canonical inventory of production screener-fetching routes. It includes membership,
read-through, and screener-list endpoints; downstream database readers are not repeated here.

| Provider/purpose | Method | Endpoint | Request identity or payload | Implementation/source of truth |
|---|---|---|---|---|
| MoneyControl Proscanner | GET | `api.moneycontrol.com/mcapi/v1/proscanner/scanner-detail` | Query: `catId`, `scanId` | `moneycontrolScreener.ts`, `moneycontrol.ts` |
| MoneyControl Techscanner | GET | `api.moneycontrol.com/mcapi/v1/techscanner/scanner-detail` | Query: `catId`, `scanId` | `moneycontrolScreener.ts`, `mc_techscanner_fetcher.py` |
| MoneyControl technical trends | GET | `api.moneycontrol.com/mcapi/v1/technical-trends/{uptrend|downtrend}/{bucket}` | Query: `ex`, `index`, `page`, `order`, `deviceType`, `sort`, `appVersion` | `marketData.ts`, `mc_techscanner_fetcher.py` |
| Trendlyne Kayal membership | GET | `kayal.trendlyne.com/broker-webview/kayal/all-in-one-screener-data-get/` | Query: `screenpk`, `perPageCount`, `pageNumber`, `groupType`, `groupName` | `trendlyneScreener.ts`, `trendlyne_screener_discovery.py` |
| Trendlyne direct membership | GET | `trendlyne.com/fundamentals/tl-all-in-one-screener-data-get/` | Query: `screenpk`, `perPageCount`, `groupType`, `groupName` | `marketData.ts` |
| Trendlyne lightweight screener | GET | `trendlyne.com/fundamentals/json-screener/{screenerId}/5/0/index/NIFTY500/nifty-500/` | Path ID and fixed universe | `marketData.ts` |
| Trendlyne/SmartOptions F&O activity | GET | `smartoptions.trendlyne.com/phoenix/api/fno/market/filter/` | Provider market/filter query | `trendlyne_fno_activity_fetcher.py` |
| ETNow saved screeners | POST | `screener.indiatimes.com/screener/v2/screenerByScreenerIdForWeb` | JSON: `viewId`, `sort`, `pagesize`, `pageno`, `deviceId`, `filterType`, `filterValue`, `screenerId`, `queryCondition` | `etnow.ts`, `et_screeners.json` |
| ET Marketstats technical | POST | `etapi.indiatimes.com/et-screener/v2/technical-data` | JSON: `viewId`, `firstOperand`, `operationType`, `secondOperand`, `filterValue`, `filterType`, `sort`, `pagesize`, `pageno` | `etMarketstats.ts`, `et-marketstats-post-requests.json` |
| ET Marketstats intraday | POST | `etapi.indiatimes.com/et-screener/v2/intraday-stats` | JSON: `viewId`, `apiType`, optional `duration`/`timespan`, plus common filter/paging fields | `etMarketstats.ts`, `et-marketstats-post-requests.json` |
| ET trending screener list | GET | `etmarketsapis.indiatimes.com/ET_TechnicalScreeners/topTrendingScreeners` | Query: `exchangeId`, `pageNumber`, `pageSize`, `innerPageSize` | `marketData.ts` |
| NiftyTrader live market screener | POST | `webapi.niftytrader.in/webapi/Screener/live-market-filter-data` | Full live boolean/string filter template merged with selected filters | `marketIntelService.ts` |
| NiftyTrader advanced EOD screener | POST | `webapi.niftytrader.in/webapi/Screener/advance-eod-screener-filter` | Full EOD technical/candlestick filter template merged with selected filters | `marketIntelService.ts` |

Inventory measured from repository sources on 2026-08-12:

- MoneyControl: 143 configured `(catId, scanId, type)` rows in `MC_SCREENERS`.
- Trendlyne discovery: 1,052 unique `KNOWN_PKS`; `--full` also follows related-screen references
  and probes nearby numeric ranges, so this is a seed count rather than a permanent ceiling.
- ETNow: 438 captured request bodies in `et_screeners.json`; the source index reported one failed
  capture, which is retained as an explicit coverage caveat rather than called complete.
- ET Marketstats: 91 captured request bodies plus four code-defined extras, 95 total definitions.

The `sas.indiatimes.com/ET_Community/getTechScreenerJSON.cms` URLs in exploration code are
discovery probes, not production ingestion. They are intentionally excluded from this matrix.

### 3.9 External POST Request Matrix

The table below covers every direct external POST whose response supplies provider data. It does
not include inbound application routes, frontend calls to this application's own backend,
localhost/AlphaQuant Python bridges, notifications, Telegram, or AI-generation requests.

| Provider | Endpoint | Request body/query | Purpose |
|---|---|---|---|
| ETNow | `screener.indiatimes.com/screener/v2/screenerByScreenerIdForWeb` | Saved-screener body listed in Section 3.8 | Screener membership |
| ET Marketstats | `etapi.indiatimes.com/et-screener/v2/technical-data` | Operand tuple plus filter and paging fields | Technical/fundamental screener rows |
| ET Marketstats | `etapi.indiatimes.com/et-screener/v2/intraday-stats` | `apiType`, optional duration/timespan, filter and paging fields | Intraday screener rows |
| NiftyTrader | `webapi.niftytrader.in/webapi/Analysis/stock-industry-data` | JSON: `{ "symbol": "<lowercase NSE symbol>" }` | Industry-relative stock data |
| NiftyTrader | `webapi.niftytrader.in/webapi/Analysis/stock-analysis-data` | Same symbol body | Stock analysis data |
| NiftyTrader | `webapi.niftytrader.in/webapi/Analysis/stock-financial-data` | Same symbol body | Stock financial data |
| NiftyTrader | `webapi.niftytrader.in/webapi/Screener/live-market-filter-data` | Complete live filter template from `marketIntelService.ts` | Live multi-filter screener |
| NiftyTrader | `webapi.niftytrader.in/webapi/Screener/advance-eod-screener-filter` | Complete EOD filter template from `marketIntelService.ts` | EOD technical/candlestick screener |
| MarketsMojo | `frapi.marketsmojo.com/apiv1/financials/get-financials` | JSON: `sid`, `exchange`, `period='q'`, `card=1`, `page`, `type=0`, `qtype='qoq'` | Paginated quarterly statements |
| MarketsMojo | `frapi.marketsmojo.com/stocks/finTrendGraph?cid=34` | JSON: `stock_id`, `exchange`, `cid=34` | Historical financial-trend score |

Authentication POSTs are integration prerequisites, not data-fetch rows:

- NiftyTrader: `POST onboarding.niftytrader.in/webapi/Account/login` with `user_email`,
  `user_password`, `login_type=1`, `social_flag=0`, and `platform_type=1`; persist only the JWT,
  never credentials. See `niftytraderAuthService.ts`.
- Trendlyne: `POST trendlyne.com/accounts/login/` as URL-encoded form data after a GET bootstrap
  obtains CSRF cookie/token; fields default to `csrfmiddlewaretoken`, `login`, `password`, `next`.
  See `trendlyneAuthService.ts`; all field names and the URL are environment-overridable.

Anthropic/Ollama calls, Telegram and internal notification POSTs, the local Python API, and
frontend-to-server POSTs are documented in the AI/operations sections and are deliberately not
counted as provider data acquisition.

## 4. Alternative and Supplemental Sources

### 4.1 InvestSights

**Status:** Active public API in this repository.

| Endpoint family | Data | Output |
|---|---|---|
| `/api/v2/concall/recent` | Concall tone and takeaways | `concall_takeaways` |
| `/api/v2/investors/` and `/{slug}/activity` | Superstar investors/activity | investor activity tables |
| `/api/v2/market/sector-rrg` | Sector relative rotation | `sector_rrg_history` |
| `/api/v2/market/sector-correlation` | Sector correlation | `sector_correlation_summary` |
| `/api/v2/fundamentals/market/fiidii` | Long FII/DII history | `fii_dii_flow`/macro history |
| `/api/v2/market/corporate-actions` | Corporate actions | `nse_filed_corporate_actions` |
| `/api/v2/stocks/{symbol}/score` | Stock score | external feature archive |
| `/api/v2/market/pe-band/{symbol}` | PE band | external feature archive |
| `/api/v2/fundamentals/{symbol}/*` | DCF, growth, pros/cons | external feature archive |

It accepts the NSE symbol directly. Implementations are the four
`investsights_*_fetcher.py` files plus `fii_dii_history_fetcher.py` and
`endpoint_registry.py`.

### 4.2 TapeTide

**Status:** Active public score/forecast endpoints; deeper AI-chat endpoints require auth and are
not integrated.

- `api.tapetide.com/api/v1/companies/{symbol}/score`.
- `/analyst-ratings` and `/forecasts`.
- Identifier: NSE symbol.
- Output: raw `extra_endpoint_responses`, then selected `ext_*` features.
- Implementations: `endpoint_registry.py`, `extra_endpoints_fetcher.py`.

### 4.3 StockEdge

**Status:** One market-wide endpoint is enabled. Per-stock endpoints are deliberately excluded
until a real StockEdge-ID resolver exists.

- Endpoint: `api.stockedge.com/Api/WidgetsApi/GetHighDeliveryQuantityStocks?lang=en`.
- Data: high-delivery stocks.
- Identifier: none for this market-wide call.
- Output: raw extra-endpoint archive.

### 4.4 TradeBrains

**Status:** Active supplemental/read-through source.

- FII history: `portal.tradebrains.in/api/prices/investments/fii-investments/`.
- Superstar portfolios: TradeBrains portal APIs used by `routers/misc.router.ts`.
- Stock page JSON: `_next/data/.../stocks/{symbol}.json` in `tradebrainsService.ts`.
- RSS: `https://tradebrains.in/feed/` in the news service.
- Implementations: `fii_dii_backfill.py`, `tradebrainsService.ts`, `routers/misc.router.ts`,
  `newsSentimentService.ts`.

The Next.js build hash in `_next/data` is inherently unstable; discover or replace it rather than
hardcoding it in a new integration.

### 4.5 Finology

**Status:** Read-through fallback; repository endpoint probes have also observed 403 responses.

- Provider: `ticker.finology.in`.
- Data: stock fundamentals/ratios where reachable.
- Identifier: NSE symbol/provider slug.
- Implementation: `finologyService.ts`.
- Recommendation: treat as optional and verify live before adopting.

### 4.6 NDTV Profit

**Status:** Dedicated F&O basis fetcher exists; availability has varied by endpoint.

- Endpoint: `ndtvprofit.com/api/v2/stock-summary?symbol={ticker}`.
- Identifier: NSE symbol.
- Data/output: futures basis and related summary -> `ndtv_fno_basis`.
- Implementation: `ndtv_fno_basis_fetcher.py`.
- Keep its live test as the go/no-go check for a new project.

### 4.7 AMFI

**Status:** Broken upstream as of this verification date.

- Endpoint: `portal.amfiindia.com/DownloadSchemeData_Po.aspx`.
- Intended data/output: mutual-fund sector allocation -> `mf_sector_allocation`.
- Implementation: `mf_sector_flow_fetcher.py`.
- Current behavior: the endpoint returns an HTML frameset instead of the expected bulk data.
- Do not port as an active source until a replacement endpoint is identified.

## 5. News and Event Sources

### 5.1 Active RSS feeds

`newsSentimentService.ts` polls these feeds and writes normalized articles to
`news_sentiment_items` plus a legacy compatibility table.

| Source | URL | Region |
|---|---|---|
| LiveMint Markets | `livemint.com/rss/markets` | India |
| LiveMint Companies | `livemint.com/rss/companies` | India |
| Hindu BusinessLine | `thehindubusinessline.com/markets/?service=rss` | India |
| Zee Business Markets | `zeebiz.com/market-news/rss.xml` | India |
| CNBC TV18 Markets | `cnbctv18.com/commonfeeds/v1/cne/rss/market.xml` | India |
| CNBC TV18 Business | `cnbctv18.com/commonfeeds/v1/cne/rss/business.xml` | India |
| CNBC TV18 World | `cnbctv18.com/commonfeeds/v1/cne/rss/world.xml` | Global |
| TradeBrains | `tradebrains.in/feed/` | India |
| Google News India Markets | `news.google.com/rss/search?...Indian stock market...` | India |
| Google News NIFTY | `news.google.com/rss/search?...NIFTY SENSEX...` | India |
| Economic Times Top Stories | `economictimes.indiatimes.com/rssfeedstopstories.cms` | India |
| Economic Times Stocks | `economictimes.indiatimes.com/markets/stocks/rssfeeds/2146843.cms` | India |
| Financial Times | `ft.com/rss/home/uk` | Global |
| MarketWatch | `feeds.content.dowjones.io/public/rss/mw_topstories` | Global |
| Investing.com Stock Ideas | `in.investing.com/rss/news_1065.rss` | India |
| Investing.com Economy | `in.investing.com/rss/news_14.rss` | Global |

Removed/dead sources are also important migration knowledge: MoneyControl RSS feeds were stale,
ET's ViewAndReco feed was NewsML rather than RSS, and several Reuters/Yahoo/NDTV/Business Standard
feeds failed or returned HTML. Do not restore them based only on HTTP status.

### 5.2 Google News per-company search

The news service rotates through companies and uses Google News RSS queries, then force-tags the
query symbol while retaining co-mentioned symbols. No API key is needed. Respect query pacing and
deduplicate by stable article hash/URL.

### 5.3 BSE corporate announcements

Covered in Section 2.2. This is the most structured filings source in the news pipeline and should
remain independent from publisher RSS sentiment.

### 5.4 GNews

**Status:** Implemented but disabled by default because the free tier was observed to be delayed.

- API: `gnews.io/api/v4/top-headlines` and `/search`.
- Credential: `GNEWS_API_KEY`.
- Feature gate: database setting `gnews_enabled=true`.
- Data: Indian/global business headlines and rotating per-stock searches.
- Output: `news_sentiment_items`.

### 5.5 GDELT

**Status:** Active supplemental global-news/event source.

- Endpoint: `api.gdeltproject.org/api/v2/doc/doc`.
- Query: provider search syntax with JSON response.
- Implementation: `gdeltService.ts`.
- Store event/article time, query, source domain, tone, and matched NSE symbols; do not treat
  market-level tone as a per-stock signal without entity tagging.

### 5.6 MoneyControl stock news

`mcApiService.ts`/`newsSentimentService.ts` fetch per-stock MoneyControl news using the resolved
`mcsymbol`. This is separate from the dead MoneyControl RSS family and remains a live API path.

### 5.7 Sensibull events

**Status:** Active read-through integration.

- Endpoint: `api.sensibull.com/v1/current_events`.
- Data: current market/economic events.
- Identifier: market-wide; no stock mapping required.
- Implementation: `routers/misc.router.ts`.
- Persistence: none in the owning route; cache or persist explicitly in a new project if history
  is required.

## 6. Live Quotes and Fallback Hierarchy

`liveStockData.ts` implements the broad quote path:

1. Yahoo Finance batch quote with cookie/crumb.
2. Yahoo chart endpoint for individual fallback.
3. Finnhub where `FINNHUB_API_KEY` is configured.
4. Existing cached/database values according to caller policy.

For a new project, return quote provenance and timestamp with every value. Do not merge a Yahoo
price and a MoneyControl timestamp into an unlabeled object.

## 7. AI and Enrichment Services

These are external integrations but are not authoritative market-data sources.

| Service | Purpose | Configuration | Implementation |
|---|---|---|---|
| Anthropic Messages API | High-impact news/signal narrative | `ANTHROPIC_API_KEY`, optional `ANTHROPIC_MODEL` | `newsSentimentService.ts`, `technicalSignalsService.ts` |
| Google Gemini | Chatbot/AI fallback | `GEMINI_API_KEY` | `geminiService.ts`, chatbot modules |
| AWS Bedrock | Configurable AI provider | AWS credentials/region | `bedrockService.ts` |
| Ollama | Local LLM inference | `OLLAMA_URL`, `OLLAMA_MODEL` | `ollamaManager.ts`, `agents/ollama_client.py`, chatbot |
| FinBERT | Local sentiment model | `USE_FINBERT` and Python model dependencies | `finbert_scorer.py`, `nlp_engine.py` |
| AlphaQuant | Local optimization service | `ALPHAQUANT_URL` | `alphaQuantClient.ts`, optimizer agent |

Store AI output as derived narrative/metadata with model and prompt version. Never let an LLM
become the untraceable authority for a market fact.

## 8. Operational Integrations

These are required to reproduce the operating environment, not the market dataset:

| Service | Purpose | Configuration |
|---|---|---|
| PostgreSQL/TimescaleDB | **The only database** — production and dev alike | `POSTGRES_URL` or `POSTGRES_*` |
| ~~SQLite~~ | ~~Development fallback~~ | **Removed 2026-08-15.** No `.ts` path remains, and `USE_POSTGRES`/`DATABASE_URL` are read by no real process |
| Redis/BullMQ | queues, cache, schedules | `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` |
| Firebase Admin | user authentication | Firebase application credentials or `FIREBASE_SERVICE_ACCOUNT_KEY` |
| Telegram Bot API | alerts | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |
| Sentry | error/trace telemetry | `SENTRY_DSN` |
| Internal HTTP callbacks | Python-to-Node notifications | `INTERNAL_API_SECRET` |

## 9. Generic Endpoint Registry

`endpoint_registry.py` and `extra_endpoints_fetcher.py` provide a registry-driven ingestion path.
Enabled definitions currently cover:

```text
Indiatimes: shareholding, MF holdings, company data, price/chart JSON
Trading80: header/quality/valuation fields, technical cards, call alerts
MarketsMojo: quality, things-to-know, contribution, header, market action, picks, results
StockEdge: market-wide high-delivery list
InvestSights: score, PE band, DCF, growth, pros/cons, investors, concalls, sector RRG/correlation
TapeTide: score, analyst ratings, forecasts
TickerTape: income financials, estimate history, deals, MMI
Trendlyne: market insight and mutual-fund home data
MoneyControl: top-investor deal insight
```

Every registry row declares provider, category, scope, required identifier fields, parser status,
and enabled status. The fetcher archives raw responses in `extra_endpoint_responses`; parsers then
promote selected fields into typed features. Preserve this two-stage design in a new project.

### 9.1 Captured URL Corpus and Screener Instances

The provider-family tables above are an implementation map, not a replacement for the repository's
large captured URL corpus. A faithful migration must carry both layers:

| Artifact | Scope | Measured size | How to use it |
|---|---|---:|---|
| `urls.txt` | Original concrete GET URL capture | 1,983 unique rows | Audit provenance only; includes 15 malformed `https:////` URLs |
| `urls.normalized.txt` | Canonicalized concrete GET URLs | 1,983 rows, 1,980 unique | Machine-readable concrete URL inventory for a new project |
| `docs/url_explorer/field_report.md` | Structural templates and live response fields | 250 raw-corpus templates; 212 returned data, 38 failed on 2026-08-03 | Field-by-field migration reference; preserve historical status/date |
| `docs/url_explorer/DATA_CATEGORIZATION_AND_USAGE.md` | Template status and integration decisions | All 250 raw-corpus templates | Explains wired, raw-only, duplicate, blocked, dead, and candidate endpoints |
| `detailed_uls.json` | Enriched GET metadata subset | 919 rows | Descriptions, provider/category, parameter names, and use cases; not the full corpus |
| `updated_urls.json` / `updated_urls_verified.json` | Updated/verified subset | 919 rows each | Supplemental subset, not proof that the other 1,064 raw rows are absent |
| `et_screeners.json` | ETNow POST request captures | 438 request bodies; one failed source-index capture | Exact `screenerId` + `queryCondition` definitions |
| `et-marketstats-post-requests.json` | ET Marketstats POST request captures | 91 request bodies | Exact technical/intraday operand payloads; combine with four extras in `etMarketstats.ts` |

`url_explorer.normalizer` groups by host, path structure, and query-key set. The original malformed
corpus produces 250 structural templates, matching the historical field report. Running the same
normalizer after canonical URL repair produces 248 templates because malformed-host/path variants
and three duplicate URLs converge. Do not treat that reduction as lost coverage.

#### Concrete screener-request count

The 13 routes in Section 3.8 are endpoint *families*. The individual request inventory is much
larger:

| Source artifact | Concrete screener-like requests | Notes |
|---|---:|---|
| `urls.txt` | 1,388 | Broad path/query heuristic; the earlier keyword audit reported 1,382, a six-row classification difference |
| `et_screeners.json` | 438 | Separate POST payload definitions; ETNow host is absent from `urls.txt` |
| ET Marketstats | 95 | 91 captured POST bodies plus four code-defined extras; ET API host is absent from `urls.txt` |
| **Total across these non-overlapping artifacts** | **1,921** | Concrete request records, not unique endpoint families or guaranteed-live screeners |

The 1,388 raw-corpus screener-like rows are dominated by 1,053 Trendlyne Kayal `screenpk`
requests, 220 MoneyControl scanner `(catId, scanId)` requests, 38 SmartOptions market-filter
requests, and 12 MoneyControl technical-trend requests; 65 additional rows cover Trendlyne
read-through, ET metadata/filter, NiftyTrader, TickerTape, TapeTide, MarketsMojo, and related
screener paths.

These counts must not be presented as 1,921 production integrations. Captured, reachable,
production-enabled, persisted, and ML-consumed are separate statuses. For example, the production
MoneyControl sync intentionally has 143 configured rows rather than blindly replaying all 220
captured category/scan combinations, and some captured URLs are stale, malformed, blocked,
duplicate, or exploration-only. A new project should import the normalized corpus into a registry,
retain the original URL and capture status, and promote a template only after a real-network shape
test, parser test, idempotent writer, and freshness monitor exist.

## 10. Scheduling and Ownership

The source of truth for scheduling is the BullMQ registration code, not prose documentation:

- `src/server/queues.ts`
- `src/server/jobs/*.jobs.ts`
- `src/server/jobRegistry.ts`
- `src/server/monitorScripts.ts`

Major ingestion cadences:

| Pipeline | Typical cadence | Main sources |
|---|---|---|
| Intraday fetch | Every 15 minutes during market hours | MoneyControl/Yahoo |
| Technical signal scan | Every 30 minutes during market hours | DB plus provider features |
| News sentiment | Every 15 minutes, 24/7 | RSS, BSE, MC stock news, optional GNews |
| Screener collection | Every 15 minutes during market hours | Trendlyne and provider screeners |
| Screener sync | Weekday post-close | MoneyControl, Trendlyne, ETNow, ET Marketstats |
| ML daily operations | Weekday evening | Most daily/sparse fetchers and derived features |
| Fundamentals | Weekly/monthly | Yahoo, ET Stats, Trendlyne, MarketsMojo |
| Data quality | Daily plus watchdog checks | All persisted live sources |

When porting, schedule exchange-close data only after the provider has published it. Keep sparse
sources such as insider filings, deals, corporate actions, and earnings on soft freshness alerts.

## 11. Testing and Monitoring Contract

### 11.1 Live datasource test

Every external fetcher needs one real-network test, disabled by default and enabled with:

```bash
RUN_LIVE_DATASOURCE_TESTS=1 python -m pytest -m live_datasource src/server/tests
RUN_LIVE_DATASOURCE_TESTS=1 npx vitest run
```

The test must:

1. Resolve one known ticker through the real mapping helper.
2. Call the fetcher's own request function.
3. Parse with the production parser.
4. Assert a non-empty, expected response shape.
5. Write through the production DB writer into a throwaway database where applicable.
6. Read it back and verify canonical identifier and finite numeric fields.

Helpers live in `src/server/tests/live_datasource_helpers.py`. The repository currently contains
81 marked live test cases/matches across 73 files, including the TypeScript MoneyControl proxy
suite. That is evidence of substantial coverage, not proof that every external call has a test.

### 11.2 Freshness monitoring

Every DB-writing live source needs a check in `src/server/dataQualityChecks.ts`. Prefer a
`TABLE_FRESHNESS_CHECKS` entry and `makeFreshnessCheck()` for simple recency checks.

- Default to trading-day-aware age for exchange data.
- Use calendar age for 24/7 news or global feeds.
- Omit hard failure for naturally sparse event tables.
- Add shape/range/coverage checks separately where freshness alone can pass bad data.

### 11.3 Negative controls

Temporarily break the parser or resolver and confirm the new test fails. A test that reimplements
the parser, checks its own constants, or accepts `all([])` does not protect the integration.

## 12. New Project Implementation Order

1. Create a canonical `security` table keyed by NSE symbol.
2. Import and validate provider mappings; track mapping provenance and last verification time.
3. Implement a shared HTTP client with timeout, retry, jitter, rate limit, response-size limit,
   structured logging, and raw-payload capture.
4. Implement NSE bhavcopy and Yahoo/MC quote fallbacks first.
5. Add corporate actions before computing adjusted returns.
6. Add provider-specific fundamentals and screener feeds one provider at a time.
7. Give every persisted provider table an idempotent writer and provenance columns.
8. Add the live test and freshness/shape checks before scheduling the fetcher.
9. Add BullMQ/cron scheduling only after a manual live run writes valid rows.
10. Query written rows back from the production database before declaring integration complete.

Suggested minimum provenance fields:

```sql
symbol              text not null,
source              text not null,
provider_id         text,
as_of_date          date,
provider_timestamp  timestamptz,
fetched_at          timestamptz not null,
raw_payload_hash    text,
parser_version      text
```

## 13. Known Broken, Limited, or Excluded Sources

| Source | State | Migration guidance |
|---|---|---|
| AMFI scheme bulk endpoint | Returns HTML frameset | Find a replacement before porting |
| ET Markets MF holdings endpoint used by `mf_holdings_fetcher.py` | Reported 404 for mapped symbols | Prefer the separate `mf_stock_holdings_fetcher.py` path |
| Trendlyne cash-flow line items used by working-capital fetchers | Discontinued/limited | Derive from available fundamentals where possible |
| NSE per-equity options/IV | Akamai-blocked/incomplete | Use NiftyTrader/Trendlyne SmartOptions with provenance |
| MoneyControl RSS | HTTP 200 but stale since 2024 | Do not use |
| GNews free tier | Delayed | Disabled by default; use only with explicit acceptance |
| Finology/selected NDTV paths | 403 observed | Optional, live-test before use |
| TickerTape numeric scorecard | Premium-gated | Keep categorical values; do not fabricate numbers |
| TapeTide AI-chat endpoints | Authentication required | Excluded; public score/forecast APIs only |
| StockEdge per-stock APIs | Missing verified ID resolver | Excluded; market-wide high-delivery only |
| Indiatimes SAS endpoints in `explore_mc_tl.py` | Discovery probes only | Not scheduled ingestion; promote only after parser/live-test work |

## 14. Implementation File Inventory

The following files own external market/news requests or provider identity resolution. Internal
model-only and DB-to-DB scripts are intentionally excluded.

### Python ingestion and clients

```text
analyst_estimates_snapshot.py       asm_gsm_fetcher.py
backfill_ohlcv.py                   backfill_sector_industry.py
backfill_sector_mc.py               block_deal_fetcher.py
credit_rating_fetcher.py            delivery_trend_fetcher.py
delivery_volume_fetcher.py          earnings_surprise_fetcher.py
endpoint_registry.py                eps_surprise_fetcher.py
et_stats_client.py                  extra_endpoints_fetcher.py
fii_dii_backfill.py                 fii_dii_fetcher.py
fii_dii_history_fetcher.py          financial_ratios_fetcher.py
fno_rollover_fetcher.py             global_macro_fetcher.py
india_macro_fetcher.py              index_membership_fetcher.py
insider_transactions_fetcher.py     institutional_deals_fetcher.py
intraday_fetcher.py                 investsights_concall_fetcher.py
investsights_corporate_actions_fetcher.py
investsights_investor_activity_fetcher.py
investsights_sector_intel_fetcher.py
market_regime_fetcher.py            marketsmojo_financials_fetcher.py
marketsmojo_fintrend_fetcher.py     marketsmojo_index_fetcher.py
marketsmojo_shareholding_fetcher.py marketsmojo_technical_fetcher.py
mc_advance_decline_fetcher.py       mc_broker_reco_fetcher.py
mc_chart_patterns_fetcher.py        mc_corporate_actions_fetcher.py
mc_corporate_calendar_fetcher.py    mc_earnings_fetcher.py
mc_eco_calendar_fetcher.py          mc_global_macro_fetcher.py
mc_index_ohlc_fetcher.py            mc_index_oi_fetcher.py
mc_ohlcv_backfill.py                mc_pricefeed_fetcher.py
mc_stockvitals_history_fetcher.py   mc_techscanner_fetcher.py
mf_holdings_fetcher.py              mf_sector_flow_fetcher.py
mf_stock_holdings_fetcher.py        mmi_fetcher.py
moneycontrol_fetcher.py             ndtv_fno_basis_fetcher.py
nifty_pe_fetcher.py                 nse_bhavcopy_fetcher.py
nse_ipo_calendar_fetcher.py         nt_change_oi_fetcher.py
nt_dashboard_fetcher.py             nt_oi_snapshot_fetcher.py
nt_pcr_ts_fetcher.py                nt_vix_fetcher.py
pcr_fetcher.py                      preopen_fetcher.py
so_option_chain_fetcher.py          stock_option_chain_fetcher.py
sync_mc_index_map.py                sync_nt_fno_symbols.py
sync_tl_index_map.py                tickertape_client.py
tickertape_deals_fetcher.py         tickertape_scorecard_fetcher.py
trendlyne_adv_tech_fetcher.py       trendlyne_fno_activity_fetcher.py
trendlyne_fundamentals_fetcher.py   trendlyne_overview_fetcher.py
trendlyne_price_analysis_fetcher.py trendlyne_screener_discovery.py
working_capital_fetcher.py
```

All paths above are under `src/server/`.

### TypeScript integrations

```text
companyProfileSyncService.ts        deliveryFetcher.ts
etMarketstats.ts                    etnow.ts
finologyService.ts                  fnoService.ts
fundamentalsSyncService.ts          gdeltService.ts
globalMarketService.ts              indexApiService.ts
insightService.ts                   liveStockData.ts
marketData.ts                       marketIntelService.ts
marketStatusService.ts              mcApiService.ts
moneycontrol.ts                     moneycontrolScreener.ts
moneycontrolService.ts              newsSentimentService.ts
niftytraderAuthService.ts           niftytraderService.ts
nseService.ts                       optionChainService.ts
sectorApiService.ts                 stockMapping.ts
technicalIntelligenceService.ts     technicalSignalsService.ts
tickertape integrations via Python  topMoversService.ts
tradebrainsService.ts               trendlyneAuthService.ts
trendlyneDailyFetchService.ts       trendlyneScreener.ts
trendlyneService.ts
```

### Configuration/data assets required for parity

```text
src/data/stocklist.ts
src/data/nseStocks.ts
scripts/stocklist.json
et_screeners.json
et-marketstats-post-requests.json
tlid_mapping.csv
src/server/endpoint_registry.py
src/server/dataQualityChecks.ts
src/server/jobs/*.jobs.ts
src/server/queues.ts
```

## 15. Host Coverage Reconciliation

Production provider hosts categorized by this guide:

```text
api.bseindia.com
api.anthropic.com
api.gdeltproject.org
api.moneycontrol.com
api.nseindia.com / nseindia.com
api.sensibull.com
api.stockedge.com
api.tapetide.com
api.telegram.org
api.tickertape.in / analyze.api.tickertape.in
appfeeds.moneycontrol.com
archives.nseindia.com / nsearchives.nseindia.com
economictimes.indiatimes.com
etapi.indiatimes.com
etmarketsapis.indiatimes.com
fc.yahoo.com
finnhub.io
feeds.content.dowjones.io
frapi.marketsmojo.com
frapi.trading80.com
ft.com
gnews.io
in.investing.com
investsights.in
json.bselivefeeds.indiatimes.com
kayal.trendlyne.com
livemint.com
marketservices.indiatimes.com
mfapps.indiatimes.com
ndtvprofit.com / www.ndtvprofit.com
news.google.com
onboarding.niftytrader.in
portal.amfiindia.com / www.amfiindia.com
portal.tradebrains.in / tradebrains.in
priceapi.moneycontrol.com
query1.finance.yahoo.com / query2.finance.yahoo.com
sas.indiatimes.com
screener.indiatimes.com
smartoptions.trendlyne.com
thehindubusinessline.com / www.thehindubusinessline.com
ticker.finology.in
trendlyne.com
webapi.niftytrader.in / www.niftytrader.in
www.cnbctv18.com
www.ft.com
www.livemint.com
www.moneycontrol.com
www.tickertape.in
www.trading80.com
zeebiz.com / www.zeebiz.com
```

Operational/AI hosts such as Anthropic, AWS Bedrock, Google Gemini, Firebase, Telegram, Sentry,
and local Ollama/AlphaQuant are categorized separately in Sections 7 and 8. `github.com` appears
only as contact text in a news-fetcher User-Agent and is not a data source.

## 16. Verification Boundary

This guide was reconciled against:

- 68 direct Python `*_fetcher.py` files plus shared clients and sync utilities.
- 161 integration-shaped Python/TypeScript service, client, fetcher, and test files.
- 148 source files containing external URL literals.
- 81 live-datasource marker matches across 73 files.
- BullMQ/job registries and the data-quality registry.
- 27 direct POST call sites across production, scripts, and frontend code, classified into 10
  external provider-data endpoints, two external authentication endpoints, and non-datasource
  AI, notification, internal-service, or frontend-to-backend calls.

The counts describe repository search coverage, not an assertion that all third-party endpoints
were reachable on 2026-08-12. Reachability is intentionally delegated to the gated live tests.