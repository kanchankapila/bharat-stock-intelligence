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

## Repo-wide audit (`bqa sources-audit`)

`urls.txt` is not the only place sources live. The audit also scans `unique_urls.txt` and every
URL written in the legacy codebase: fetchers, docs and scripts. On 2026-09-28 that was 7,762 URLs.

Every data host must map to a catalog family, and `tests/test_catalog.py` fails otherwise, so
nobody can wire in a new source without a verdict. The first run found hosts nobody had
evaluated, now all cataloged:

- **NSE archives:** the listing master `EQUITY_L.csv`, the results-filing RSS feed, the
  announcements RSS and filing PDFs, and the MTO delivery files.
- **Other data sites:** BSE, TradeBrains, AMFI, Sensibull's event calendar, Yahoo and Finnhub
  quotes, ET index filters, GDELT, and eight news RSS feeds.

It also corrected two stale verdicts. NSE pre-open is now **integrated**. NiftyTrader per-stock
options is now **superseded** by `alpha.option_daily`.

**Data we still lack, by priority** (URLs per family, from the audit):

| Priority | Family | What it would add | History |
|---|---|---|---|
| high | `investsights_estimates` (3) | a second analyst-estimate source | forward-only |
| high | `sensibull` (2) | NIFTY/BANKNIFTY IV history (regime) | yes |
| high | `nse_rss_results` (1) | exact results-filing time, which pins the earnings reaction day | forward-only |
| medium | `trendlyne_options` (198) | options analytics beyond the bhavcopy (e.g. build-up classification) | forward-only |
| medium | `mc_earnings` (92) | **reported EPS**, the input a standardised surprise (SUE) needs | forward-only |
| medium | `mc_global` (12) | global cues (US/Asia close, GIFT Nifty) for the overnight gap | forward-only |
| medium | `shareholding` (11) | forward ownership collection (history now via the legacy table) | forward-only |
| medium | `niftytrader_banlist` (5) | F&O ban events | forward-only |
| medium | `nse_archives_equity_master` (1) | ISIN and listing date for every name | snapshot |

**Free sources found by web research (2026-09-28).** None of these appeared anywhere in the
repo. They are cataloged so the audit classifies them when they are wired in. Exchange files
come first because they have dated history and the bhavcopy's trust level:

| Priority | Family | Source | Why |
|---|---|---|---|
| ~~high~~ integrated | `nse_participant_oi` | `nsearchives…/content/nsccl/fao_participant_oi_DDMMYYYY.csv` (and `_vol_`) | FII / DII / Pro / Client long-short in index and stock futures and options, a dated daily archive with years of history. A market-regime block the engine lacks. |
| high | `nse_api_results` | `nseindia.com/api/corporates-financial-results`, `/api/results-comparision?symbol=` | Reported revenue, PAT and EPS, plus each filing's broadcast time. This is the standardised earnings surprise (SUE) input, from the exchange rather than `mc_earnings`. |
| medium | `nse_fo_secban` | `…/content/fo/fo_secban_DDMMYYYY.csv` | Dated F&O ban list. Supersedes the vendor ban-list routes, with history. |
| medium | `nse_security_lists` | `…/content/equities/delisted.csv`, `namechange.csv`, `fo_mktlots.csv` | Delisting dates and reasons, for survivorship; lot sizes, for rupee exposure. |
| medium | `nse_pr_bundle` | `…/archives/equities/bhavcopy/pr/PRddmmyy.zip` (Bc, Hl, Pd files) | The exchange's own corporate-action file: an independent check on factors derived from `PREV_CLOSE`. |
| medium | `macro_fred` | FRED / ALFRED API (free key) | US yields, the dollar and oil, vintage-dated so they can be point in time. These are the overnight drivers of the NSE opening gap. |
| low | `macro_rbi` | RBI DBIE | Policy rate and reserves; slow-moving. |

Also looked at and not adopted:
- **Python wrappers over NSE's site** (`nsepy`, `openchart`, `stock-nse-india`): they return the
  same data, and the engine calls the exchange files directly.
- **Yahoo-based free APIs:** superseded by the bhavcopy.
- **Broker APIs** (ICICI Breeze): free historical intraday bars, but they need a trading account
  and, from 2026-04-01, a static IP. Worth it only once the opening-range intraday module is
  built.

**Live status (2026-09-28).** `RUN_LIVE_DATASOURCE_TESTS=1` failed all 8 live tests. Each failed
at the network gateway (`403 to CONNECT` for nseindia.com, nsearchives, investsights.in and
moneycontrol.com), not in a parser. What these sources return in production is still
unverified (AF-20260928-10).

## Onboarding the backlog, in order

1. ~~Analyst estimate revisions~~ — integrated 2026-09-28 as `mc_estimates`. The remaining
   step is grading: once ≥20 effective dates of revisions exist (legacy history helps), the
   next scheduled retrain decides through the gate whether they earn weight.
2. ~~Options implied volatility per stock~~ — computed 2026-09-28 from the exchange's own F&O
   bhavcopy (`nse_fo_bhavcopy`'s stock-option rows → `alpha.option_daily`): ATM IV, 95/105
   skew, term structure, put/call OI and volume, with history back to the UDiFF start. That
   makes `niftytrader_options` / `trendlyne_options` redundant for IV; they stay in the backlog
   only for fields the exchange file lacks. **Index IV history** (`sensibull`) is still open —
   India VIX (`nse_index_close`) covers the market level.
3. **NSE pre-open**. This is a prerequisite for the opening-range intraday module, where the
   legacy's only validated edge lives.
4. ~~Shareholding changes~~ — history imported 2026-09-28 from the legacy
   `marketsmojo_shareholding_history` (`bqa import-shareholding`), dated by the SEBI LODR
   Reg. 31 deadline (quarter end + 21 days) or the fetch date if earlier. Features are levels and
   quarter-on-quarter changes; grading needs about 8 quarters. **Forward source:** the URL
   corpus has two more per-stock shareholding routes (both in the `shareholding` family), and
   `stocks.sapphirebroking.com/api/market/NSE/{symbol}/shareholdings` is preferred because it
   is keyed by the NSE symbol itself (no provider id to map). It needs the session-cookie
   handshake in `DATA_FETCHING_GUIDE.md` §3.4, and one live payload capture before a parser is
   written. The build container can't reach any of the three hosts. The same Sapphire family also
   has the F&O ban list (`/api/market/ban-list`, backlog-medium).

Each new connector implements `fetch / parse / write`, declares `Health`, joins `CONNECTORS`,
gets a live test in `tests/test_live_sources.py`, and moves its catalog family to
`integrated`. Its features only reach production through the gate.
