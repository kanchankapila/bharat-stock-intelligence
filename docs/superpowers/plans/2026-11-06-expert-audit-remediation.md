# Expert-audit remediation plan — 2026-11-06

Source: two pasted external audits (20 numbered items, plus a "files most likely to mislead" list), each
checked against `docs/audit-findings.md`, `.claude/rules/` and the tree on 2026-11-06. Every task maps to
a ledger row; the ledger, not this file, is the status of record. Close each row with date + evidence.

## Verdict on the audit items

| # | Item | Verdict | Ledger |
|---|---|---|---|
| 1 | No forward edge | Correct, standing | paper book, verdict ~2027-01-22 |
| 2 | Direction-agnostic conviction | Correct issue, **closed** 2026-10-29 (user: keep label, read with direction) | AF-20261021-01 |
| 3 | Vocabulary split | Issue real, **fix refuted** 2026-10-25 (widened arm worst, -1.74%/trade) | AF-20261021-02 |
| 4 | Regime instability | Correct; persistence first is the wrong order | AF-20261103-07/11/12 |
| 5 | `bo_bet` sizing | Correct; user decided 2026-11-04 keep, size is null/UNVALIDATED in UI | AF-20261103-13, AF-20261028-07 |
| 6 | Risk veto direction | **Wrong reasoning** (Decreasing ROCE is deterioration; 646/651 shows penalties made labels, not wrong ones) | AF-20261030-05, AF-20261008-25 |
| 7 | Confluence percentile | Correct, DEPLOY-PENDING | AF-20261105-02 |
| 8 | Fundamental overlay | Correct, DEPLOY-PENDING | AF-20261105-04 |
| 9 | Point-in-time archive | Correct, open | AF-20261104-01, AF-20261030-10/15 |
| 10 | Overlapping windows | Correct idea, **wrong number** (46 of 895 have 20+ independent periods; 1 of 24 USABLE survived) — fixed 2026-09-12 | AF-20260912-15 |
| 11 | Microcap concentration | Correct, standing rule | measurement.md |
| 12 | Cost tiers | Correct, standing rule | measurement.md |
| 13 | Exit stamping | Correct issue, **closed** 2026-10-08 | AF-20261008-08 |
| 14 | 204 / `--as-of` | Correct issue, **closed** 2026-11-05 | AF-20261030-18/20 |
| 15 | Adjustment factors | Correct (in `alpha.*`; `stock_ohlcv` is the good series), open | AF-20261104-04 |
| 16 | Alias collision | Correct; migration applied 11-06, 114 link rows remain | AF-20261105-05 |
| 17 | Feature-level monitoring | Correct, standing rule (bugs-monitoring.md) | — |
| 18 | Host capacity / backups | Correct, user decisions | AF-20261102-01, AF-20261103-10 |
| 19 | Deploy drift | Correct, user decision | AF-20261103-15 |
| 20 | Digest honesty | Correct issue, **closed** 2026-11-04 | AF-20261104-02 |

Second paste ("files most likely to mislead"): every listed file exists and the framing is right;
`doc:numbers:check` passes on 2026-11-06. One wrong example: AF-20260823-77/78 are closed fixes, not
superseded rows; -77 is one of 18 pre-rule duplicate ids that `checkFindingsLedger.mjs` reports as
warnings by design. No code change follows from it (see Phase 6).

Not acted on: #2, #3, #5 removal, #13, #14, #20 (closed or decided), and the #6 reasoning.

## Phase 0 — Land the dirty tree (blocks every deploy below)

Production already runs two migrations that exist only as untracked files, and the next
`bharat-server` restart loads whatever TS sits in the tree.

- 0.1 Confirm with the owning session that the screener-semantics + ranker-penalties work is finished (staged `screenerSemantics.ts`, `screener_semantics.py`, `screenerClassifier.ts`, `unified_ranker.py` penalties INSERT, tests). Do not commit another session's half-done work.
- 0.2 **D1, measured 2026-11-06.** Correction: the v3 semantic candidate is review-only and not in any live path. The live, unmeasured change was AF-20261105-03 (migration applied 00:56 IST 11-06): the x0.5 veto removed from ETnow 8486 "Low Debt Stocks" and 8651 "Decreasing Quarterly Losses". Replay of 45 batches (2026-09-01..11-04, membership rebuilt from `screener_appearances` episodes, ~15 affected names/batch, 745 name-days): the vetoed names trailed the Hold cohort they would join by -0.33%/day (t -2.91; halves t -2.96 / -1.20; 31 of 45 dates negative), -0.47%/day on ADT >= Rs 1 cr (t -2.67). Fails the AF-20261026-71 ship rule. Removal would move ~12 labels/batch toward Hold and restore up to 16 Buys over 45 batches. Recommended: restore the veto in `screener_catalog`/`screener_master` (no Down step exists) and revert the matching `screenerClassifier.ts` rule before any restart. Owner's production write. Done in code 2026-11-06 (classifier hunks reverted, migration `20261106120000_restore-low-debt-red-flag-veto`); the migration is the owner's to apply — status in AF-20261105-03.
- 0.2b AF-20261106-04. New defect: `screener_features_fetcher.load_today_appearances` keeps only episodes with `appeared_date >= as_of - 3 days`, contradicting its docstring ("active"). 5,526 of 7,200 open ETnow episodes are dropped from `screener_membership_runs`/`_snapshot` and from screener ML features. The v3 replay (AF-20261106-01) used that capture, so its numbers are void. Fixing it changes model inputs, so measure before deploying.
- 0.3 Commit `migrations/20261105120000_ranker-penalties.sql` and `migrations/20261105120100_positive-screeners-not-red-flags.sql` by explicit path with `db/schema.postgres.sql`; `npm run schema:drift` clean.
- 0.4 Gates on the exact source: `npx tsc --noEmit`, `npx vitest run`, pytest via `scripts/pytest_memory_guard.py` with `PGTEST_DB` set to a verified empty db. Read summary lines; attribute any failure (git status, mtime, passes alone). Commit by explicit path.
- 0.5 One `bharat-server` restart: zero active jobs, no dirty `.ts` newer than the commit, health + `job_run_history` clean for the next hour.

## Phase 1 — Read back the DEPLOY-PENDING fixes (items 7, 8, 16, 18-FinBERT)

- 1.1 AF-20261105-02: next ranker batch's stored confluence matches a percentile over the batch's own symbols, MAE ≈ 0.
- 1.2 AF-20261105-04: D/E bonus count ~1,416 (not 110); ROE filled from `quant_scores` where fundamentals is null; filing growth on ~1,132 names; HARIOMPIPE nonzero.
- 1.3 AF-20261105-03: classifier output reads `fundamental_quality`/bullish for both screeners after restart (catalog already verified).
- 1.4 AF-20261105-05: owner runs the 114-row `news_symbol_link` delete (command in 2026-11-05 session log); read back 0 cross-tagged links.
- 1.5 AF-20261102-01 FinBERT: ≤ 24 launches in the first full IST day (`job_run_history`).
- 1.6 AF-20261008-25: next batch writes non-null `penalties` to `unified_recommendations_history`.

## Phase 2 — Point-in-time capture (item 9; prerequisite for 4 and 6)

- 2.1 AF-20261030-10 / -15: full gates, review, deploy the append-only membership and XBRL-revision writers; prospective real-data readback.
- 2.2 AF-20261104-01: record the values and ids the ranker consumed **inside the ranker run** (same transaction as its write), replacing the post-run read of mutable tables. Regression: mutate a source row after the run, replay is unchanged. Older archives stay labelled unverified.

## Phase 3 — Evidence-gated scoring items (no live change without the replay)

- 3.1 **Due before the 2026-11-07 retrain** — AF-20261103-12: compare candidate vs live HMM regime labels over 2026 before the swap; read the first swap under the new archive.
- 3.2 AF-20261103-11 / -07: replay 2026 labels with final A/D + VIX inputs; only then evaluate persistence or a regime-change gate (persistence alone moves the Buy count). D2 for the user after the replay.
- 3.3 #6 AF-20261030-05 / AF-20261008-25: grade the veto prospectively as a shadow arm against risk-only abstention on frozen pre-open cohorts, net of costs, independent periods. Calendar-blocked until 2027-02-26.
- 3.4 #5 AF-20261103-13: no change; re-measure sizing when the paper book reaches its verdict (~2027-01-22).
- 3.5 #1/#20 check, no new code expected: confirm every routed v1 recommendation surface renders `deriveCallState` (`AlphaHonesty.tsx`, `EdgeEvidence.tsx`) with horizon and UNPROVEN state. File a row only for a routed surface that doesn't.

## Phase 4 — Data integrity (item 15)

- 4.1 AF-20261104-04 next action (read-only, due 2026-11-06): compare `load_panel` vs `stock_ohlcv` one-day returns on the 790 flagged closes and the mass ex-dates; recompute `momentum_12_1` on an adjusted series; report the change. Then the user decision the row names.

## Phase 5 — Ops decisions for the user (items 18, 19)

- 5.1 AF-20261103-15: schedule the release-worktree cutover (restarts every service). This removes Phase 0's class of block.
- 5.2 AF-20261103-10: backups to a separate physical device (C: and D: are one SSD).
- 5.3 AF-20261102-01: `.wslconfig` `autoMemoryReclaim=dropCache` (needs `wsl --shutdown`).

## Phase 6 — Docs (second paste)

Nothing to build: CLAUDE.md "Counts drift", `doc:numbers:check`, and the ledger-is-the-only-tracker
rule already encode it. Add a staleness banner only if a dated doc is actually quoted wrongly.

## Done when

Each row above closed or left open for an allowed reason; `npm run findings:check` and
`npm run backlog:check` pass; session log appended.
