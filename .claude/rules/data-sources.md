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

- **`src/data/stocklist.ts`** — authoritative mapping table, **2,000 stocks** (~85% of `nseStocks.ts`'s 2,366-name NSE master); holds all provider fields, populated 89-100% depending on the field (`tlid`/`tlname` 100%, `isin` 99%, `mcsymbol`/`companyid` 98%, `stockid` 91%, `tickertape_sid` 90%, `scripcode` 89%). Always preferred.
- **`src/data/nseStocks.ts`** — master list of 2000+ NSE stocks; NSE symbol + basic info only, no provider mappings.
- **`src/server/stockMapping.ts`** — lookup functions; `stocklist.ts` takes precedence over `nseStocks.ts`.

### Resolution Order (for any new provider)

1. **`stocklist.ts` first** — call `getStockMapping(nseTicker)` to get the full `StockMapping` object and read the provider's field directly.
2. **Provider autocomplete API second** — if the stock is not in `stocklist.ts`, or its row has an empty value for the field you need, call the provider's search/autocomplete endpoint with the NSE symbol and cache the result in the `scIdCache` pattern already used for MoneyControl (`stockMapping.ts:35`). This is now the exception (~366 NSE names are absent, plus the per-field gaps above), not the common path it was at 180.
3. **ISIN as fallback** — if the provider accepts ISIN, `StockMapping.isin` carries one for **1,980 of the 2,000** rows (99%). Near-universal, but check the value is non-empty rather than assuming it.
4. **Never guess** — do not construct provider IDs by convention. Each provider's ID scheme is opaque and must be resolved explicitly.

### Adding a New Provider

When integrating a new data source (new URL, new API endpoint):

1. **Identify the provider's ID type** — look at its API docs/response to find what it uses to identify a stock (symbol, ISIN, internal ID, slug).
2. **Add a field to `StockMapping`** in `src/data/stocklist.ts` if the provider has its own opaque ID not derivable from existing fields.
3. **Populate mappings in `stocklist.ts`** before writing any fetch logic. It is 2,000 rows, so backfilling a new provider field across all of them is a scripted job, not a hand edit — and partial coverage is normal (see the per-field percentages above), so the fetcher must handle an empty value rather than assume every row resolves.
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
`@pytest.mark.live_datasource` (see `src/server/conftest.py` — moved up from `tests/` on 2026-08-17, `src/server/tests/live_datasource_helpers.py`,
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

**This applies to TypeScript tests too, under the same env var** — not just pytest. Any
`*.test.ts` that calls the real network must be gated:

```ts
const RUN_LIVE = process.env.RUN_LIVE_DATASOURCE_TESTS === '1';
describe.runIf(RUN_LIVE)('… [live]', () => { … });
```

One switch runs every live check in the repo, in both languages. This is not hypothetical:
`mcapiProxy.test.ts` (28 cases proxying to MoneyControl's real API) was ungated and failed
`npm test` and CI on 2026-08-11 when `/mcapi/v1/premarket/get-global-marketdata` began
returning 400/422 upstream, with nothing in this repo changed. **A suite that fails on someone
else's outage stops being a signal** — the pressure becomes to ignore red CI rather than fix it.

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

- **The same class extends beyond provider-issued IDs to any table keyed on a natural key (not an opaque id) that two providers can independently produce a row for.** `index_max_pain`'s PK was `(index_name, date, expiry)` — a real, meaningful key with no opaque id at all — but both `mc_index_oi_fetcher.py` and `nt_oi_snapshot_fetcher.py` independently derive `max_pain`/`pcr_oi` for NIFTY50/NIFTYBANK from their own OI data and upsert onto that same key, so whichever ran later in the day silently overwrote the other's numbers. Found in the 2026-08-14 12-audit sweep, fixed 2026-08-15 (migration `1787010000000`, widened to `(source, index_name, date, expiry)`, existing rows backfilled deterministically from `fetched_at`'s format — MC's ends `Z`, NT's doesn't). Live-verified: both providers' rows now coexist for the identical `(NIFTY50, date, expiry)` with different `pcr_oi` values. The tell is the same as the opaque-id case: ask "can more than one fetcher independently write a row for this exact key?", not just "does this column look like a provider-issued id?"

## Freshness-check mandate

- **Every new live datasource (a fetcher that writes to its own table from an external API) must also get a freshness check in `src/server/dataQualityChecks.ts`.** This is not optional, for the same reason the `live_datasource`-test mandate above isn't: on 2026-08-03, a full sweep of every `runPython()` call site found the file covered only ~25 of the platform's ~140 DB-writing fetchers — most had zero monitoring, and one (`mf_sector_allocation`, `mf_sector_flow_fetcher.py`'s own target table) turned out to be completely empty, indistinguishable from healthy in every existing dashboard. Adding a check is a **one-line config addition**, not a hand-rolled block — push a `{ id, label, category, critical, table, dateColumn, ... }` entry onto the `TABLE_FRESHNESS_CHECKS` array (see the factory + its doc comment in `dataQualityChecks.ts`) and `makeFreshnessCheck()` generates the SQL + evaluate() logic. Use `tradingDayAware: true` (the default) for anything that only updates on NSE trading days — weekends must not false-positive a Monday-morning check (see the same file's `tradingDaysStale()`); set it `false` only for genuinely 24/7-cadence tables (e.g. `confluence_signals`, refreshed every 30 min year-round). Omit `failDays` for a "sparse by nature" datasource (insider filings, IPOs, bulk deals) so it only ever warns, matching `insider-trades-recency`'s existing style — a hand-rolled bespoke check is still fine for anything needing custom logic beyond simple freshness (coverage %, enum/range validation, plausibility bounds), the factory is only for "is this table still getting fresh rows." Only a hand-rolled `evaluate()` (not the factory) is needed for a genuinely internal/derived table (model registries, RL Q-tables, weight-history bookkeeping) — those are ML state, not datasources, and don't belong in this mandate.

## Vendor-onboarding freeze (added 2026-08-30)

**Before onboarding a new vendor/provider, first check whether the existing feature backlog is
graded.** `ml_ensemble.py`'s own training matrix had **116 of 421 features (28%) with no measured
cross-sectional signal as of 2026-08-21** (`ml_label_and_promotion_gate_2026_08_21` memory) — that
count is now 2+ weeks old and has not been re-run since; treat it as directional evidence that the
backlog is large, not as today's exact figure, and re-run the same constants-sweep methodology
before using the specific number 116/421 to block a decision. The policy below doesn't depend on
the exact count staying current — a large ungraded backlog either way is reason enough to check it
first. Each new vendor adds
more raw columns into `build_features()`/`feature_store` that are, by default, untested and
correlated with what's already there (most published factors on this platform's data are
negative or null — see `measurement.md`'s "Already tested" table, 14/23 Bonferroni-significant
`feature_store` factors are ALL inverted vs. their literature sign). A new vendor is not evidence
of a new edge; it is more untested surface area layered onto a platform whose main measured
finding is that most of what's already there doesn't help.

**Before adding a new vendor/provider integration:**
1. Check `measurement.md`'s "Not testable" and "Already tested" sections — is there a specific,
   named gap this vendor closes (e.g. a factor family with no data source yet), or is it another
   instance of something already tested and rejected under a different vendor's label (screener
   sentiment, technical composites, analyst/ownership snapshots — three separate vendors have
   each contributed one of these, all measuring roughly the same thing)?
2. State the hypothesis being tested BEFORE writing the fetcher — what specific factor/signal
   does this vendor's data let you test that nothing else does. "More data can't hurt" is not a
   hypothesis; per the shared-ceiling finding in `measurement.md`, more *correlated* engines does
   not raise the AUC ceiling (max pairwise Spearman rho across today's 8 engines is only 0.29,
   i.e. they're already fairly independent — a new vendor duplicating an existing factor family
   adds cost and surface area, not diversification).
3. **A new fetcher's own live-datasource test and freshness check (mandated above) are necessary
   but not sufficient.** Once ~20 dates of history exist, the new column(s) must get a
   `factor_edge.py`/`factor_backtest.py` reading before being wired into any production blend
   (`unified_ranker.py`, `cs_ranker.py`, `exit_policy.py`, `ml_ensemble.py`'s `build_features()`)
   at anything above a token starting weight — matching the existing `verify-gate.mjs` backtest-
   evidence requirement for scoring-surface diffs, applied one step earlier, at onboarding time
   rather than after the column has already been silently blended in for months.
4. **A feature/vendor column that stays ungraded (LOW-DATA) or grades no-edge for 6+ months after
   onboarding is a removal candidate**, not permanent scaffolding — re-check the 116-dead-feature
   count periodically (`SELECT count(*) FROM factor_edge_history WHERE ...`) rather than letting
   it only grow. This does not apply to genuinely calendar-blocked data (quarterly fundamentals,
   anything needing 12+ months of history per `measurement.md`'s "Not testable" section) — those
   are blocked by elapsed time, not by being untested on purpose.

This is a discipline rule, not a hard gate — there is no automated enforcement for it (unlike the
freshness-check mandate above). The cost of skipping it is diffuse and slow (a slightly bloated,
slightly-more-correlated feature matrix that nobody prioritizes cleaning up) rather than a single
sharp failure, which is exactly why it needs to be a written rule instead of relying on it being
obviously worth doing in the moment.

## A source that stops returning data: ASK, don't conclude "dead" (added 2026-09-05)

**Whenever a datasource stops returning data — 404, 401/Unauthorized, an empty body, a
restructured response — report it to the user and ask, before concluding it is dead and before
hunting for a replacement yourself.** This is a standing user instruction, not a judgement call,
and it applies to every case rather than only to obviously-broken URLs.

Ask for either an alternative URL **or a captured browser fetch / DevTools network entry** from
the working site. Name the captured-fetch option explicitly — it is the one that actually works.

**Why this is a rule and not a preference.** NiftyTrader had been recorded here as dead for
weeks: `webapi.niftytrader.in` answered every request with
`{"result":0,"resultMessage":"Unauthorized: You are not authorized to access this resource."}`.
That was verified three independent ways on 2026-09-05 — plain `requests`, full browser headers,
and `curl_cffi` Chrome TLS impersonation (the JA3 fix that works for Trendlyne) — plus a check
that the site issues **no cookies at all** and that the API host sends no `Set-Cookie`. The
endpoint also returned a *distinct* `Url not found` for unknown routes, proving the route existed
and was gated. Every one of those measurements was correct, and the conclusion drawn from them
("no client-side change can fix this") was correct too — and completely useless.

The user then pasted a captured `fetch(...)` from their browser. The vendor had simply **moved
the API**: `webapi.niftytrader.in/webapi/*` → `www.niftytrader.in/api/niftytrader/*`. Measured
route by route, 6 dead routes came back immediately — `option/option-chain-data`,
`Symbol/other-stock-spot-data` (INDIA VIX), `symbol/psymbol-list`, `symbol/stock-index-data`,
`symbol/today-spot-data`, `symbol/top-gainers-data` — and they require **no token, no cookie and
no headers at all**. 27 files across `.py` and `.ts` were pointing at a retired host.

**The lesson to generalise:** *"I have proven this endpoint cannot be made to work"* is not the
same as *"this data is unobtainable."* A vendor that moved, versioned, or re-fronted its API is
indistinguishable from one that revoked access, when observed only from outside. The user has a
logged-in browser and its network tab holds the answer; asking costs one message and no tokens.

**Two things that are still yours to do, not the user's:**

1. **Verify a user-supplied alternative route by route, not in aggregate.** Of NiftyTrader's 19
   routes: 6 were fixed by the move, 8 already worked on both hosts (so no regression risk), and
   3 fail on *both* — meaning they are a separate, still-open problem the migration does not
   solve. Reporting "the fix works" without that breakdown would have hidden the remaining 3.
2. **Determine the MINIMUM the new call needs.** Test with headers, then without each one. Here
   the answer was "nothing" — which turned a fix that would have required storing a JWT with a
   3-week expiry into a plain base-URL change with no credential to rotate. Do not store a
   user-supplied cookie/token in the repo before checking whether the endpoint needs it; if it
   genuinely does, it belongs in `.env`, never in code.

Related failure shape, different cause: a vendor that answers but *rations* — see
`trendlyne_waf_request_allowance_2026_08_17` in memory and `so_option_chain_fetcher.py`'s
`resume_order()`. A cumulative request allowance also presents as "this source doesn't work",
but no amount of asking helps there; rotation does.
