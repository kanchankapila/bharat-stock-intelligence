# URL Data Exploration Tool — Design

**Date:** 2026-06-23
**Status:** Approved (design), pending implementation plan
**Author:** session work on `prod-readiness-phase1`

## Problem

The platform pulls from many ad-hoc third-party endpoints (MoneyControl, Trendlyne/Kayal,
NiftyTrader, Yahoo…). New candidate endpoints are discovered constantly. Today there is no
systematic way to:

1. Take a flat list of example URLs and collapse the near-duplicates (same endpoint, only a
   ticker / date / id / page differs).
2. Fetch each unique endpoint, see the actual payload, and record what parameters it takes.
3. Judge whether the returned fields are worth wiring into the model — by data coverage and by
   correlation with returns.

`urls.txt` already exists at repo root (1053 URLs today, all the Kayal
`all-in-one-screener-data-get` endpoint differing only by `screenpk`). The tool must generalize
to any source the user pastes in.

## Goals

- Edit `urls.txt` (one URL per line) → run one command → get a catalog + raw data + a usefulness report.
- Group URLs into **endpoint templates**; a URL is "the same" as another if it differs only in
  parameter values (path or query). Identify which parameters vary and infer their type.
- Fetch every concrete URL once per run (politely, rate-limit aware), store raw responses with history.
- Profile every response field (coverage, type, cardinality, range, overlap with our NSE universe,
  change-vs-last-run) and, where a payload is keyed by an NSE ticker, correlate numeric fields
  against returns.
- Re-runnable: each run appends history so manual re-runs serve as the "regular verification".

## Non-Goals (YAGNI for v1)

- No scheduler / cron / BullMQ job. Invocation is a manual CLI run (the user re-runs when `urls.txt`
  changes). Promotion to a scheduled job can come later.
- No web UI. Output is DB rows + a markdown report.
- No auth/login/secret handling for endpoints that require a session. v1 sends a browser-like
  User-Agent + Referer only; endpoints needing real auth are recorded as failures.
- No automatic integration of "useful" endpoints into the live data layer — that stays a human decision.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Lifecycle | **One-time, re-runnable exploration.** No scheduler. |
| Uniqueness | **Hybrid** — structural grouping (host+path-skeleton+param-keys) *plus* entity typing of values. |
| Usefulness check | **Field profiling + target correlation.** |
| Storage | **Catalog + raw history** in Postgres (via `db_compat`). |
| Runtime | **Python** (pandas, requests/curl_cffi, db_compat, stock_ohlcv join). |

## Architecture

A focused package `src/server/url_explorer/`, one responsibility per module:

```
src/server/url_explorer/
  __init__.py
  normalizer.py     # URL -> endpoint template + typed params
  fetcher.py        # hit concrete URLs, throttled + backoff
  store.py          # db_compat writes for the 5 tables
  profiler.py       # JSON -> per-field profile + universe overlap
  correlator.py     # ticker-keyed numeric fields vs returns
  report.py         # render markdown usefulness report
  explore.py        # CLI: orchestrates the pipeline
```

CLI (run from `src/server/`):

```
python -m url_explorer.explore                      # full pipeline on urls.txt
python -m url_explorer.explore --urls path/to.txt   # alternate input file
python -m url_explorer.explore --normalize-only     # group + type params, no fetch
python -m url_explorer.explore --no-correlate       # skip correlation step
python -m url_explorer.explore --max-per-endpoint 50 # cap fetches per template (sampling)
```

### normalizer.py

- Parse each URL with `urllib.parse`: scheme, host, path segments, query dict.
- **Path skeleton:** replace segments that vary across the file (or look like an id/ticker/date)
  with a typed placeholder, e.g. `/web-widget/qvt-widget/{int_id}/{ticker}/`.
- **Endpoint template key:** `host + path_skeleton + sorted(query_keys)`. All URLs sharing this key
  are one endpoint. (1053 Kayal URLs → 1 template; `screenpk` is the only variable.)
- **Variable vs constant param:** a param (path segment or query key) is *variable* if its value
  differs across URLs of the same template; otherwise it is a constant captured in the template.
- **Entity typing** of each variable value (first match wins):
  - `ticker` — value ∈ NSE symbol set (`nse_stocks.symbol`) or `mcsymbol`/`tlid` lookups.
  - `date` — matches `YYYY-MM-DD` (and a couple common variants).
  - `epoch` — 10-digit int within a plausible unix-seconds range.
  - `int_id` — all digits, not epoch.
  - `enum` — small fixed set of repeated non-numeric strings.
  - `string` — fallback.
- Output: list of `EndpointTemplate` objects, each with its concrete URLs and a param catalog.

### fetcher.py

- One concrete GET per URL, `curl_cffi` (chrome impersonation) with `requests` fallback — same
  pattern as `intraday_fetcher.py`.
- **Per-host politeness:** serial within a host with jittered delay (default 300ms ±) and exponential
  backoff on 403/405/429/5xx; a per-host circuit breaker after N consecutive failures (Trendlyne 405,
  MC 503 are expected). Distinct hosts may run concurrently (small pool).
- `--max-per-endpoint` caps how many concrete URLs of one template are actually fetched (sampling for
  huge lists like the 1053 Kayal URLs) — the rest are catalogued but not hit.
- Returns `FetchResult(url, status, latency_ms, ok, body, content_type, error)`.

### store.py

`db_compat`-based upserts/inserts. Schema (Postgres types; SQLite-compatible via translator):

- **`url_endpoints`** — `id`, `template` (unique), `host`, `path_skeleton`, `param_keys` (json),
  `method`, `n_urls`, `last_run_at`, `last_status`.
- **`url_params`** — `id`, `endpoint_id` (fk), `name`, `location` (`path`|`query`), `inferred_type`,
  `is_variable` (bool), `distinct_count`, `sample_values` (json). Unique on `(endpoint_id, location, name)`.
- **`url_fetches`** — `id`, `endpoint_id`, `concrete_url`, `params_json`, `fetched_at`, `http_status`,
  `latency_ms`, `ok` (bool), `response_bytes`, `raw_json` (jsonb/text), `error`.
- **`url_fields`** — `id`, `endpoint_id`, `run_at`, `field_path`, `dtype`, `fill_rate`, `cardinality`,
  `num_min`, `num_max`, `num_mean`, `universe_overlap_pct`, `changed_vs_last` (bool).
- **`url_field_correlations`** — `id`, `endpoint_id`, `run_at`, `field_path`, `target`, `n`, `pearson`,
  `spearman`, `ic`.

Indexes: `url_fetches(endpoint_id, fetched_at)`, `url_fields(endpoint_id, run_at)`,
`url_field_correlations(endpoint_id, run_at)`.

### profiler.py

- Flatten each JSON response to leaf paths (`a.b[].c` → `a.b.c`, lists fanned out into rows).
- Group leaf values across all fetched responses of an endpoint.
- Per `field_path`: `dtype` (numeric/string/bool/null), `fill_rate` (% non-null), `cardinality`,
  numeric min/max/mean, **`universe_overlap_pct`** (for string fields: % of distinct values that map to
  an NSE symbol — reveals ticker-keyed payloads), `changed_vs_last` (vs previous run's `url_fields`).
- HTML / non-JSON responses: recorded with `dtype='html'`, no field expansion (v1).

### correlator.py

- Applies only to endpoints whose rows can be keyed by an NSE ticker (detected via
  `universe_overlap_pct` on some string field above a threshold).
- Build a cross-section: `ticker → numeric field value` from the latest fetch.
- Targets from `stock_ohlcv`: `trailing_ret_{5,20}d` (computable now) and `fwd_ret_{5,20}d`
  (real only once a prior run's snapshot has aged; on first run forward targets may be null/NA).
- Compute Pearson, Spearman, and IC (rank corr of field vs forward return) with sample size `n`.
- **Caveat (documented):** single-snapshot correlation against trailing returns is descriptive, not
  predictive; forward-return correlation becomes meaningful only as run history accumulates.

### report.py

- Markdown to `docs/url_explorer/report-<YYYY-MM-DD>.md`:
  - Endpoint summary table: template, #urls, fetch success rate, #fields, ticker-keyed?.
  - Per endpoint: top fields by fill-rate + universe overlap; correlation leaderboard.
  - "Likely useful" flag = good coverage AND (ticker-keyed with non-trivial |correlation|).

## Data flow

```
urls.txt
  -> normalizer  -> EndpointTemplates (+ typed param catalog)
  -> store        (url_endpoints, url_params)
  -> fetcher      -> FetchResults (throttled, sampled)
  -> store        (url_fetches, raw history)
  -> profiler     -> field profiles -> store (url_fields)
  -> correlator   -> correlations  -> store (url_field_correlations)
  -> report       -> docs/url_explorer/report-<date>.md
```

## Error handling

- Per-URL failures are isolated: recorded in `url_fetches` with `ok=false` + `error`; the run continues.
- Per-host circuit breaker prevents hammering a throttling host (mirrors existing Trendlyne/YF logic).
- Malformed JSON → stored raw with `ok=true, dtype='html'/'text'`; profiler skips field expansion.
- Correlation with `n < min_n` (default 20) is skipped, not written.
- The pipeline is idempotent at the catalog level (upsert endpoints/params) and append-only for
  fetches/fields/correlations (history).

## Testing

- **normalizer** (no network): the 1053-URL Kayal file → 1 endpoint with `screenpk` variable int-id;
  REST path id case `…/qvt-widget/533/HDFCBANK/` → `{int_id}`/`{ticker}`; mixed MoneyControl list →
  correct template count + param types.
- **profiler** (fixtures): flatten nested JSON + list fan-out; `universe_overlap_pct` math; numeric
  stats; `changed_vs_last` toggling.
- **correlator** (fixtures): known field/return arrays → expected Pearson/Spearman/IC; `n<min_n` skip.
- **fetcher / store / correlator-on-DB**: smoke-tested on a tiny live slice (a handful of URLs), not in
  the unit suite.

## Open considerations (acceptable for v1)

- Pagination (`pageNumber`) is treated as a normal variable param; v1 does not auto-walk all pages
  beyond what is listed in `urls.txt`.
- `raw_json` history can grow; v1 stores in Postgres. If size becomes an issue, a later change can move
  bodies to disk (the `store` boundary isolates this).
