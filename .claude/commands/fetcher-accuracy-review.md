---
description: Audit a fetcher against the mandatory data-sources.md checklist and the fetcher-shaped bug classes in recurring-bugs.md — one fetcher from a diff, or the full project sweep across every fetcher hitting an external URL
---

# Fetcher Accuracy Review

Read `.claude/rules/data-sources.md` and the "Writes & keys" / "Environment & deploy" sections of `.claude/rules/recurring-bugs.md` first. This review exists because `check_recurring_bugs.py` (CI) only catches the mechanical signatures — `date.today()` write-anchors, raw `%s`, a missing `live_datasource` test file. Everything below needs judgment, not a regex, which is why it's a review and not another CI check.

## Scope

**Default scope is every fetcher in the project that reads from an external URL/API** — not just a diff. Derive the list from the source tree, don't work from memory of a prior pass:

```bash
ls src/server/*fetcher*.py
grep -rlE "requests\.(get|post)|curl_cffi|httpx\.(get|post|Client)" src/server --include="*.py" | grep -iv test
```

Cross-reference against `TABLE_FRESHNESS_CHECKS` (`dataQualityChecks.ts`) and `test_live_datasource_*`/`*.test.ts` files the same way — union the two lists, don't just walk one.

This is ~80 fetchers as of 2026-08-13, and the checklist below (especially §1's "run the live check yourself" and §3's "actually run it") does not compress to a one-line-per-file skim without losing the thing that makes it worth running — that's what `/data-coverage-audit` is for (fast, mechanical, artifact-presence only: does a test/check exist at all, not whether the fetcher is *correct*). Given the size, **before running the full sweep, tell the user the fetcher count and ask how to execute it** — depth-per-fetcher and parallelism are both real tradeoffs here, not a default to assume silently:

- **Triage first, deep-dive second**: run `/data-coverage-audit`'s artifact-presence check across all of them (cheap), then apply this skill's full 6-point review only to the ones that are missing an artifact or look structurally unusual — not to the ones that already have both a passing live test and a freshness check.
- **Full depth on all of them**: every fetcher gets the complete checklist, run inline, sequentially. Slow and expensive but genuinely thorough — pick this only if the user says so, or if they've explicitly authorized parallel/background agents to split the work.
- **A named subset**: one provider's fetchers (all `mc_*`, all `trendlyne_*`, all `marketsmojo_*`), or whatever slice the user actually asked about.

When reviewing a single fetcher from a diff (the common case — a PR touches one), the sections below apply exactly as written, scoped to that one file.

## 1. Identifier resolution

- Does it resolve the provider's id through `stocklist.ts`/`getStockMapping` (or, for indices, `getIndexMapping`) first, autocomplete API second, ISIN fallback third — never constructed by convention? Grep the fetcher for a hardcoded suffix/prefix pattern (`.NS`, string concatenation onto `symbol`) that isn't one of the two documented derivable cases (Yahoo `.NS`/`.BO`).
- If the provider has its own opaque id, is it in `StockMapping` (or a documented reuse of an existing id, like MarketsMojo reusing MoneyControl's `stockid`) — not invented ad hoc in this fetcher alone?
- **Run the live check yourself, don't take the diff's word for it**: pick one real symbol, call the fetcher's own resolver, confirm the id it returns actually looks like the provider's id shape (numeric string, opaque code, whatever the table in `data-sources.md` says) — not a URL, not the ticker itself. The `tlid` incident (412 rows silently holding the symbol instead of a numeric id, 18.4% of the universe permanently 404ing) was invisible without this check for its entire life.

## 2. Primary key

If this fetcher writes a table keyed on any id a third party issues (`scan_id`, `screener_id`, `screenpk`, a vendor's internal numeric id) — is the provider part of the primary key? `(source, provider_id)`, never `provider_id` alone. Ask explicitly: does more than one provider in this codebase issue this *kind* of id independently? If yes and the PK is bare, this is the same bug fixed three times in 48 hours before the rule existed — don't wait for a fourth.

## 3. The `live_datasource` test

Find `test_live_datasource_*` (or the `.test.ts` equivalent under `RUN_LIVE_DATASOURCE_TESTS`/`RUN_LIVE=1`) for this exact fetcher. Confirm, don't assume:

- It calls the fetcher's **own** resolution helper for the id, not a hardcoded one that can go stale silently.
- It parses the response with the fetcher's **own** parsing function — a hand-rolled reimplementation passes against broken real code.
- It asserts non-empty + correctly shaped (`assert_looks_like_ticker`, `assert_numeric_and_finite` if it writes to a DB).
- If it writes to a DB: writes through the fetcher's own write function into a throwaway/in-memory DB, reads the row back.
- **Actually run it** (`RUN_LIVE_DATASOURCE_TESTS=1 python -m pytest <path> -m live_datasource`, or the `.ts` equivalent) — a test that exists but was never executed this session is a claim, not evidence.

If there's no such test, this fetcher fails the review outright — this is the exact gap that let the 2026-07-23 Trendlyne bug corrupt ~2.1M rows across 7 tables undetected.

## 4. Freshness check — and confirm which table is actually THE table

Before writing the check, confirm you know the real write target: grep the fetcher for `INSERT INTO`/`UPDATE`/`ON CONFLICT`, not just `CREATE TABLE IF NOT EXISTS` — a defensive `CREATE TABLE` doesn't mean this file writes there. Caught live 2026-08-13: a table named `trendlyne_pe_history` looked like a two-writer collision (both `mc_pricefeed_fetcher.py` and `trendlyne_fundamentals_fetcher.py` had a matching `CREATE TABLE IF NOT EXISTS`) until actually reading `trendlyne_fundamentals_fetcher.py` line by line showed it only `SELECT`s from that table — `mc_pricefeed_fetcher.py` is the sole writer, and a comment in `queues.ts` already said so. A `CREATE TABLE IF NOT EXISTS` count is a hypothesis, not a finding, until you've checked which files actually mutate the table.

Is there a `TABLE_FRESHNESS_CHECKS` entry in `dataQualityChecks.ts` for the confirmed target table? If not, the review fails — a fetcher can pass every test above and still go silently empty in production (`mf_sector_allocation` did, for its entire life, indistinguishable from healthy — and so did `mf_holdings_fetcher.py`'s `stock_mf_holdings`, found 2026-08-13: the table didn't even exist, because a dead upstream endpoint had 404'd on every symbol since the fetcher was added). Check `tradingDayAware` is set correctly for the cadence (default `true`; `false` only for genuinely 24/7 tables). **Actually run the check** (`npx tsx scripts/run_data_quality_checks.ts`, filtered to the new `id`) against live Postgres before calling this done — a check that compiles but was never executed against real data is the same unverified claim as an un-run test.

If the table has no timestamp/date column at all (checked `information_schema.columns`, not assumed), it can't take the standard factory — flag it as "schema doesn't support freshness measurement" rather than force-fitting a check onto the wrong column or silently skipping it. `screener_catalog` and `mc_estimates_hits_misses`/`mc_stock_vitals`/`mc_stock_scans`/`mc_seasonality_best_stocks` are in exactly this state as of 2026-08-13 — needs a migration, not a check.

**If the table you're about to check has an `ON CONFLICT DO UPDATE SET`, verify the freshness column is actually IN that SET clause before trusting it.** `screener_master.last_updated` looked like a valid freshness signal but was excluded from the upsert's SET clause — frozen at first-insert forever while the row's real content refreshed daily. A check wired up against it would have been permanently, silently wrong. Same root class as `recurring-bugs.md`'s "`generated_at` in `ON CONFLICT`" bug, inverse form (wrongly excluded here, vs. wrongly included there).

**A fresh table is not a delivered feature — and a fresh SOURCE table doesn't prove the DERIVED column is fresh either.** If this fetcher's whole purpose is to populate specific columns consumed elsewhere (an `ext_*` feature, a score input, a `technical_signals` column via `UPDATE`), check those columns aren't 100%-NULL on the last completed trading day — a freshness check on the table can pass while the column it exists to deliver never populated (`extra_endpoint_responses` took fresh rows nightly for weeks while all 14 `ext_*` columns stayed at 0%). Run the same query `technical-signals-feature-coverage`'s check uses, but list the actual dead column names instead of just the count:

```sql
WITH latest AS (
  SELECT * FROM technical_signals
  WHERE date = (SELECT MAX(date) FROM technical_signals WHERE date < CURRENT_DATE::text)
), kv AS (
  SELECT key, COUNT(*) FILTER (WHERE value <> 'null'::jsonb) AS non_null
  FROM latest t, LATERAL jsonb_each(to_jsonb(t)) GROUP BY key
)
SELECT key FROM kv WHERE non_null = 0 ORDER BY key;
```

Check whether this fetcher's declared output columns are in that list. If they are, don't stop at "the source table is fresh" — trace *why* the derived column is dead: a genuine bug (write path broken), or a structural lag that's already accounted for (e.g. a weekly fetcher's blanket `UPDATE ... WHERE symbol = ?` only touches rows that already existed at run time — a daily grid row inserted *after* the weekly run stays NULL until the next weekly pass, which can look like 100% failure on any day that isn't the day after the weekly job ran). Distinguish the two before reporting either as a finding.

## 5. Recurring bug signatures specific to fetchers

Walk `recurring-bugs.md`'s table against this diff:
- Date anchor: `date.today()`/`datetime.now()` used as an exact-match write target, or as both the write-target AND a separate downstream computation (the `_backfill_days_to_results` bug — the write-target fix alone didn't fix the days-computation, which still used a different clock).
- A backfill/upsert loop gated on re-selection by one of several columns it fills — permanently excludes rows that got column 1 but not columns 2-3.
- A per-call API with no since-parameter, re-upserting full history every run — check what fraction of a typical response is actually new data; under 1% means the upsert, not the fetch, is the bottleneck.
- A parsing/enrichment step that's the *last* statement in a script that routinely hits a job-runner timeout — check the job's logs for "killed by timeout" on a recurring basis; if so, assume anything after the kill point has never run.
- A verification number the fetcher prints about itself. Cross-check it against a row count you already know from `psql`/`db_compat`. (The old form of this check — "print `process.env.USE_POSTGRES` to confirm you aren't on SQLite" — is **dead as of 2026-08-15**: `use_postgres()` consults no env var for a real process, so a correct script prints `undefined`. There is no wrong database left to land on, only a wrong number.)

## 6. Report

Named findings only — file, line, the specific rule violated, a live trace if you can run one. Anything durable (a new bug shape, not just an instance of a listed one) goes into `.claude/rules/recurring-bugs.md`, not just this review's output.
