# Audit findings ledger

Carried across `/weekend-audit` runs by the `audit-loop` skill. **Never delete a row** — close it
with a date. A finding that reappears after being closed is a much stronger signal than a fresh
one, and only this file can show that. An open row surviving 3 runs is itself a finding.

Lanes: **FIX** (mechanically safe) · **EVIDENCE** (touches a score/weight/threshold — needs a
measurement first) · **INVESTIGATE** (symptom, unproven cause) · **ACCEPT** (known, bounded).

| ID | Found | Class | Finding | Lane | Status | Immunized | Closed |
|---|---|---|---|---|---|---|---|
| AF-20260815-01 | 2026-08-15 | temporal | `scripts/integrity_sweep.py` anchors on raw `MAX(date)` (`latest_date_expr`, L49-71). Enrichment columns are written by `ml-daily-ops` in the evening against the *previous* session, so the newest date is always the one enrichment hasn't reached — the sweep reports ~25 false DEAD columns every run. `087f399` fixed this exact bug in `dataQualityChecks.ts` and its own message says it was reintroduced in **both** files, but only one was fixed. | FIX | **open** — anchor to the newest date strictly older than the last successful `ml-daily-ops`, mirroring `ml-signal-columns-populated` | — | — |
| AF-20260815-02 | 2026-08-15 | deploy | `bharat-server` booted 2026-08-15 05:54 UTC; **11 commits touching `.ts`/`.py` have landed since**, latest 15:43 IST. `.ts` is not hot-reloaded — the running server is ~4h20m behind `HEAD`. | FIX | **open** — `pm2 restart bharat-server` (deferred: other sessions actively committing, restart is theirs to time) | — | — |
| AF-20260815-03 | 2026-08-15 | schema | `data_quality_history` exists live but is absent from `db/schema.postgres.sql` — created via self-creating DDL in `dataQualityChecks.ts:1899`, never reflected back. `npm run schema:drift` fails on it. | FIX | **open** — `npm run schema:regen`, or add it to the schema file | — | — |
| AF-20260815-04 | 2026-08-15 | test | `signalOutcomesServiceSource.test.ts > excludes confluence-sourced outcomes` fails (`expected +0 to be 1`). Traced: passes 4/4 at `HEAD` in a clean worktree, fails in the working tree. Cause is the in-flight `AND label_definition = 'path_barrier'` filter in `getWinRateStats`; the fixture inserts a row without that column. | FIX | **open — owned by another session**, their in-flight work | — | — |
| AF-20260815-05 | 2026-08-15 | data | `mf_sector_allocation` empty; `insider_transactions` 75.3d stale; `regime-edge-trust-floor` at 1 of 2 regimes. All three pre-existing DQ warns, none critical. | INVESTIGATE | **open** — `mf_sector_allocation` is recorded in memory as a dead upstream AMFI endpoint; insider filings are sparse by nature (warn-only by design) | — | — |
| AF-20260815-06 | 2026-08-15 | docs | `CLAUDE.md:82` claimed `dataQualityChecks.ts` holds 62 checks. Live count is 147 (22 critical); source has ~155 `id:` entries. Understated 2.4×. | FIX | **fixed** 2026-08-15 → `~150` | — | 2026-08-15 |
| AF-20260815-07 | 2026-08-15 | tooling | `/weekend-audit`'s own service probe used `/` for the three FastAPI services, which have no root route — three false DOWNs every run. Found by running it. | FIX | **fixed** 2026-08-15 → probe `/docs` | note in skill Lane 2 | 2026-08-15 |
| AF-20260815-08 | 2026-08-15 | tooling | `/weekend-audit` and `/threshold-calibration-audit` asserted `data_quality_results` has no history. `data_quality_history` (append-only) landed the same day, 265 rows / 152 checks. The verdict-variance query was pointed at the wrong table. | FIX | **fixed** 2026-08-15 → both skills repointed | — | 2026-08-15 |

## Run log

Which lanes actually ran, so a partial pass is never mistaken for a complete one.

### 2026-08-15 — week 33, rotation group 3 (Frontend & canonical)

| Lane | Verdict | Notes |
|---|---|---|
| 0 deploy | ⚠️ | 4/4 pm2 online; `bharat-server` 3 restarts, ~4h20m behind HEAD → AF-02 |
| 1 repo | ⚠️ | `tsc --noEmit` clean · pytest 1962 passed/230 skipped · vitest 937 passed/**1 failed** (AF-04) · `check_recurring_bugs.py` clean over 475 py + 136 ts · `npm run build` ✅ 30.4s · `schema:drift` **fail** (AF-03) |
| 2 services | ✅ | :3000 → 200, :8000/:8001/:8002 `/docs` → 200 |
| 3 jobs+DQ | ⚠️ | DQ 144 pass / 3 warn / 0 critical-fail (AF-05) · `integrity_sweep.py` → AF-01 · no job at 100% fail |
| 4 database | ✅ | 1 active / 7 idle connection, nothing >5 min. Earlier in the session two queries ran 70 and 110 min; they cleared on their own — transient, not carried as a finding |
| 5 frontend | **skipped** | Not run this pass — no browser drive performed. Reported as skipped, never as green |
| 6 rotation | **skipped** | Group 3 (`/canonical-read-audit`, `/shell-parity-audit`, `/data-honesty-review`) not run this pass |
| 7 ledger | ✅ | This file created — first baseline, nothing to compare against yet |

**New this week:** AF-01 through AF-08 (first run, all new by definition).
**Fixed and verified:** AF-06, AF-07, AF-08.
**Next run compares against this table.** Lanes 5 and 6 are the gap to close first.
