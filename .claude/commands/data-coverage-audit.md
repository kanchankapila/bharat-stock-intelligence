---
description: Whole-repo sweep for fetchers with no live_datasource test, tables with no freshness check, and freshness checks that pass while the feature they exist to deliver never populated
---

# Data Coverage Audit

Unlike `/fetcher-accuracy-review` (one fetcher, from a diff) this is the whole-repo version: find what's missing across all of it. Read the "Freshness-check mandate" section of `.claude/rules/data-sources.md` and the "Monitoring blind spots" section of `.claude/rules/recurring-bugs.md` first — this audit exists because manual review has twice found the gap to be much larger than assumed (a 2026-08-03 sweep found freshness checks covered only ~25 of ~140 DB-writing fetchers; a 2026-08-12 sweep found 21 of `ml_ensemble.py`'s 254 declared inputs were 100%-NULL on every recent date while the monitor read 86 pass / 1 fail throughout).

## 1. Enumerate the universe

- Every `*_fetcher.py` under `src/server/` (and TS equivalents under `src/server/`/`scripts/`) that calls out to an external URL/API.
- Every `TABLE_FRESHNESS_CHECKS` entry in `dataQualityChecks.ts`.
- Every `test_live_datasource_*.py` / `*.test.ts` file gated on `RUN_LIVE_DATASOURCE_TESTS`/`RUN_LIVE`.

Derive these lists from the source tree — grep for the actual call sites (`runPython(`, `requests.get`/`curl_cffi`, `axios`/`fetch` in a fetcher-shaped file) — not from a prior audit's memory or a hand-maintained list. A hand-enumerated allowlist only guards what someone remembered to list: `screenerAppearedAt.test.ts` pinned 3 of 4 real writers and the omitted one held 435,700 of 741,251 rows while the suite stayed green.

## 2. Match them up

Three gaps to report, each separately:

- **Fetcher with no `live_datasource` test.** Silent-wrong-on-day-one risk.
- **Table with no freshness check.** Silent-dead-on-day-200 risk — `mf_sector_allocation` was completely empty and indistinguishable from healthy in every dashboard.
- **Table WITH a freshness check that only measures row recency, not the columns the fetcher exists to populate.** Check a sample of freshness-check-covered tables: pick the columns downstream consumers (`ml_ensemble.py`, `unified_ranker.py`, scoring engines) actually read from each, and check what fraction is 100%-NULL on the most recently completed trading day. A fresh table is not a delivered feature.

## 3. Check for the promotion-gate false positive

For any freshness check on a table written by a promotion-gated or conditional job (only writes when a challenger beats a baseline, only writes on a rare trigger): does the monitor derive "last run" from the LATEST of {output-table probe, a stored `_ran_at`, `job_heartbeat.last_success_at`} — or from the output table alone? The output-table-only version reports a correctly-rejecting job as "stale" every time it correctly does nothing (`strategy-optimizer` read "stale since Aug 03" through two consecutive correct rejections).

## 4. Check for the crying-wolf false positive

For any check that fires on a bare `count > 0`: is the threshold sized to the actual defect magnitude, or will it fail on legitimate edge-case data? (`trades = delivery_qty` is legitimately true for an illiquid name with 4 shares in 4 trades — a bare-count check fails on correct data. Use a share-of-rows floor sized with real margin against the measured defect.) A check that cries wolf on real data stops being read.

## 5. Report

A table: fetcher/table name, which of the two mandatory artifacts (test, check) is missing, and — for the "check exists but feature isn't delivered" case — the NULL rate on the specific columns downstream code reads. Prioritise by what's actually consumed: a 100%-NULL column feeding `unified_ranker.py`/`ml_ensemble.py` outranks an orphaned table nothing reads. File new freshness checks as one-line `TABLE_FRESHNESS_CHECKS` entries via `makeFreshnessCheck()` per the mandate — don't hand-roll unless the check needs logic beyond "is this table still getting fresh rows."
