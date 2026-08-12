# Build Spec: Stages 0–2 — Foundation, Ingestion Spine, NSE Backfill

**Audience: an AI coding agent executing this build.** This document is a directive, not a
discussion. Every instruction is mandatory unless explicitly marked OPTIONAL. Where a fact is
marked VERIFIED it was confirmed against working code on 2026-08-12 — use it as given and do not
substitute an assumption.

Companions: [GREENFIELD_BUILD_SPEC.md](GREENFIELD_BUILD_SPEC.md) (full target DDL and standards),
[MIGRATION_AND_CUTOVER_PLAN.md](MIGRATION_AND_CUTOVER_PLAN.md) (why this is a fresh build),
[GREENFIELD_STOCK_ANALYSIS_ARCHITECTURE.md](GREENFIELD_STOCK_ANALYSIS_ARCHITECTURE.md) (rationale).

---

## 0. How to execute this document

1. Work in stage order: 0 → 1 → 2. Do not begin a stage until the previous stage's **Acceptance
   Gate** passes mechanically (a command exits 0), not by your own judgment.
2. After each numbered task, run the verification command given for it. If it fails, fix before
   continuing. Do not batch verification to the end.
3. When a fact is not in this document and not verifiable from code you have written, **stop and
   ask**. Do not invent an endpoint, a column name, a date range, or a threshold.
4. Never write a number into a document, log, or test assertion that a program did not compute.
   This repository has a documented history of "verification" scripts that formatted plausible
   output while never connecting to a database. Any script you write that reports a measurement
   must issue a real query, and must be negative-controlled before its results are trusted.
5. Do not skip tests to make progress. A stage is not complete without them.

---

## 1. Mission and invariants

Build the ingestion foundation for an Indian equity research platform: a fresh PostgreSQL database,
a provider-agnostic ingestion spine with immutable raw capture, and a resumable backfill that
rebuilds a survivorship-free daily price and delivery panel from NSE's own archives.

These invariants are binding on every line of code you write.

1. **NSE symbol is the only canonical security identifier.** Provider IDs are explicit mapped rows.
   Never construct, guess, or infer a provider ID by convention.
2. **PostgreSQL only.** No SQLite, no dual-dialect translation layer, no ORM-generated schema.
3. **The migration chain is the only thing that creates schema.** No `CREATE TABLE IF NOT EXISTS`
   at runtime, ever. No ad hoc `ALTER TABLE` from application code.
4. **Raw before parse.** Persist the provider payload and its hash before parsing it. A parser bug
   must be replayable, not a permanent data loss.
5. **Every fact row carries `run_id` and `available_at`.** No exceptions.
6. **HTTP 200 is not success.** Validate content type, size, schema, identity format, and numeric
   finiteness before accepting a row.
7. **A job result is `succeeded | skipped | degraded | failed`.** `skipped` and `degraded` must
   never update a success heartbeat.
8. **Trading dates come only from the calendar module.** No `new Date()` arithmetic, no weekday
   math, no `date.today()` as a write anchor anywhere in the codebase.
9. **Append-only for facts.** `ON CONFLICT DO NOTHING`. Never place a provenance timestamp column
   in an `ON CONFLICT DO UPDATE SET` list.
10. **Reject, don't coerce.** A non-finite or unparseable value is a rejected row with a recorded
    reason, never a zero, never a NULL substituted for a real number.

---

## 2. VERIFIED facts — use exactly as written

### 2.1 NSE endpoints

| Purpose | URL | Notes |
|---|---|---|
| Daily full bhavcopy | `https://archives.nseindia.com/products/content/sec_bhavdata_full_{DDMMYYYY}.csv` | Primary source. Host is `archives.nseindia.com`. |
| Security master | `https://archives.nseindia.com/content/equities/EQUITY_L.csv` | Current listed universe only. |
| Delivery (MTO) | `https://nsearchives.nseindia.com/archives/equities/mto/MTO_{DDMMYYYY}.DAT` | **Not required** — see 2.3. Host differs: `nsearchives`. |
| Index constituents | `https://nsearchives.nseindia.com/content/indices/ind_nifty50list.csv` (also `nifty100`, `nifty200`, `niftymidcap150`, `niftysmallcap250`) | Current membership only, not historical. |

Required headers on every NSE request:

```
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)
Referer:    https://www.nseindia.com/
Accept:     text/csv,*/*
```

### 2.2 Archive horizon — this bounds the entire rebuild

**`sec_bhavdata_full` serves a consistent schema from 2021-01-04 to the present.** VERIFIED.

The newer UDiFF `BhavCopy_NSE_CM_*` files only reach back to approximately 2024-04 and return 404
before that. **Do not use UDiFF.** Use `sec_bhavdata_full` exclusively.

**Consequence you must respect:** the rebuilt panel begins 2021-01-04. Approximately 5.5 years of
history is recoverable with true provenance. Anything earlier is not available from this source and
must not be fabricated, interpolated, or backfilled from a vendor. If a downstream requirement
needs pre-2021 data, stop and escalate.

### 2.3 Bhavcopy file format

The file carries `DELIV_QTY` and `DELIV_PER`, so **delivery data comes free from the official
source**. Do not build a separate MTO fetcher in Stage 2.

Columns, exact names as they appear in the CSV header:

| Column | Type | Maps to |
|---|---|---|
| `SYMBOL` | text | `market_bar.symbol` |
| `SERIES` | text | filter, see below |
| `DATE1` | date, format `%d-%b-%Y` (e.g. `29-Jul-2026`) | `market_bar.session_date` |
| `PREV_CLOSE` | numeric | `market_bar.prev_close` |
| `OPEN_PRICE` | numeric | `market_bar.open` |
| `HIGH_PRICE` | numeric | `market_bar.high` |
| `LOW_PRICE` | numeric | `market_bar.low` |
| `CLOSE_PRICE` | numeric | `market_bar.close` |
| `AVG_PRICE` | numeric | `market_bar.vwap` |
| `TTL_TRD_QNTY` | numeric | `market_bar.volume` |
| `TURNOVER_LACS` | numeric | `market_bar.turnover` (×100000 to rupees) |
| `NO_OF_TRADES` | numeric | `market_bar.trades` |
| `DELIV_QTY` | numeric | `delivery_stat.delivery_qty` |
| `DELIV_PER` | numeric | `delivery_stat.delivery_pct` |

**Critical parsing rules, all VERIFIED against the working implementation:**

- **NSE pads both headers and values with spaces** (`' SERIES'`, `' EQ'`). Strip every key and
  every value before use. A parser that does not strip will match zero columns and silently
  produce empty output.
- Equity series allowlist: `{EQ, BE, BZ, SM, ST}`. `EQ` = rolling settlement, `BE` = trade-to-trade,
  `BZ` = surveillance T2T, `SM`/`ST` = SME. Exclude everything else — `GS` (gilts), `GB` (sovereign
  gold bonds), debentures, and ETF-adjacent series do not belong in an equity cross-section.
- Sentinel values for "missing" are `''`, `'-'`, and `'NA'`. Map these to NULL, never to 0.
- Reject any row where `CLOSE_PRICE` is missing or `<= 0`.
- Reject any row with an empty `SYMBOL` or `SERIES`.

### 2.4 Non-trading days

**A 404 from the bhavcopy URL is the expected, correct response for a weekend or holiday.** It is
not a failure. Do not retry it into a stack trace, do not log it as an error, and do not mark the
run `failed`.

This yields a valuable property you must exploit: **the trading calendar is derived from the
backfill itself.** A date that returns 200 with ≥1 accepted equity row *is* a trading session.
Write `trading_session` rows from this observation rather than importing a holiday list.

### 2.5 Why this source and not a vendor

The bhavcopy is the exchange's own record of what actually traded on a given day. A company that
delisted in 2022 is present in 2022's files and absent from 2023's. Iterating a *current* symbol
master instead — which is what most naive pipelines do — silently pre-selects on "survived to
today" and inflates every backtest run against it. This source is the survivorship-free universe,
and rebuilding from it is the single largest accuracy gain in the project.

---

## 3. Stage 0 — Foundation

### Task 0.1 — Repository scaffold

Create a pnpm workspace monorepo:

```
apps/{web,api,worker}
packages/{contracts,db,market-calendar,provider-sdk,ingestion,observability,testing}
infra/{docker,deploy}
```

TypeScript strict mode across all packages: `strict: true`, `noUncheckedIndexedAccess: true`,
`exactOptionalPropertyTypes: true`. Node 22 LTS or later. ESM modules.

Add an import-boundary lint rule (`eslint-plugin-boundaries` or equivalent) enforcing:

| Package | May import | Must never import |
|---|---|---|
| `apps/api` | `contracts`, `db`, `observability` | `ingestion`, `provider-sdk` |
| `packages/ingestion` | `contracts`, `db`, `provider-sdk`, `market-calendar`, `observability` | `apps/api` |
| everything | — | raw SQL outside `packages/db` |
| everything | — | outbound HTTP outside `packages/provider-sdk` |
| everything | — | trading-date computation outside `packages/market-calendar` |

**Verify:** `pnpm lint` exits 0 and a deliberately added violating import fails it.

### Task 0.2 — Local infrastructure

`infra/docker/docker-compose.yml` providing: PostgreSQL 16, Redis 7, and MinIO (S3-compatible
object storage). Expose configuration through environment variables only — no hardcoded
connection strings anywhere in application code.

**Verify:** `docker compose up -d` then a connectivity check against all three services exits 0.

### Task 0.3 — Migration chain

Install `node-pg-migrate`. Author migrations in this order, one file each, SQL format. Take the
DDL verbatim from [GREENFIELD_BUILD_SPEC.md](GREENFIELD_BUILD_SPEC.md) Part C.

| # | Migration | Creates |
|---|---|---|
| 001 | `enums_and_extensions` | `pg_trgm`, `pgcrypto`, all enum types (C0) |
| 002 | `reference_identity` | `security`, `provider_security_id`, `provider_mapping_gap`, `trading_session`, `index_definition`, `index_membership` (C1) |
| 003 | `provider_registry_and_runs` | `provider`, `provider_endpoint`, `job_definition`, `ingestion_run`, `raw_object` (C2) |
| 004 | `market_facts` | `market_bar`, `delivery_stat`, `index_bar`, `corporate_action`, `price_adjustment` (C3) |
| 005 | `quality_and_audit` | `dq_check`, `dq_result`, `audit_metric` (C8, quality portion only) |

Add one column to `market_bar`, `delivery_stat`, and every fact table, not present in the base DDL:

```sql
provenance_quality text NOT NULL DEFAULT 'recorded'
  CHECK (provenance_quality IN ('recorded','inferred'))
```

Stage 2 writes `recorded`. Reserved for later stages that copy vendor point-in-time data.

Partition `market_bar` by `RANGE (session_date)`, one partition per calendar year, 2021 through
the current year plus one.

**Verify:** migrating up from an empty database succeeds; migrating down and up again succeeds;
a schema dump of the result contains exactly the expected tables and no others.

### Task 0.4 — Test harness

Ephemeral PostgreSQL for integration tests (Testcontainers or a per-run scratch schema). Tests run
production migrations against it — never a hand-maintained test schema.

**Verify:** a trivial integration test creates a `security` row and reads it back.

### Acceptance Gate 0

All of these must pass in one command:

```
pnpm lint && pnpm typecheck && pnpm test && pnpm migrate:up && pnpm schema:verify
```

Additionally confirm by inspection: **zero** occurrences of `CREATE TABLE` outside `migrations/`.

---

## 4. Stage 1 — Ingestion spine

### Task 1.1 — Market calendar

`packages/market-calendar` exporting:

```ts
logicalSession(now: Date): string          // YYYY-MM-DD; post-midnight safe
previousSession(d: string): string
nextSession(d: string): string
sessionsBack(d: string, n: number): string
isSession(d: string): boolean
tradingDaysBetween(a: string, b: string): number
```

Back it by the `trading_session` table. Before Stage 2 populates that table, `isSession` returns
`unknown` rather than guessing — it must not fall back to weekday arithmetic.

**Verify:** unit tests covering a Monday after a Friday holiday, a post-midnight timestamp
resolving to the previous session, and an unknown-date response before population.

### Task 1.2 — Provider SDK

`packages/provider-sdk` exporting a `fetch` wrapper enforcing, per request:

- timeout (default 30s), bounded retry with exponential backoff **and jitter**;
- per-provider rate limit and max concurrency, read from the `provider` table;
- circuit breaker opening after N consecutive failures;
- response size cap;
- **raw capture before parse**: write body to object storage, compute SHA-256, insert `raw_object`;
- secret redaction in all logs.

Retry policy: retry on 5xx, timeouts, and connection resets. **Do not retry 404** — for NSE
archives that is a semantically meaningful "no data for this date" answer (§2.4).

Adapter interface:

```ts
interface ProviderEndpoint<TRaw, TParsed> {
  provider: string;
  endpointKey: string;
  urlTemplate: string;
  headers: Record<string, string>;
  parserVersion: string;
  schema: ZodType<TRaw>;
  parse(raw: string, ctx: ParseContext): ParseResult<TParsed>;
}

type ParseResult<T> = {
  accepted: T[];
  rejected: Array<{ raw: unknown; reason: string }>;
};
```

`parse` must return rejected rows with reasons. It must never throw away a row silently and never
substitute a default value for an invalid one.

**Verify:** contract tests for timeout, 500-then-success retry, 404 no-retry, oversized response,
and circuit-breaker opening.

### Task 1.3 — Job contract and catalog

```ts
type JobResult =
  | { status: 'succeeded'; metrics: JobMetrics }
  | { status: 'skipped';   reason: string; metrics: JobMetrics }
  | { status: 'degraded';  reason: string; metrics: JobMetrics }
  | { status: 'failed';    error: Error;  metrics: JobMetrics };

type JobMetrics = {
  rowsSeen: number; rowsAccepted: number; rowsRejected: number;
  rowsWritten: number; symbolsCovered: number;
  inputWatermark: string | null; outputWatermark: string | null;
};
```

A single declarative job catalog is the only source of schedule truth. Generate BullMQ registration
and monitoring metadata from it. **Do not write a cron string in two places** — a hand-mirrored
schedule registry has caused six separate drift incidents in the predecessor system.

The heartbeat writer must accept only `succeeded`. Enforce this in the writer itself, not in each
job's handler.

**Verify:** a test proving a `skipped` result leaves `last_success_at` unchanged. Negative-control
it: make the writer accept `skipped`, confirm the test fails, then restore.

### Task 1.4 — Run ledger

Every job execution opens an `ingestion_run` row on start and closes it with final status and
metrics. Every fact row written during that execution carries its `run_id`.

Enforce `CHECK (status <> 'skipped' OR skip_reason IS NOT NULL)` — already in the DDL; add a test.

**Verify:** an integration test asserting that a written `market_bar` row's `run_id` resolves to a
closed `ingestion_run` with matching `rows_written`.

### Acceptance Gate 1

A single end-to-end test must demonstrate: request → `raw_object` with a content hash → parsed →
`market_bar` row with `run_id` and `available_at` → `ingestion_run` closed with balanced metrics
(`rowsSeen == rowsAccepted + rowsRejected`).

---

## 5. Stage 2 — NSE backfill

### Task 2.1 — Bhavcopy adapter

Implement `packages/ingestion/src/nse/bhavcopy.ts` per §2.1–§2.3.

The parser is **the single implementation**. Tests must call it. Do not reimplement parsing logic
inside a test — a test with its own parser can pass while the production path is broken.

Required parser behavior:

1. Strip whitespace from every header key and every value before use.
2. Filter `SERIES` to `{EQ, BE, BZ, SM, ST}`.
3. Parse `DATE1` with format `%d-%b-%Y`. A parse failure is a rejected row, not an exception.
4. Map `''`, `'-'`, `'NA'` to NULL.
5. Reject rows with empty `SYMBOL`/`SERIES`, or `CLOSE_PRICE` missing or `<= 0`.
6. Reject any row whose symbol fails `^[A-Z0-9&$-]{1,20}$`.
7. Convert `TURNOVER_LACS` to rupees (×100000) when writing `market_bar.turnover`.
8. Emit both a `market_bar` row and a `delivery_stat` row per accepted input row.

Set `available_at` to the session's close time plus the archive publication lag, computed by the
calendar module. **Do not set it to the fetch time or to `now()`** — that would assert the data was
knowable earlier or later than it was.

**Verify:** contract tests against saved fixture payloads covering — a normal trading day; a
padded-header file; a file containing `GS`/`GB` series that must be excluded; a row with `-` in a
numeric column; a row with `CLOSE_PRICE` of `0`; an HTML error page returned with status 200.

### Task 2.2 — Backfill runner

Implement a resumable runner with this contract:

```
backfill --from 2021-01-04 --to <today> [--concurrency N] [--dry-run]
```

Behavior, all mandatory:

1. **Oldest-first.** Process dates ascending so a partial run always yields a contiguous prefix.
2. **Checkpointed in PostgreSQL**, not Redis and not a local file. A restart resumes from the last
   completed date with no duplicated work and no gap.
3. **Idempotent.** Re-running a completed date is a no-op. Dedupe on `raw_object.content_hash`;
   fact writes use `ON CONFLICT DO NOTHING`.
4. **404 handling.** Record the date as a non-trading day, close the run as `skipped` with a
   reason, and continue. Never `failed`.
5. **Trading-session derivation.** A date returning ≥1 accepted equity row writes a
   `trading_session` row. This populates the calendar as a byproduct.
6. **Rate limited** per the `provider` table. Respect it strictly; this is a public archive and you
   are fetching ~1,400 files.
7. **Per-date run ledger.** One `ingestion_run` per date, with balanced metrics.
8. **`--dry-run`** fetches and parses but writes no fact rows, and reports what it would write.

**Verify:** integration tests for — resume after a simulated crash mid-range produces no gap and no
duplicates; a 404 date yields `skipped`; re-running a completed range writes zero new rows.

### Task 2.3 — Security master derivation

Build `security` from the **union of all symbols observed across the entire backfill**, not from
`EQUITY_L.csv`. `EQUITY_L.csv` contains only currently-listed names and would reintroduce exactly
the survivorship bias this rebuild exists to remove.

For each symbol record `listed_from` (first observed session) and `listed_to` (last observed
session, NULL if seen in the most recent session). Set `status` to `listed` when last-seen is the
most recent session, otherwise `delisted`. Use `EQUITY_L.csv` only to enrich names and ISINs for
currently-listed symbols.

**Verify:** a query asserting that at least one symbol has a non-NULL `listed_to` predating the
latest session — if zero, the universe is still survivorship-biased and the task has failed.

### Task 2.4 — Data quality checks

Insert `dq_check` rows in the same migration as any table they cover:

| check_id | Asserts |
|---|---|
| `bhavcopy-freshness` | latest `market_bar` session is the latest trading session; trading-day aware |
| `bhavcopy-symbol-count` | accepted symbols per session within a plausible band |
| `bhavcopy-reject-rate` | rejected/seen below a threshold |
| `market-bar-ohlc-sanity` | no row with `high < low`; no non-positive close |
| `delivery-pct-range` | `delivery_pct` within 0–100 |
| `calendar-continuity` | no gap of more than N consecutive weekdays without a session |

Freshness checks must be **trading-day aware**: a Monday-morning check must not read Friday's data
as stale.

**Verify:** each check is negative-controlled — inject a violating row into a scratch database,
confirm the check reports failure, remove it.

### Task 2.5 — Coverage report

A script that queries the database and reports, per year:

- distinct sessions;
- distinct symbols;
- **per-symbol distinct-session counts as min / median / max** — not `min(date)`/`max(date)`,
  which can report years of span for a table holding four rows per symbol;
- rejected-row counts by reason;
- symbols with a non-NULL `listed_to` (the survivorship-free evidence).

This script must issue real queries. A script that formats numbers without connecting to the
database is prohibited (§0.4).

**Verify:** run against a scratch database seeded with known contents and assert the report matches
the known values.

### Acceptance Gate 2

1. Backfill completes 2021-01-04 → present with zero `failed` runs.
2. Session count for a completed year is within 1 of the known NSE trading-day count for that year;
   if it is not, investigate before proceeding — do not adjust the expectation to match.
3. Coverage report shows median per-symbol session count consistent with a dense daily panel.
4. At least one delisted symbol is present with a non-NULL `listed_to`.
5. All Task 2.4 checks pass and all are negative-controlled.
6. `rowsSeen == rowsAccepted + rowsRejected` for every `ingestion_run`.
7. Every `market_bar` row has a non-NULL `run_id` and `available_at`, and
   `provenance_quality = 'recorded'`.

---

## 6. Prohibitions

1. Do not use UDiFF `BhavCopy_NSE_CM_*` files. They 404 before ~2024-04.
2. Do not build `security` from `EQUITY_L.csv`.
3. Do not treat a 404 as a failure.
4. Do not retry a 404.
5. Do not coerce a missing or invalid numeric to 0.
6. Do not set `available_at` to fetch time or `now()`.
7. Do not create any table outside the migration chain.
8. Do not write a cron schedule in more than one place.
9. Do not reimplement the bhavcopy parser inside a test.
10. Do not fabricate data before 2021-01-04.
11. Do not report a measurement from a script that does not query the database.
12. Do not mark a stage complete without its acceptance gate passing as a command.

---

## 7. Report back on completion

State, with the command output that produced each number:

- migration count and final schema table count;
- backfill date range, sessions processed, sessions skipped as non-trading;
- total `market_bar` and `delivery_stat` rows;
- distinct symbols, and how many are delisted (non-NULL `listed_to`);
- rejected rows grouped by reason;
- per-year session counts;
- every acceptance-gate command and its exit code.

If any gate did not pass, say so plainly and state what is failing. Do not describe a stage as
complete when a gate is red.
