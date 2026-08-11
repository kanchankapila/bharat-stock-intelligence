# Data Sources & Ticker Resolution

Read before adding a fetcher, a provider, or a table keyed on a provider-issued id.

### Canonical Identifier

The **NSE symbol** (e.g., `HDFCBANK`, `INFY`, `BAJAJ-AUTO`) is the single source of truth across the entire platform. All provider-specific IDs are derived from it, never the reverse.

### Provider ID Map

| Provider | ID field in `StockMapping` | Format | Example |
|---|---|---|---|
| NSE / internal | `symbol` | Uppercase ticker | `HDFCBANK` |
| Yahoo Finance | _(derived)_ | `symbol + ".NS"` | `HDFCBANK.NS` |
| MoneyControl | `mcsymbol` | Opaque short code | `HDF01` |
| Trendlyne | `tlid` / `tlname` | Numeric string / kebab slug | `533` / `hdfc-bank-ltd` |
| ET / ETnow | `companyid` | Numeric string | `9195` |
| ISIN (universal) | `isin` | 12-char alphanumeric | `INE040A01034` |
| MoneyControl stockid | `stockid` | Numeric string | `592009` |
| MarketsMojo | `stockid` _(shared)_ | Numeric string | `592009` |

**MarketsMojo (onboarded 2026-08-11)** — 5 fetchers (`marketsmojo_{technical,financials,fintrend,index,shareholding}_fetcher.py`) writing 5 `marketsmojo_*_history` tables. It reuses the **MoneyControl `stockid`**, read from `scripts/stocklist.json` via each fetcher's `load_sid_map()`; there is no new opaque id, so nothing was added to `StockMapping`. Requires a `Referer: https://www.marketsmojo.com/` header. Note the shared id: a `stockid` alone does not identify the *provider*, so any future table keyed on it needs the provider in the PK per the composite-key rule below — the existing 5 are keyed on `symbol`, which sidesteps it.

### Resolution Files

- **`src/data/stocklist.ts`** — authoritative mapping table for 180 liquid stocks; holds all provider fields. Always preferred.
- **`src/data/nseStocks.ts`** — master list of 2000+ NSE stocks; NSE symbol + basic info only, no provider mappings.
- **`src/server/stockMapping.ts`** — lookup functions; `stocklist.ts` takes precedence over `nseStocks.ts`.

### Resolution Order (for any new provider)

1. **`stocklist.ts` first** — call `getStockMapping(nseTicker)` to get the full `StockMapping` object and read the provider's field directly.
2. **Provider autocomplete API second** — if the stock is not in the 180-stock list, call the provider's search/autocomplete endpoint with the NSE symbol and cache the result in the `scIdCache` pattern already used for MoneyControl.
3. **ISIN as fallback** — if the provider accepts ISIN, it is universally available from `StockMapping.isin` for all 180 stocks.
4. **Never guess** — do not construct provider IDs by convention. Each provider's ID scheme is opaque and must be resolved explicitly.

### Adding a New Provider

When integrating a new data source (new URL, new API endpoint):

1. **Identify the provider's ID type** — look at its API docs/response to find what it uses to identify a stock (symbol, ISIN, internal ID, slug).
2. **Add a field to `StockMapping`** in `src/data/stocklist.ts` if the provider has its own opaque ID not derivable from existing fields.
3. **Populate mappings for the 180 stocks** in `stocklist.ts` before writing any fetch logic.
4. **Add a resolver function** in `src/server/stockMapping.ts` following the `resolveMoneycontrolSymbol` pattern: hardcoded map first → in-memory cache → provider autocomplete API fallback.
5. **For Yahoo Finance-style providers** — if the provider accepts `symbol.NS` or `symbol.BO` suffix conventions, derive it inline without adding a new field.
6. **Cache the resolved ID** — use `Map<string, string>` keyed on the uppercase NSE symbol, populated on first resolution.

### Adding a New Data Source (MANDATORY test + monitoring requirements)

A new fetcher needs **two** things, not just the test below: (1) the `live_datasource` test
described in this section, and (2) a freshness check in `src/server/dataQualityChecks.ts` — see
the "General Rules" mandate above for how (a one-line `TABLE_FRESHNESS_CHECKS` entry via the
`makeFreshnessCheck()` factory in almost every case). The test catches a fetcher that's silently
wrong on day one; the data-quality check catches one that's silently wrong (or dead) on day
200 — neither substitutes for the other.

Every fetcher that reads from an external URL/API — new or existing — needs one test marked
`@pytest.mark.live_datasource` (see `src/server/tests/conftest.py`, `live_datasource_helpers.py`,
and the two worked examples `test_live_datasource_trendlyne_screener.py` /
`test_live_datasource_et_stats.py`) that:

1. Hits the real endpoint for **one** real, well-known ticker/screener/companyId — using the
   fetcher's own resolution helpers (`getStockMapping`/`load_companyid_map`/etc.), not a
   hardcoded ID that could go stale silently.
2. Parses the response with the fetcher's **own** parsing function — never a hand-rolled
   reimplementation, or the test can pass while the real code is broken.
3. Asserts the response is non-empty and shaped as expected (`assert_non_empty_response`).
4. If the fetcher writes to the DB, writes through its **own** DB-write function into a
   throwaway/in-memory DB, then reads the row back and asserts it's ML-usable:
   identifier columns look like real identifiers, not a URL or scrape artifact
   (`assert_looks_like_ticker`); numeric columns are real finite numbers, not `None`/NaN/an
   unconverted string (`assert_numeric_and_finite`).

These tests are **skipped by default** (`conftest.py` — opt in with `RUN_LIVE_DATASOURCE_TESTS=1`)
and never run in CI (no guaranteed network access to third-party financial sites, and a
transient upstream outage must never fail the build). Run them by hand before merging a new
fetcher, or periodically as a manual canary.

**Why this is mandatory, not optional:** on 2026-07-23, `trendlyne_screener_discovery.py` had
a silent bug (a blind "column 0" fallback when no table header matched an expected field
name) that wrote a raw Trendlyne profile URL into the `symbol` column instead of a ticker —
undetected for its entire life because nothing ever hit the real API and checked the shape of
what came back. It corrupted ~2.1M rows across 7 tables (`confluence_signals`,
`unified_recommendations`, `stock_scores`, `stock_factor_breakdown`,
`stock_factor_breakdown_history`, `recommendation_log`, `intraday_recommendations`) before
being found by a live database review, not by any test. Writing the `live_datasource` test
for that fetcher *after* the fix immediately caught a second, independent, previously-unknown
bug in the same code (the header-matching logic checked the wrong JSON key — `field`/`key`
instead of the API's real `unique_name` — meaning the script's symbol extraction had never
actually worked, always silently falling through to the same corrupt path). A mocked unit
test would have caught neither; only hitting the real endpoint did.

### Index Resolution

Indices use a separate `indexData` array in `src/server/stockMapping.ts` with `{ symbol, name, id }` tuples. Provider IDs for indices (e.g., MoneyControl `id` field) are stored there, not in `StockMapping`. Follow the same lookup-first pattern via `getIndexMapping(query)` before calling any index API.

## Composite primary keys for provider-issued ids

- **Any table keyed on an ID a third-party provider issues must include the provider as part of the primary key — never a bare provider-issued integer/string alone.** MoneyControl, Trendlyne, ETnow, and et_marketstats each hand out their own small-integer/opaque `scan_id`/`screener_id`/`screenpk` independently, and their ranges overlap in practice (confirmed collisions, not theoretical). This exact bug — a bare `scan_id`/`screener_id` PK letting one provider's row silently overwrite or misclassify another's — was fixed three separate times in 48 hours (2026-08-03–05: `screener_master`, `screener_reliability`, `screener_performance_v2`, each its own migration to a composite `(source, id)` key) before this rule was written down. Before adding a new table that stores any screener/scanner/deal/rating id from an external source, ask: does more than one provider issue this kind of id independently? If yes, the PK is `(source, provider_id)`, not `provider_id` alone — don't wait for a fourth occurrence to discover this.

## Freshness-check mandate

- **Every new live datasource (a fetcher that writes to its own table from an external API) must also get a freshness check in `src/server/dataQualityChecks.ts`.** This is not optional, for the same reason the `live_datasource`-test mandate above isn't: on 2026-08-03, a full sweep of every `runPython()` call site found the file covered only ~25 of the platform's ~140 DB-writing fetchers — most had zero monitoring, and one (`mf_sector_allocation`, `mf_sector_flow_fetcher.py`'s own target table) turned out to be completely empty, indistinguishable from healthy in every existing dashboard. Adding a check is a **one-line config addition**, not a hand-rolled block — push a `{ id, label, category, critical, table, dateColumn, ... }` entry onto the `TABLE_FRESHNESS_CHECKS` array (see the factory + its doc comment in `dataQualityChecks.ts`) and `makeFreshnessCheck()` generates the SQL + evaluate() logic. Use `tradingDayAware: true` (the default) for anything that only updates on NSE trading days — weekends must not false-positive a Monday-morning check (see the same file's `tradingDaysStale()`); set it `false` only for genuinely 24/7-cadence tables (e.g. `confluence_signals`, refreshed every 30 min year-round). Omit `failDays` for a "sparse by nature" datasource (insider filings, IPOs, bulk deals) so it only ever warns, matching `insider-trades-recency`'s existing style — a hand-rolled bespoke check is still fine for anything needing custom logic beyond simple freshness (coverage %, enum/range validation, plausibility bounds), the factory is only for "is this table still getting fresh rows." Only a hand-rolled `evaluate()` (not the factory) is needed for a genuinely internal/derived table (model registries, RL Q-tables, weight-history bookkeeping) — those are ML state, not datasources, and don't belong in this mandate.
