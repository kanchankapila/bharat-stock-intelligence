---
name: onboard-data-source
description: Given one URL or a batch of URLs (an API endpoint description, a list, a captured-requests file), fetch each, explore and understand the real response shape, resolve the correct NSE ticker for every row, build a fetcher that follows this repo's conventions, wire in the mandatory test + freshness check, and assess honestly whether it's worth anything to ML. Use when asked to "add this as a data source", "integrate this URL/API", "onboard this endpoint", "onboard these URLs", or given one or more raw URLs and asked what they're good for.
---

# Onboard one or more new data sources

Read `.claude/rules/data-sources.md` and `.claude/rules/recurring-bugs.md` in full before
starting — this skill is the procedural walkthrough of those two files applied to each new
URL, not a replacement for them. If a URL turns out to be a screener/scanner/ratings feed,
also skim `.claude/rules/scoring-authority.md`. Before claiming any ML benefit, read
`.claude/rules/measurement.md` — most of what looks like a promising new feature on this
platform has already been tested and killed; check its "Already tested" and "Not testable"
tables before writing a single word about ML value.

Work through Phase 0, then Phases 1-8 per URL, in order. Do not skip to "build the fetcher"
before Phase 1-3 are actually done against the real endpoint — a fetcher built from an
assumed response shape is exactly the class of bug `data-sources.md`'s mandate exists to
catch (the 2026-07-23 incident: a blind "column 0" fallback silently wrote a scrape URL into
a `symbol` column for its entire life because nothing had ever actually looked at the real
response).

## Phase 0 — Intake the batch

One URL and twenty URLs go through the same phases below — this phase is what keeps twenty
of them from turning into twenty disconnected, redundant passes.

1. **Enumerate the real list.** URLs may arrive as a plain list, a captured-requests JSON
   (the `*-post-requests.json` shape already used for `et_marketstats`/`etnow`), or a
   description to search for. Turn whatever you're given into an explicit list before doing
   anything else — don't discover URL #6 mid-way through building the fetcher for #1-5.
2. **Dedupe against what's already onboarded**, per-URL, before spending time on any of
   them: `grep` the domain across `src/server/*.ts`/`*.py` and `dataQualityChecks.ts`. A URL
   whose domain is already fetched elsewhere may just be one more endpoint on an existing
   fetcher file (add a function there, per Phase 4/5) rather than a new source needing its
   own resolution/table/test/check from scratch.
3. **Group by provider (same host + auth/session shape), not by URL.** Everything below —
   ticker resolution (Phase 3), which fetcher file it belongs in (Phase 4/5) — is usually a
   PROVIDER-level decision, not a per-endpoint one. Ten endpoints on the same host with the
   same session/cookie handling and the same symbol-id scheme should resolve once and share
   one fetcher file with multiple fetch functions (`mcApiService.ts`'s 20+ `fetchMc*`
   functions in one file is the existing pattern for this shape) — not ten independent
   passes that each rebuild resolution from scratch.
4. **Track the batch with `TodoWrite`**: one item per URL (or per URL-group where several
   share a provider), plus one closing item for the consolidated summary (end of this file).
   Mark items in progress/complete as you go so a long batch survives a context handoff.
5. **This skill does not itself parallelize across subagents.** If the batch is large enough
   that you want independent URLs explored concurrently, that's the user's call to make
   explicitly (e.g. "use a workflow for this batch") — don't reach for multi-agent
   orchestration on your own initiative just because the list is long. Default to working
   through the list yourself, one URL/group at a time, exactly as below.

## Phase 1 — Fetch it for real, don't assume

Hit the URL with a real HTTP call (`curl`, `requests.get`, or `fetch` — whatever's fastest to
iterate with; this doesn't need to be the final fetcher's code yet). If it's a POST/GraphQL
endpoint, capture the exact request shape (headers, body, query params) — copy them from
wherever the user got the URL (a captured browser request, an existing `*-post-requests.json`
file in the repo root, API docs), never guess at required headers. Print the FULL raw
response, not a truncated summary — you need to see genuine edge cases (nulls, empty arrays,
HTML-instead-of-JSON error pages) before deciding how to parse it.

If the first call fails (403/429/timeout), that's data too: note it. Many providers on this
platform need a warmed-up session/cookie first (see `_nse_session()` in
`index_membership_fetcher.py` for the pattern), a specific `Referer`/`User-Agent`, or are
simply geo/IP-blocked from this environment — confirm which before concluding the source is
broken (`curl` a known-good comparison domain first if reachability itself is in doubt).

## Phase 2 — Understand what's actually in it

For every field in the response:
- What does it mean? (price, ratio, sentiment label, date, count, free text, an internal ID)
- What's its real type as observed, not as named — a field called `count` that's sometimes
  the string `"null"` or blank is not an integer column.
- Is it per-stock, per-index, per-sector, or market-wide (one value for every row)? A
  market-wide field has zero cross-sectional variance and is a category error as a
  stock-selection factor (`measurement.md` already found this for `macro_asset_prices`-style
  data mixed into a per-stock panel — don't re-derive that mistake).
- Does a value repeat verbatim across an unrelated field (the `stock_delivery_data.trades`
  bug: a whole column was silently fed a duplicate of `delivery_qty`)? Cross-check a couple of
  real rows by eye, don't assume the field names are honest.

Write down, in one or two sentences, what this dataset genuinely is — "daily per-stock
analyst consensus" is a specific claim you can check against `data-sources.md`'s categories;
"some stock data" is not specific enough to make any decision from.

## Phase 3 — Resolve the ticker, following the mandated order

**Do this once per provider, not once per URL.** If Phase 0 grouped several URLs under one
host/session, the second and later URLs in that group almost always reuse the exact same
resolver you're about to build for the first — check that before writing a second
`scIdCache`/autocomplete-cache for what's actually the same provider ID scheme.

Never construct a provider ID by convention, and never guess. Resolution order, exactly as
`data-sources.md` mandates:

1. **`src/data/stocklist.ts` first.** Call/inspect `getStockMapping(nseTicker)` — if the
   provider is already onboarded (check the `StockMapping` fields: `mcsymbol`, `tlid`/
   `tlname`, `companyid`, `stockid`, `isin`), you may already have everything you need with
   zero new resolution code.
2. **Provider's own search/autocomplete API second**, if the response doesn't already carry
   an NSE-resolvable field and the stock isn't in the 180-stock list — cache results the
   `scIdCache` way (`Map<string, string>` keyed on uppercase NSE symbol), matching
   `resolveMoneycontrolSymbol`'s pattern in `stockMapping.ts`.
3. **ISIN as fallback**, universally available via `StockMapping.isin` for all 180 stocks, if
   the provider accepts it.
4. Only if the provider has a genuinely new opaque ID with no derivation path: add a field to
   `StockMapping` (`stocklist.ts`) and populate it for the 180 stocks before writing any
   fetch logic — see that file's own layout for the pattern.

**Actually measure the resolution success rate** against a real batch of rows from Phase 1,
don't assume 100%. Log (don't silently drop) anything that fails to resolve — a fetcher that
quietly discards 20% of rows because they didn't match is `mf_holdings_fetcher.py`'s and
`trendlyne_screener_discovery.py`'s failure mode, not a one-off.

**If the response is a screener/scanner and every row already carries a provider-issued
scan/screener id**: that id needs the provider in the primary key — `(source, provider_id)`,
never a bare provider integer alone. Confirmed collisions across MoneyControl/Trendlyne/
ETnow/et_marketstats id ranges have happened three times already; don't wait for a fourth.

## Phase 4 — Decide where this lives

For a batch, decide this per PROVIDER-GROUP first (one fetcher file, one table family), then
check whether any individual URL in the group is different enough (a genuinely different data
category — e.g. the same host serving both a fundamentals endpoint and a news endpoint) to
need its own table/file despite sharing a resolver.

Categorize the dataset against the platform's existing taxonomy before writing anything:
fundamentals, technical, screener/scanner, macro/index-level, news/sentiment, ownership/
institutional, corporate actions. This decides:
- **Python `*_fetcher.py` vs. a TS service file** — Python is this platform's default for new
  fetchers (68 of them under `src/server/`); TS is used where the data feeds directly into an
  existing TS service (screener sync families, live price/news paths). When in doubt, match
  whatever sibling data source is closest in shape (e.g. another per-stock daily fundamentals
  feed → follow `historical_fundamentals`'s writer, not a screener writer).
- **Which existing table it extends vs. a genuinely new table.** Check `information_schema.
  columns` for anything that looks like a plausible existing home before creating a new
  table — a fifth signal table or a duplicate of an existing metrics table (`mc_general_
  metrics` already exists as a generic symbol/source_api/metric_group/metric_name landing
  spot for exactly this "many small numeric facts per stock" shape) is worse than reusing one.
- **If it's a screener/scanner**: read `.claude/rules/scoring-authority.md` before deciding it
  should feed `unified_ranker.py` directly — the canonical ranker's screener membership path
  (`_get_screener_membership()`) already has a defined shape (`screener_catalog`'s
  `(screener_id, source)`, `signal_bias`/`category` taxonomy matching `CAT_BASE_WT`'s keys —
  see the live 2026-08-13 bug where a coarser category vocabulary silently zeroed a whole
  provider's scoring weight) — bolt onto that shape, don't invent a sixth screener source
  table.

## Phase 5 — Build the fetcher

Structure: one function that does the real HTTP call and returns parsed data (the "own
parsing function" every test and every future audit will call directly — never let this logic
exist only inline inside a bigger orchestration function), and a separate function that writes
parsed rows to the DB (the "own DB-write function"). Keep them separate even if only one
caller exists today — this is exactly what makes Phase 6's test possible without a hand-rolled
reimplementation.

Checklist, pulled from `.claude/rules/recurring-bugs.md` — grep that file's signatures before
writing a line, then again before calling this done:
- Date anchors: never `date.today()`/`datetime.now()` as an exact-match write target or a
  `CASE WHEN date >= x` guard boundary. Use `as_of.logical_trading_date()` /
  `trading_days_back()` (Python) or the equivalent trading-day-aware helper.
- NaN handling: `math.isfinite`, never `float(x or 0)` on a value that could be NaN (NaN is
  truthy). Skip rather than coerce to 0.
- SQL dialect: `?` placeholders through `db_compat`/`sqlTranslate` (never raw `%s` in a
  Postgres branch), single-token casts (`::float8` not `::double precision`), no
  Postgres-only functions (`STDDEV`, `DISTINCT ON`, `ANY(ARRAY[])`) if this needs to survive
  the SQLite dev fallback.
- Write amplification: if the provider has no since-parameter, upsert only rows that actually
  changed (`MAX(date)` per key first) rather than re-writing a whole history every run — the
  marketsmojo incident was a 721:1 write ratio that silently looked like millions of healthy
  writes.
- If this is a periodic full-table recomputation, purge rows the current run didn't produce —
  don't just upsert (a newly-excluded row's stale value stays visible to every reader
  otherwise).
- A job whose skip path (market closed, no new data) returns through the same handler as a
  real success will erase that day's genuine failures — return a distinguishable `{skipped:
  true}` and make the success handler decline it.

## Phase 6 — Mandatory live_datasource test

Every fetcher gets exactly one test marked so it can be found and run on demand, and skipped
in CI (no guaranteed third-party network access, and a transient upstream outage must never
fail the build):

**Python** — `@pytest.mark.live_datasource` (see `src/server/tests/conftest.py`), using the
shared assertions in `src/server/tests/live_datasource_helpers.py`
(`assert_non_empty_response`, `assert_looks_like_ticker`, `assert_numeric_and_finite`,
`assert_stored_row_ml_usable`) — two fully worked examples:
`test_live_datasource_trendlyne_screener.py`, `test_live_datasource_et_stats.py`. The test
must: hit the real endpoint for one real ticker/screener resolved via the fetcher's own
helpers (never a hardcoded id that can go stale silently); parse with the fetcher's own
parsing function; assert non-empty and correctly shaped; if it writes to the DB, write through
the fetcher's own DB-write function and read the row back, asserting identifier columns look
like real identifiers and numeric columns are real finite numbers.

**TypeScript** — same `RUN_LIVE_DATASOURCE_TESTS` env var (one switch for both languages, see
`mcapiProxy.test.ts`), `describe.runIf(RUN_LIVE)(...)`. **Do not put a static top-level
`import 'dotenv/config'`** in the test file — that loads real credentials into the shared
vitest worker process on every run, polluting unrelated tests, even when this suite itself is
skipped (broke `niftytraderAuthService.test.ts`'s "no credentials" case live, 2026-08-13).
Instead:
```ts
const RUN_LIVE = process.env.RUN_LIVE_DATASOURCE_TESTS === '1';
if (RUN_LIVE) await import('dotenv/config');
const { yourFetchFn, yourWriteFn } = await import('../yourFetcher');
```
No cleanup/afterEach needed if the fetcher writes genuine, correct production-shaped data (the
common case — running the real fetcher for one real symbol IS what the production job would
do). Only add scoped delete/cleanup if the write path is destructive on data outside the
test's own scope (e.g. a sync that reconciles "exited" rows by diffing against a full-catalog
fetch — in that case, call the lower-level fetch+parse directly and skip the destructive
reconcile step in the test rather than risk deleting real rows a fuller sync legitimately
wrote).

Run it for real before considering this phase done:
```bash
RUN_LIVE_DATASOURCE_TESTS=1 npx vitest run <path>          # TS
RUN_LIVE_DATASOURCE_TESTS=1 python -m pytest <path> -v     # Python
```
A test you didn't run is not a test that passed.

## Phase 7 — Mandatory freshness check

One line in `src/server/dataQualityChecks.ts`'s `TABLE_FRESHNESS_CHECKS` array via
`makeFreshnessCheck()` — read that function's own doc comment first. Needs: `id`, `label`,
`category`, `critical`, `table`, `dateColumn`. Set `nativeDateColumn: true` only if
`information_schema.columns` shows a real `DATE`/`TIMESTAMPTZ` type (check, don't assume —
most date columns in this codebase are TEXT). `tradingDayAware` defaults to `true`
(subtracts weekends); set it `false` only for a genuinely 24/7-cadence source (news, GDELT-
style). Calibrate `warnDays`/`failDays` to the SOURCE's real cadence, not a copy-pasted
default — a weekly sync needs ~10/16 days, not 3/5, or it false-warns every single week
between syncs (confirmed live 2026-08-13 for a fundamentals sync entry).

If the write target is a specific COLUMN on an existing, already-monitored table (not a new
table) — e.g. two flag columns on `nse_stocks` — the same factory still applies, keyed on that
column's own dedicated timestamp, not the whole table.

A hand-rolled check (not the factory) is only justified for logic beyond "is this table still
getting fresh rows" — coverage %, enum/range validation, a promotion-gate that needs the
LATEST of {output-table probe, stored `_ran_at`, `job_heartbeat.last_success_at}` rather than
the output table alone (a correctly-rejecting gated job must not read as "stale").

## Phase 8 — Assess ML value honestly

This is the step most likely to be rushed into hype — don't. Before writing anything about
"this would help ML":

1. **Check `.claude/rules/measurement.md`'s "Already tested" and "Not testable" tables first.**
   If this dataset is a different vendor's version of something already measured (another
   analyst-consensus feed, another technical-indicator source, another screener provider),
   the prior verdict very likely still applies — state that explicitly rather than re-pitching
   it as new. The one exception worth a fresh look: a genuinely different construction (a new
   horizon, a new universe, a materially different underlying methodology) — say precisely
   what's different, per that file's own bar for re-testing.
2. **Name the exact feature this would become**, in the platform's existing vocabulary: a new
   `CAT_BASE_WT` category weight in `unified_ranker.py`? A new column candidate for
   `feature_store`/`ml_ensemble.py`? A macro factor in `factor_backtest.py`
   (`macro_asset_prices`-shaped, market-wide, not cross-sectional — these need a different
   test than a per-stock factor)? Say which, concretely — "might be useful for ML" without
   naming the wiring point is not an assessment.
3. **State the calendar constraint up front.** A brand-new fetcher starts with ~1 date of
   history. Most factor conclusions on this platform need 60+ monthly rebalances / a year+ of
   dense per-symbol coverage to mean anything (`measurement.md`'s panel spec) — that's not
   available on day one no matter how good the hypothesis is. Say explicitly: "not testable
   for N months," not "should help."
4. **Do not wire this into `unified_ranker.py`, `scoring_engine.py`, `factor_backtest.py`,
   `multi_factor_scorer.py`, `institutional_quant_engine.py`, or `quantScoringService.ts`
   without a `factor_backtest.py` run (or a same-session `measurement.md`/
   `measurement-history.md` edit) as evidence** — `verify-gate.mjs` blocks exactly this, and
   for good reason: three separate scoring changes on this platform shipped with a green test
   suite and no backtest, and all three were later reviewed and rejected. A green test proves
   the code runs, not that the feature is worth anything.
5. If you genuinely can't test it yet (insufficient history), say so and stop there — do not
   speculate a Sharpe ratio or a win rate for a factor that has never been measured. That
   exact failure mode (a fabricated-looking backtest for a feature that was never real) has
   happened on this platform before and is now explicitly called out in
   `recurring-bugs.md`.

## Batch summary (multiple URLs)

Once every URL/group in the Phase 0 list has been through Phases 1-8, close the batch with
one consolidated table, not N disconnected write-ups — this is what makes a 15-URL batch
actually reviewable:

| URL / provider-group | What it is (Phase 2) | Resolved via | Match rate | Fetcher | Table | Test run? | Freshness check? | ML verdict (Phase 8) |
|---|---|---|---|---|---|---|---|---|

Fill one row per URL (or one row per shared table if a provider-group landed in one table).
Call out explicitly, don't bury in the table:
- Any URL that turned out to be a duplicate of an existing source (Phase 0 dedupe) — skipped,
  and why.
- Any URL with a resolution match rate below ~95% — state the real number, don't round up.
- Any URL rejected outright (dead endpoint, subscription-gated, genuinely unusable) — this is
  a legitimate outcome, report it as plainly as a successful onboarding.
- The overall run: same commands as below, run ONCE at the end across everything touched,
  not once per URL.

## Definition of done

```bash
npx tsc --noEmit                                            # any .ts change
npx vitest run                                               # any .ts logic change
python -m pytest src/server/__tests__/ src/server/tests/ -q  # any .py change
```
Plus the live_datasource test actually run once per fetcher (Phase 6), the freshness check
present for every new table/column (Phase 7), and — only for a URL you're proposing feed the
ranker/scoring, not just land in its own table — the Phase 8 backtest evidence. Close the loop
the same way every session on this repo is expected to: append what changed to
`docs/session-log.md` (the batch summary table above is a good starting point for that entry),
and if you hit a bug class not already in `recurring-bugs.md`, add its signature there so the
next session doesn't rediscover it.
