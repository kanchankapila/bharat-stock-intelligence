# Data sources

Two artefacts are the source of truth. Rerun `bqa catalog --urls ../urls.txt` for live counts.

- `src/bharat_alpha/ingest/registry.py` lists the live connectors. Monitoring is generated from
  it.
- `config/source_catalog.yaml` triages all 1,995 URLs in the repo's `urls.txt` into endpoint
  families. `tests/test_catalog.py` fails if any URL is left unclassified.

## Integrated

| Connector | Source | Point-in-time | Feeds |
|---|---|---|---|
| `nse_bhavcopy` | NSE `sec_bhavdata_full_DDMMYYYY.csv` (2021-01 onward) | yes, exchange record | universe, OHLCV, delivery %, corporate-action factors, trading calendar |
| `nse_fo_bhavcopy` | NSE F&O UDiFF bhavcopy (stock futures) | yes | basis, OI change, F&O flag |
| `nse_index_close` | NSE `ind_close_all_DDMMYYYY.csv` | yes | INDIA VIX, NIFTY 500, index P/E |
| `nse_fii_dii` | NSE `/api/fiidiiTradeReact` | forward-only (legacy history via bridge) | FII/DII 5- and 21-day net |
| `nse_symbol_change` | NSE `symbolchange.csv` | yes | instrument identity across renames |
| `nse_board_meetings` | NSE `/api/corporate-board-meetings` | broadcast timestamp | days to results |
| `nse_insider_pit` | NSE `/api/corporates-pit` | disclosure timestamp | insider net buying |
| `investsights_fundamentals` | InvestSights fmp-ratios + growth-metrics | forward-only (stored only when a value changes) | ROE, D/E, E/P, B/P, Piotroski, growth |
| `mc_estimates` | MoneyControl analyst-rating, price-forecast, earning-forecast (scId from `alpha.provider_id`; ambiguous legacy codes dropped) | forward-only (stored only when a value changes); legacy `analyst_estimates_history` importable via `bqa import-estimates` | buy share and its change, log coverage, target upside, 63-session target and EPS revisions |
| `legacy_bhavcopy` (bridge) | legacy `nse_universe_history` + `fii_dii_flow` | the same exchange files | a ~5-year bootstrap on day one |

⚠ **Not live-verified in this build.** The build container's network policy blocked every
market-data host (nseindia.com, moneycontrol.com, yahoo, niftytrader), so parsers were written
from:

- NSE's published formats,
- the legacy fetchers that parsed these files live (field names cross-checked against
  `fno_rollover_fetcher.py`, `insider_transactions_fetcher.py`,
  `investsights_fundamentals_fetcher.py` and `nse_bhavcopy_fetcher.py`), and
- fixture tests.

Run `RUN_LIVE_DATASOURCE_TESTS=1 pytest tests/test_live_sources.py` before trusting any
connector. The least certain field names are in `nse_board_meetings` (`bm_*`).

## Triage of `urls.txt` (1,995 URLs, all classified)

| Verdict | URLs | Main families |
|---|---|---|
| rejected | 1,376 | Trendlyne and MoneyControl screener membership (1,331), vendor composite scores, MarketsMojo |
| superseded | 291 | prices, technicals, sector and OI data that the exchange files already give with full history |
| backlog-high | 33 | per-stock implied vol and options OI (NiftyTrader), index IV history (Sensibull), NSE pre-open, InvestSights estimates |
| backlog-medium | 73 | earnings surprise, global cues, Trendlyne options analytics, shareholding, F&O ban list |
| backlog-low | 193 | news text, deals, vendor forecasts, LLM summaries, misc |
| integrated | 29 | MoneyControl estimates (26), NSE archives and InvestSights ratios (3) |

## Onboarding the backlog, in order

1. ~~Analyst estimate revisions~~ — integrated 2026-09-28 as `mc_estimates`. The remaining
   step is grading: once ≥20 effective dates of revisions exist (legacy history helps), the
   next scheduled retrain decides through the gate whether they earn weight.
2. **Options implied volatility per stock** (`niftytrader_options`, `trendlyne_options`) and
   **index IV history** (`sensibull`). These cover risk and regime; start collecting early,
   because only forward history exists.
3. **NSE pre-open**. This is a prerequisite for the opening-range intraday module, where the
   legacy's only validated edge lives.
4. **Shareholding changes**: quarterly, knowable at the filing date, and needs about 8 quarters
   before it can be graded.

Each new connector implements `fetch / parse / write`, declares `Health`, joins `CONNECTORS`,
gets a live test in `tests/test_live_sources.py`, and moves its catalog family to
`integrated`. Its features only reach production through the gate.
