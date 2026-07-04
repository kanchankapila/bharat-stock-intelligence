# Fetcher Health Tracker

_Living record of every network-calling fetcher script in `src/server/`, its current health,
and pending action items. Written 2026-07-04 after a full live audit (every fetcher run at
least once against production URLs) plus a same-day fix pass. Update this file whenever a
fetcher's status changes — don't let it go stale._

---

## How to re-check a fetcher

```
cd src/server
PYTHONIOENCODING=utf-8 ../../backend-python/venv/Scripts/python.exe -u <script>.py
```

`PYTHONIOENCODING=utf-8` matters — without it, scripts printing ₹/→/other non-ASCII on a
Windows console will crash even though production (`pythonRunner.ts` → `runPython()`) already
sets this env var and is unaffected.

---

## ✅ Fixed 2026-07-04 (verified live)

| Script | Bug | Fix |
|---|---|---|
| `financial_ratios_fetcher.py` | `tl_financial_quality` was missing `fetched_at` — first insert failed with `UndefinedColumn`, then every subsequent symbol failed with `InFailedSqlTransaction` (no rollback) | Self-healing `ALTER TABLE ... ADD COLUMN fetched_at` in `ensure_schema()` + `con.rollback()` in the per-symbol except block. Schema-of-record (`db/schema.postgres.sql`) updated too. |
| `eps_surprise_fetcher.py` | Uncaught `orjson.JSONDecodeError` when MC's bulk `actual-estimate` endpoint returns empty — killed the whole script | Wrapped in try/except, degrades to `0 stocks resolved` and continues |
| `fii_dii_backfill.py` | Uncaught `HTTPError` on tradebrains.in 502 | Added 3x retry with backoff + graceful exit (still fails today — tradebrains.in itself is down, see below) |
| `credit_rating_fetcher.py` | Queried `nse_stocks.bse_code`, a column that has never existed — always fell through to a warning + fallback | Removed the dead primary query; goes straight to the working ISIN-based fallback |
| `market_regime_fetcher.py` (USDINR) | Called the retired `currency/get-currency-data?section=major` endpoint (404-adjacent/empty) | Switched to `us-markets/getCurrencies` (same endpoint `mc_global_macro_fetcher.py` already uses successfully) |
| `market_regime_fetcher.py` (Nifty basis) | NiftyTrader fallback parsed a `resultData.data` key that doesn't exist, and expected `spotPrice`/`futPrice` fields NT's dashboard-data never returns (it only has one price, `last_trade_price`, per index) | Rewired to read `resultData.indices`, pair NT's futures `last_trade_price` with the NIFTY50 spot close already written to `macro_indicators` by `global_macro_fetcher.py`, and compute basis from that pair |

---

## 🔴 Confirmed broken upstream — no client-side fix exists (decision: leave as-is, documented here)

| Script | URL(s) failing | Root cause | Notes |
|---|---|---|---|
| `working_capital_fetcher.py` | `https://trendlyne.com/mapp/v1/stock/chart-data/{tlid}/{param}/` for `TRADE_RECEIVABLE_Q`, `DEBTORS_Q`, `INVENTORIES_Q`, `TRADE_PAYABLE_Q`, `CREDITORS_Q`, `REVENUE_Q`, `COGS_Q`, `RAW_MATERIAL_Q` | Trendlyne returns `head.status=0` (success) but empty `eodData` for every one of these 8 params — verified against HDFCBANK (tlid 533), one of the most-covered stocks on the platform. Trendlyne discontinued/renamed this class of quarterly line items. | Runs harmlessly (0 rows written), just wastes ~6700×5 HTTP calls per run. |
| `financial_ratios_fetcher.py` (data, not the crash) | Same base URL, params `CFO_Q`, `CAPEX_Q`, `EBIT_Q`, `INT_EXP_Q` | Same as above — verified empty for HDFCBANK. Only `market_cap` (read from the side-channel `stockHeaders`/`stockData` in the response) still populates; FCF yield / interest coverage will be `n/a` for everything. | Crash is fixed; data gap is not. |
| `mf_holdings_fetcher.py` | `https://mfapps.indiatimes.com/ET_Mutual_Funds/pages/mftools/MFPortfolioHolding.cms?bsecode=&nsecode={symbol}&prime=N&flag=1` | Returns **404 for every symbol**, verified directly (RELIANCE/ABB/TCS/HDFCBANK all 404). ET Markets appears to have removed this endpoint entirely. | 100% "no data" is not a symbol-coverage issue — the endpoint is dead. |
| `mf_sector_flow_fetcher.py` | `https://portal.amfiindia.com/DownloadSchemeData_Po.aspx?mf=0&tp=1&fD=...&tD=...` | Confirmed via deep investigation (see below) that AMFI restructured their entire portfolio-disclosure distribution: this URL now returns an unrelated **scheme-master** file (ignores the `tp` param entirely, byte-identical for every `tp` value 1–7). AMFI's portfolio-disclosure page (`/online-center/portfolio-disclosure`) is now just a directory of links to ~54 individual AMC websites, each with its own file format (PDF/XLSX/ZIP). The one remaining AMFI-hosted API (`https://www.amfiindia.com/api/schemewisedisclosure-investment?MF_ID=...&strMonth=...`) is quarterly, not monthly, and covers only a narrow SEBI-circular subset (346 rows for UTI's 55 schemes over a quarter — a fraction of true full-portfolio holdings). | **No drop-in replacement exists.** Real fix requires either (a) a per-AMC scraper for ~54 sites in inconsistent formats, (b) accepting the narrower quarterly `schemewisedisclosure-investment` feed as a partial signal, or (c) a paid data vendor (ACE MF / Value Research / Morningstar-style feed). |
| `india_macro_fetcher.py` (eco-calendar) | `https://api.moneycontrol.com/mcapi/v1/ecalendar/get-actual-event-data?page=...&pageSize=50` | 404 "Cannot GET" — path no longer exists on MC's API gateway. | |
| `india_macro_fetcher.py` (repo rate) | `https://api.moneycontrol.com/mcapi/v1/premarket/get-global-marketdata?section=ir` | `section=ir` was retired; MC's own 422 error names the current valid values: `mi, ii, co, cu, bo, adr, all`. None of these carry RBI repo rate — `bo` (bonds) only has 10Y sovereign yields for 7 countries, no policy rate field. | Repo rate signal may simply no longer be available from MC; would need an RBI-direct source. |
| `credit_rating_fetcher.py` (BSE announcements) | `https://api.bseindia.com/BseIndiaAPI/api/Corpfiling/w?...&Category=Rating&...` | Returns HTTP 200 but an HTML error page (`<!DOCTYPE html>...`) instead of JSON — verified with the exact script logic including the cookie-priming step. Likely stiffer bot-protection on BSE's side. | Already fails gracefully (existing try/except catches the JSON decode error); just yields 0 events every run. |
| `nifty_pe_fetcher.py` (sector sub-indices) | `https://api.moneycontrol.com/mcapi/v1/indices/fundamentals/graph/pe?indId={19,41,52,39,51}&duration=...` (NIFTYIT/PHARMA/AUTO/FMCG/METAL) | MC's own graph endpoint returns a single data point with `data: 0` and the *wrong* index level in `niftydata` (shows NIFTY 50's level, not the sector index's) — confirmed for indId 19 (NIFTYIT) and 41 (NIFTYPHARMA). This is corrupted data server-side on MC's end. | NIFTY50 (indId 9) and NIFTYBANK (indId 23) work fine (247 dates each) — only the smaller sector indices are affected. |

---

## 🟡 False alarms from the initial audit — confirmed working, just slow/quiet

These looked broken during the initial sweep (silent for 40-60s, or long runs of "no data")
but were verified working against small test batches:

- `analyst_estimates_snapshot.py` — only prints one summary line at the very end; confirmed `3/3` written against `--symbols RELIANCE,TCS,HDFCBANK`.
- `intraday_fetcher.py` — same pattern; confirmed `501 bars upserted` against a 3-symbol test.
- `earnings_surprise_fetcher.py` — the long "no data" runs were all genuine micro/small-caps early in the alphabet with no analyst coverage; confirmed MC's forecast/hits endpoints return real data for HDFCBANK.
- `nt_change_oi_fetcher.py` / `nt_oi_snapshot_fetcher.py` / `nt_pcr_ts_fetcher.py` all report `GIFTNIFTY: Data Not Found` — NiftyTrader simply doesn't carry GIFT Nifty option-chain data; not a bug.

---

## Confirmed fully working (2026-07-04 audit)

`asm_gsm_fetcher`, `global_macro_fetcher`, `fii_dii_fetcher`, `mc_broker_reco_fetcher`,
`mc_eco_calendar_fetcher`, `mc_global_macro_fetcher`, `mc_advance_decline_fetcher`,
`mc_pricefeed_fetcher`, `mc_index_ohlc_fetcher`, `mc_index_oi_fetcher`,
`mc_chart_patterns_fetcher`, `mc_corporate_calendar_fetcher`, `nt_dashboard_fetcher`,
`nt_vix_fetcher`, `pcr_fetcher`, `stock_option_chain_fetcher`, `so_option_chain_fetcher`,
`fno_rollover_fetcher`, `sync_nt_fno_symbols`, `trendlyne_price_analysis_fetcher`,
`trendlyne_adv_tech_fetcher`, `trendlyne_fundamentals_fetcher`, `trendlyne_overview_fetcher`,
`trendlyne_screener_discovery`, `sync_tl_index_map`, `insider_transactions_fetcher`,
`block_deal_fetcher`, `delivery_volume_fetcher`, `sync_mc_index_map`, `moneycontrol_fetcher`,
`preopen_fetcher`, `index_membership_fetcher` (crash only happens without `PYTHONIOENCODING`,
non-issue in production), `delivery_trend_fetcher` (same encoding caveat).

---

## TODO / pending decisions

- [ ] **`mf_sector_flow_fetcher.py`** — decide whether to (a) rewrite as a 54-site AMC scraper, (b) swap to the narrower quarterly `schemewisedisclosure-investment` API and accept reduced coverage, or (c) evaluate a paid MF-holdings data vendor. Currently produces zero data every run.
- [ ] **`mf_holdings_fetcher.py`** — find a replacement MF-holding-% data source; ET Markets' endpoint is dead with no known alternative yet.
- [ ] **`working_capital_fetcher.py`** / **`financial_ratios_fetcher.py`**'s cash-flow params — investigate whether Trendlyne exposes these figures under new param names (their site UI may still show them under a different chart-data key), or derive CCC/FCF-yield/interest-coverage from `stock_fundamentals`/`fundamentals_history` we already ingest instead of Trendlyne's chart-data API.
- [ ] **`india_macro_fetcher.py`** — find an alternate eco-calendar source (NSE/BSE corporate announcements already used elsewhere) and an alternate RBI repo-rate source (RBI's own site, or a different MC section) since `section=ir` is gone.
- [ ] **`credit_rating_fetcher.py`** — BSE's Corpfiling endpoint now returns HTML instead of JSON; would need fresh reverse-engineering of BSE's current bot-protection/session requirements to restore this feed.
- [ ] **`nifty_pe_fetcher.py`** — MC's PE-graph endpoint serves corrupted data for NIFTYIT/PHARMA/AUTO/FMCG/METAL (`indId` 19/41/52/39/51); consider an alternate sector-PE source (Trendlyne sector-rotation endpoints, already confirmed working, may carry equivalent data) instead of MC for these five indices.
- [ ] No scheduler changes made — all of the above still run on their existing cron per `queues.ts` / `JOB_REGISTRY`; they fail gracefully (no crashes) but produce no new data until one of the above is addressed.
