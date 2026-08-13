---
description: Audit a new or changed fetcher against the mandatory data-sources.md checklist and the fetcher-shaped bug classes in recurring-bugs.md
---

# Fetcher Accuracy Review

Read `.claude/rules/data-sources.md` and the "Writes & keys" / "Environment & deploy" sections of `.claude/rules/recurring-bugs.md` first. This review exists because `check_recurring_bugs.py` (CI) only catches the mechanical signatures — `date.today()` write-anchors, raw `%s`, a missing `live_datasource` test file. Everything below needs judgment, not a regex, which is why it's a review and not another CI check.

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

## 4. Freshness check

Is there a `TABLE_FRESHNESS_CHECKS` entry in `dataQualityChecks.ts` for this fetcher's target table? If not, the review fails — a fetcher can pass every test above and still go silently empty in production (`mf_sector_allocation` did, for its entire life, indistinguishable from healthy). Check `tradingDayAware` is set correctly for the cadence (default `true`; `false` only for genuinely 24/7 tables).

**A fresh table is not a delivered feature.** If this fetcher's whole purpose is to populate specific columns consumed elsewhere (an `ext_*` feature, a score input), check those columns aren't 100%-NULL on the last completed trading day — a freshness check on the table can pass while the column it exists to deliver never populated (`extra_endpoint_responses` took fresh rows nightly for weeks while all 14 `ext_*` columns stayed at 0%).

## 5. Recurring bug signatures specific to fetchers

Walk `recurring-bugs.md`'s table against this diff:
- Date anchor: `date.today()`/`datetime.now()` used as an exact-match write target, or as both the write-target AND a separate downstream computation (the `_backfill_days_to_results` bug — the write-target fix alone didn't fix the days-computation, which still used a different clock).
- A backfill/upsert loop gated on re-selection by one of several columns it fills — permanently excludes rows that got column 1 but not columns 2-3.
- A per-call API with no since-parameter, re-upserting full history every run — check what fraction of a typical response is actually new data; under 1% means the upsert, not the fetch, is the bottleneck.
- A parsing/enrichment step that's the *last* statement in a script that routinely hits a job-runner timeout — check the job's logs for "killed by timeout" on a recurring basis; if so, assume anything after the kill point has never run.
- Env-var-dependent DB routing (`USE_POSTGRES`) in a standalone script run without `import 'dotenv/config'` — silently talks to SQLite. Print `process.env.USE_POSTGRES` and cross-check a row count against a number you already know from `psql`/`db_compat` before trusting any number this fetcher's own verification prints.

## 6. Report

Named findings only — file, line, the specific rule violated, a live trace if you can run one. Anything durable (a new bug shape, not just an instance of a listed one) goes into `.claude/rules/recurring-bugs.md`, not just this review's output.
