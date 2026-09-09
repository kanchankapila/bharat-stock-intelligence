# Telegram daily-report audit — 2026-09-09

## Goal
Audit the full codebase, DB, and error logs to find why daily Telegram reports fail, fix all
issues found, and update docs/memory systems to current state.

## Root-cause chain (morning session, AF-20260909-07..10)
- **429 "retry after 8" killed the 09-08 08:15 IST morning digest**; no retry logic existed.
  All report types funnel through one function (`telegramService.sendMarkdownMessage`), so the
  fix covers everything: bounded retries honoring `retry_after` (2 retries, 35s cap) + ~1.1s
  inter-chunk pacing.
- **"NSE DAILY SCAN" digest had NEVER sent** — its gate read `r.winProbability` (never
  populated anywhere; 0 sends across 5 days of logs). Now gates on `signalScore >= 5`
  (7 in BEAR — the values mirroring into `recommendation_log`), one digest per date with
  retry-on-failure, routed through telegramService. Third instance of the always-false-gate
  class; rule recorded in recurring-bugs.md: "grep for the WRITER of the gated field, not
  just the reader."
- **AF-09** `jobSweep.ts`: HighFlyer skip-notice added to `classifyStderr` BENIGN list.
- **AF-10** `vite.config.ts`: `.audit-files.txt` added to `watch.ignored` (EBUSY fix).
- 9 new tests; full vitest 1,249/0; tsc clean. Deployed `pm2 restart bharat-server
  --update-env`, health 200, Telegram send through the new code path verified 18:58:05.
- Graphify rebuilt (18,746 nodes, `graphify-out/2026-09-09/`).

## Verified healthy (morning session)
`daily_research_reports` READY ×4 dates; 73/73 tracked jobs latest-run success;
job_run_history 5 failed / 2,699 success (48h, all explained); DQ 164 pass / 5 warn /
0 fail-error. Documented-not-fixed transients: 02:16:16 DB blip (19 timeouts in ~1s,
self-healed); NiftyTrader 818 errors 09-08 → 0 on 09-09 (known vendor-block pattern).

## Blocked (user action only)
`GEMINI_API_KEY` empty in `.env` (AF-20260828-24) — AI features degrade honestly until supplied.

## Evening addendum (same day) — AF-20260909-11..13

- **15 `orphan (fake-queue)` Telegram alerts = the test suite phoning home.** `addJobWithCatchupReclaims.test.ts`
  lacked `vi.mock('../telegramService')`, so `requeueOrphanedJob`'s dynamic import hit the REAL service on every
  `vitest run`. Fixed: per-file mocks (it + registerJob + staleActiveJobs + monitorNameByJob tests) AND a runtime
  guard in `sendMarkdownMessage` (`process.env.VITEST` → return false, inert in prod). The 16th alert (ml-daily-ops,
  active 8m) was the legitimate 18:58-restart boot reclaim. `buildDailyDigest` has no orphan-alert section — those
  blocks were separate Telegram messages, not digest content.
- **ml-weekly-retrain**: 09-06 run failed on `marketsmojo_financials_fetcher` + `marketsmojo_shareholding_fetcher`
  (last success 08-29). Data rows already fresh (manual re-runs + 7-day skip cache); enqueued delayed make-up
  `manual-makeup-20260909-ml-weekly-retrain` firing ~23:36 IST 09-09 (after the ml-daily-ops chain), Saturday
  repeatable verified intact. Watch `engine_composite_scores` (stale 09-06) refresh after it lands.
- **False alarms**: NiftyTrader Live Filter Capture was healthy (32 slots, 0 failures, last 15:30 IST) — the
  "~16h late" flag read a pre-freshness heartbeat; ml-dispersion "100%" already reads 0% in latest DQ results.
  Trap: `job_heartbeat` stores naive-UTC epochs; pg JSON appends a bogus `Z` to `AT TIME ZONE` output.
- **NEW `.claude/skills/repo-doctor/`** — one skill, four lanes (code/DB/frontend/logs), every recurring bug
  class as an executable check. `node .claude/skills/repo-doctor/doctor.mjs [--full]`. First live run: 33 checks,
  26 PASS / 6 documented-benign WARN / 0 FAIL. Extend per its SKILL.md rule (new class ⇒ new check + rules row
  + AF ledger row).
