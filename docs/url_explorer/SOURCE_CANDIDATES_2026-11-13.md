# Data-source candidates from urls-explorer's uncommitted work

Snapshot 2026-11-12/13. Every probe below went through this repo's own fetch client
(`url_explorer/fetch_pass.make_fetch_fn`), not curl, and a 200 is recorded as a 200, not as value.
Source inventory: `D:/Github/urls-explorer/unique_successful_endpoints.csv` (endpoint families
with at least one parseable success, latest 2026-11-11). Nothing here was wired into scoring.

## How the shortlist was built

1. Started from the endpoint-family file, not from host names (a host appearing in our code says
   nothing about which of its endpoints we use).
2. Path-matched each family against `market_endpoint_registry` and `url_endpoints`; then removed
   HTML pages, static assets, ad configs and parameter variants of one dataset.
3. For each survivor, searched the database (`information_schema` sweep, then row counts) and the
   fetchers for the same *data family*, because a path can be new while the data is not.
4. Re-probed the survivors with our client and read the body, including freshness fields.
5. Read `measurement.md` and the ledger before saying what a source is worth, and before listing
   any host with a standing restriction.

## Verdicts

| # | Candidate | Evidence (probe 2026-11-12/13) | Verdict |
|---|---|---|---|
| 1 | NSE `api/corporates-corporateActions` history | One call per year returns 2021: 2,324 rows / 1,659 symbols; 2023: 2,586 rows; carries `isin`, `exDate`, `recDate`, `subject`, `series`. Already used for a forward window by `mc_corporate_calendar_fetcher.py` (source `NSE_BULK`), which stores `ratio = NULL` and never reads history. | **EXTEND** (highest value) |
| 2 | NSE `api/corporate-announcements` (bulk, no symbol) | 1,504 rows covering about a day and a half in one call; 22,903 rows over six weeks. Fields: `symbol`, `sm_isin`, `desc` (category), `an_dt`, `exchdisstime`, `sort_date`, `attchmntText`, attachment URL. No announcement store exists here (`investsights_announcement_intel` is vendor-derived). | **ADD**, prospective only |
| 3 | NSE `fo_secban.csv` (`nsearchives.nseindia.com/content/fo/`) | 200, one small file, "Securities in Ban For Trade Date 13-NOV-2026". No ban table exists here. Not in urls-explorer's success list: a lead found while checking the Moneycontrol ban widget, which answers "Bad request" to the captured parameters. | **ADD** (tradability constraint, not a signal) |
| 4 | Moneycontrol `technicalCompanyData/oiData/getFnoOiTrends` | 200, one call returns 221 stocks with `trend`, `category`, `scId`, `expiryDate`, `openInt`, `oiPerChange`, `price`. Our writer makes two calls per stock (`getExpDts` + `getFuturesData`). | **EVALUATE** the bulk endpoint against the stored series. Better bulk source found: the exchange's own daily F&O file (one request, 218 stock futures on 2026-11-11) matches our stored Moneycontrol OI and OI change exactly for 216 of 216 overlapping symbols. It is now stored (`stock_futures_eod_history`, AF-20261113-03) |
| 5 | NSE `NSE_CM_security_<DDMMYYYY>.csv.gz` (security master) | 200, 38,420 lines, columns include `TckrSymb`, `SctySrs`, `ISIN`, `NewBrdLotQty`, `SctyStsNrmlMkt`. | **ADD** for identity gaps (`market_identifier_gap`) |
| 6 | Upstox v3 historical candles (`api.upstox.com`) | 200 with no token for 2022-01-03 and 2026-11-11 (375 one-minute bars each). The provider's documentation says authorization is required, so access can change. HDFCBANK's pre-bonus first-minute open is about half the raw exchange open: retrospective adjustment, cannot be mixed with raw bars. Instrument list: `mf.niftytrader.in/api/upstox-instruments` (20,849 rows). | **CONDITIONAL**: obtain an account and read the terms first |
| 7 | TEJ `api.tejhq.dev` | 200: `/v1/snapshot/nse?date=` returned 2,978 rows with `series`, `isin`, OHLC; `/v1/actions/HDFCBANK` returned 26 actions. Operator, terms and auth unknown. | **CROSS-CHECK only**, after terms are read |
| 8 | GitHub `nse-security-master` `symbol_history.csv` | 200. Third-party repository; its own docs name exchange data as its source. | Alias **candidate** list, not authority |

Already covered, or not usable, so not onboarded:

| Candidate | Why not |
|---|---|
| NSE `integrated-filing-results` | Same family as `nse_results_filings` (92,601 filings, 2021-01 onward). |
| NSE `holiday-master` | `market_holidays` already holds the calendar (to 2026-12-25). Cross-check at most. |
| StockEdge latest bulk deals | Four deal tables already exist; ten rows per page. |
| NiftyTrader `derivative-summary-data` | 200 but **stale**: `last_trade_time` 2026-05-08, expiry 2026-05-26. A 200 on a frozen snapshot. |
| NiftyTrader `gap-analysis` | 200, empty lists for 2026-11-11. |
| NiftyTrader `fno-lot-size`, `bulk-deal-data` | Application-level "Unauthorized" without the account token; the data is already stored elsewhere. |
| Moneycontrol widgets `consensus-ratings`, `splits-bonuses` | "Bad request" to the captured parameters: unresolved, not dead. Re-capture the browser request before judging. |
| InvestSights `market-momentum`, `psychology` | One market-wide value per day: zero cross-sectional variance, context only. `stock-history/{symbol}` duplicates `stock_ohlcv`. |
| ET technical dashboard | A derived screener; our screener families already cover it. |
| Tapetide | Blocked: terms prohibit automated extraction (AF-20261107-09). |
| Trendlyne family (about 400 of the success rows) | Mostly public screener pages, and the 405 human-verification pause markers are standing. `smartoptions.trendlyne.com` was not probed for that reason. |
| Sensibull, Sapphire, smallcase, Tickertape assets, ET ads/static | Pages and static files, no market data. |

## Onboarding notes for the recommended items

Follow `.claude/skills/onboard-data-source`; these are the points that are specific.

**1. NSE action history (extend, do not add a source).**
- Endpoint needs the NSE homepage cookie first (`_nse_session()` pattern) and `from_date` / `to_date` as `DD-MM-YYYY`.
- Resolve by `isin` first (it is in the payload), `symbol` second; never construct an id.
- Parse `subject` into `ratio` and `amount`; keep unparsed text. Store `OTHER` with the subject text so demergers and capital reductions are findable. Today the subject is discarded, which is the cause of the fake -60..-91% returns documented in `bugs-data-layer.md` (2026-10-15).
- The table has no announcement date, and `caBroadcastDate` was null in the sample: the history is a current snapshot, not point-in-time. Do not use it to reconstruct what was known on a past date.
- Test: the existing `corporate_actions` live test plus a fixture with a demerger subject and a split subject.
- ML value: none directly. It is infrastructure for `ohlcv_adjust` and the seam detector.

**2. NSE announcements.**
- New table keyed `(symbol, seq_id)`; store `exchdisstime` AND the local first-seen timestamp. Only the local timestamp is a decision-time truth.
- Upper bound seen: 22,903 rows per six-week request; page by date window, not by symbol.
- ML value (Phase 8): not testable until about a year of locally timestamped history exists; there is no backfill that is honest about first-seen time. Event-type features sit in the "calendar-blocked" class in `measurement.md`. Do not wire into the ranker.

**3. F&O ban list.** One row per `(trade_date, symbol)`; `Securities in Ban For Trade Date` gives the date. Use it to exclude, never to rank.

**4. Bulk futures OI.** Do not switch writers until the same-date comparison against the per-stock path shows the same `openInt` and expiry for the overlapping 221 names; the per-stock path covers 242.

**5. Security master.** Join on ISIN into `market_identifier_gap`; it adds series and lot size but is a daily snapshot, so keep dated copies.

## Leads from inside this repo

- **Futures OI history and the 2024-07 option-history stop: done 2026-11-13 (AF-20261113-03).** The fetcher now keeps the futures rows of the same daily F&O file in `stock_futures_eod_history`, and a backfill from 2021-01-01 to date is running. Checking it against Moneycontrol exposed AF-20261113-02: a shared `mcsymbol` stored one company's futures under a non-F&O sibling (1,067 rows, 22 symbols); the purge awaits the owner.
- **A lock pile-up on `stock_ohlcv`, seen live 2026-11-12.** An `ALTER TABLE stock_ohlcv ADD COLUMN IF NOT EXISTS adjustment_basis TEXT` sat in `wait_event_type = Lock` for 26 minutes with at least seven other queries queued behind it; it had cleared by the time I looked for the blocker, so I could not name it. Two runtime writers issue that statement unconditionally (`backfill_ohlcv.py:188`, `mc_ohlcv_backfill.py:95`). `IF NOT EXISTS` still takes the ACCESS EXCLUSIVE lock when the column exists (`bugs-testing-env.md`, schema-isolation entry). Fixed 2026-11-13 (AF-20261113-01): both writers use `db_compat.ensure_column`.

## The process urls-explorer used, as it applies here

1. Capture real browser requests into a catalog; keep method, headers and POST body.
2. Probe with the full browser header set, a warmed session (NSE homepage cookie), the per-portal referer ladder, and retries only on transport / 429 / 5xx. A 4xx is a measurement.
3. Store the raw body, its hash, the URL and the retrieval time. Keep source date and receipt time as different fields.
4. Reconcile against exchange raw data before trusting a vendor (bhavcopy, action filings).
5. State what a 200 does not prove: first-seen time, completeness, a current value, an adjustment basis.
6. Publish definitions as versioned, immutable files with measured coverage. That last step is `docs/ontology/signal_catalog/`.
