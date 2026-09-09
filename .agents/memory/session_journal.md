# Session Journal (claude-mem)

Lean, incremental checkpoint of decisions / known bugs / state. Newest first.

## 2026-09-09 — Telegram daily-report audit (AF-20260909-07..10)

- **Task:** audit codebase + DB + error logs + every Telegram daily report; fix failures.
- **Fixed (all live-deployed via `pm2 restart bharat-server`, health 200):**
  - `telegramService.sendMarkdownMessage`: Telegram 429 now retried honoring `retry_after`
    (2 retries, 35s cap) + ~1.1s inter-chunk pacing. Root cause of the 09-08 08:15 IST
    morning-digest loss. All reports share this path.
  - `technicalSignalsService.sendTelegramSignals` (now exported): "NSE DAILY SCAN" digest had
    NEVER sent — gate read `r.winProbability` which the scan never populates. New gate =
    scan's own actionable threshold (`signalScore >= 5`, 7 in BEAR), ONE digest per scan date
    (marker set on success only → auto-retry next 30-min slot), routed through telegramService.
  - `jobSweep.classifyStderr`: `[HighFlyer] skipped N/M stat day...` added to BENIGN (was
    warn-logged as real_error on successful runs).
  - `vite.config.ts`: `.audit-files.txt` added to `server.watch.ignored` (EBUSY
    unhandledRejection surface).
- **Known transient (do not chase):** 02:16:16 IST DB blip (19 monitor timeouts, self-healed);
  NiftyTrader/Trendlyne vendor blocks self-clear (0 NT errors the day after 818).
- **User-action still open:** `GEMINI_API_KEY` empty in `.env` (AF-20260828-24) — research
  reports + chatbot degrade honestly without it.
- **State:** vitest 1,249/0 (9 new tests: `telegramDailyScanDigest.test.ts` ×5,
  `rateLimitWaitMs` ×3, HighFlyer ×1); tsc clean; graphify rebuilt 18,746 nodes
  (`graphify-out/2026-09-09/`); ledger AF-20260909-07..10 in `docs/audit-findings.md`.
- **DB facts cached:** Postgres :5433 `bharat_intel`; `data_quality_results.critical` is
  INTEGER (0/1), `checked_at` BIGINT epoch-ms; `unified_recommendations.computed_at` is TEXT
  holding date-only strings (MAX works lexicographically; `substring(computed_at,1,10)` valid);
  Telegram creds live in `app_settings` (`telegram_bot_token`/`telegram_chat_id`/`telegram_enabled`)
  with env fallback; app log timestamps are **IST** while crons/DB are UTC.
- **Evening addendum (AF-20260909-11..13):** the digest's 15 `orphan (fake-queue)` alerts were
  the TEST SUITE phoning home — `addJobWithCatchupReclaims.test.ts` lacked the telegramService
  mock, so `vitest run` sent live alerts. Fixed per-file + a `process.env.VITEST` guard inside
  `sendMarkdownMessage` (inert in prod). ml-weekly-retrain make-up enqueued (fires ~23:36 IST
  09-09, after the ml-daily-ops chain; Saturday repeatable intact). NiftyTrader-capture "16h
  late" and ml-dispersion "100%" were stale-snapshot false alarms (capture 32/32 slots; latest
  DQ reads ml 0%). `job_heartbeat` stores naive-UTC epochs — pg JSON adds a bogus `Z` to
  `AT TIME ZONE` output; use raw epoch math.
- **Built `.claude/skills/repo-doctor/`** (SKILL.md + doctor.mjs): one consolidated
  codebase/DB/frontend/logs health check encoding every recurring bug class; run
  `node .claude/skills/repo-doctor/doctor.mjs` (add `--full` for tsc+vite build). First run:
  33 checks, 26 PASS / 6 documented-benign WARN / 0 FAIL. Rule in its SKILL.md: new bug class
  ⇒ new named check + recurring-bugs row + AF ledger row.
- **Night addendum (AF-20260909-14, accuracy digest):** data direction audit = CLEAN
  (`unified_ranker._classify` monotone by `unified_score`; title-case strings; class sets
  pinned by tests). Real inversion found at the DISPLAY layer — Grafana "top losers" panel
  mapped Strong Sell→green / Strong Buy→red (fixed). Digest now renders both halves:
  `Made high (flyers) 128: 11 (9%) as recommended (Buy) · 16 (13%) we said Sell · 101 unrated`
  (divers mirrored) + a "Confirmed as recommended" top-5. repo-doctor gained
  `grafana-systemcall-colors`. Live split 09-09: flyers 11/16/101, divers 22/1/57.
- **Late addendum (AF-20260909-15, MarketsMojo timeout):** the user's insight — quarterly
  financials don't change weekly — was the fix. `STALENESS_DAYS 7→90` in
  `marketsmojo_financials_fetcher.py`. Measured 56.5s/5 fresh symbols → ~47 min for 2000
  (the timeout cause); full-universe run now 6.7s (1831 skipped). `--full` re-upsert intact
  (HDFCBANK 1890 cells).
