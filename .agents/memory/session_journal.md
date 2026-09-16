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

## 2026-09-15 - audit re-verify + fix pass (AF-20260915-01..07)

- **feature_store "0% flow columns" was run-ordering, not broken wiring.** 09-04..09-11 measured live at 78-100% (pcr_oi ~1,900/2,418, delivery_pct ~2,100 via AF-20260913-02 deep-history source, fii_3d_net 2,418/2,418, max_pain/iv_rank at their ~210 F&O-name ceiling). The 09-15 zeros were the 17:26 IST refresh running before the 18:30 option-chain/PCR writers, plus 09-14 being a HOLIDAY (21 junk bars; delivery/FII/option tables max at 09-11) so no T-1 data existed - NEVER_FILL semantics, not a defect. Rebuilt with `feature_engineering.py --date today`: pcr_oi 83 -> 1,941/2,388. Rule: coverage verdicts need a WINDOW of dates + upstream max(date) cross-check, never the latest day alone.
- **days_to_next_earnings was dead by construction:** mc_earnings_fetcher queried MC get-earnings-data with a 14-day forward window -> between quarters that captures only the current reporting week, and on 2026-09-15 all 18 upcoming events were SME/new-listing scids (SL25/Shiprocket, KI25, TII02...) joining nothing in the universe. Widened to 90d (UPCOMING_WINDOW_DAYS); live run: MC publishes only ANNOUNCED board dates, so between-quarters sparsity is the data's own nature and the documented NaN semantics ('NaN = no known upcoming, not 0') are honest. technical_signals.days_to_board_meeting checked as alternate source: dead too (0/2,173).
- **insider_trades 'stale 10.5 months' was string-max on mixed-format TEXT `date`** ('31 Oct, 2025' vs ISO; date_iso was fresh through 09-11; every reader uses date_iso). Backfilled 78,419 rows + writer now stores ISO in `date` too. test_moneycontrol_fetcher_insider_date_iso.py PINNED the raw display format - updated the pin to ISO with rationale (the pin itself was the misleading behavior); 3/3 green after.
- **exit_policy cv_roc_auc > 1.0 = documented column-reuse, closed as not-a-defect:** model_registry.cv_roc_auc/cv_accuracy hold mfe_holdout_mae/mae_holdout_mae (pct points) for exit_policy - spelled out in _active_exit_baseline's docstring AND every row's notes ('REJECTED: new held-out MFE MAE -1.9907...'); the gate negates before comparing. Three audits in a row misread it.
- **drift->retrain automation was never half-done:** queues.ts tolerates drift-detector exit(1) -> enqueues dl-retrain-emergency -> dl_trainer --trigger drift (deliberate monitor-only design, AF-20260824-82). retrain_triggered=0 everywhere was CORRECT (no emergency since the 2026-08-15 PSI recalibration). Fixed the only real gap: worker completed-handler now stamps MAX(id) drift rows per model via dbRun (swallow-and-warn). tsc + full vitest (1,359) green.
- **reverse_engineering_study.py extended (P1-6):** +intraday_rank engine hit-rate (intraday_recommendations, read bounded to the event window - it is the highest-frequency engine table) and three factor families: preopen (preopen_stock_snapshot iep_gap_pct/imbalance, T-1 exact), fno_positioning (so_stock_oi_summary pcr + fut_oi_chg, latest within 5d), news (news_symbol_link avg sentiment + count, 3d window). First live 90d run (218,948 events, 83 classes): **f_so_pcr IC +0.0683 = strongest factor in the whole table** (n=51 dates); f_preopen_gap_pct +0.0291; f_news_sent +0.0236; **intraday_rank@top20 hit-rate 0.7%** - the intraday engine is as blind to next-day movers as technical/confluence (0.98%/0.14%).
- **Study report path is CWD-dependent:** launched from src/server it wrote src/server/docs/mover_study_report.md (a previously-tracked duplicate existed from exactly that mistake). Deleted the stray; canonical = docs/mover_study_report.md. Launch study scripts from repo root.
- Hygiene: 26 ghost reco rows purged via documented repair (--ghost-recommendations; DQ critical unified-recommendations-ghost-symbols back to green, was failing daily); 34 timeframe-casing residue rows normalized to the enum set.
- DoD: tsc clean; vitest 142 files/1,359 tests pass; pytest full suite run (see session-log for final count); py_compile clean on all 3 edited py files.

### 2026-09-15 (later) - hook wiring was dead on Windows; token-reduction machinery enforced nowhere

Asked "are claude-mem / headroom / graphify correctly configured to reduce tokens?". Answer for the SKILLS: yes (all three are real, correctly-scoped guidance; graphify query measured returning a 60-node scoped subgraph). Answer for the ENFORCEMENT: no - all three `.claude/settings.json` hooks were dead on this host and had been for as long as the graphify reminders existed.

- **Measured, by replaying each declared command with its hook payload on stdin:** (a) `bash` on PATH resolves to WSL `C:\Windows\System32\bash.exe`; given a Windows path it dies with `/bin/bash: d:\...\session-start.sh: No such file or directory`, exit 127, so `bash "$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.sh"` never ran the SessionStart check; (b) even when bash started, `session-start.sh`'s own `cd "$CLAUDE_PROJECT_DIR" || exit 0` hit the same Windows path and exited 0 = silent no-op (this is why the 4-line env/DoD banner never appeared at session start); (c) both graphify PreToolUse hooks were inline `python3 -c` one-liners, and WSL bash could not parse their embedded `\"` quoting at all - `syntax error near unexpected token '('`, exit 127, no output. So "MANDATORY: run graphify before reading source files" was in CLAUDE.md, in every skill and in MEMORY.md and was injected into ZERO sessions.
- **Why nothing caught it: a hook that cannot run exits 0 and prints nothing - indistinguishable from a hook that passed.** And note which hooks broke: `rules-pointer`, `env-guard`, `verify-gate` are node modules with vitest suites and worked; the two graphify hooks were untestable inline shell strings. Testable -> working, untestable -> silently dead. That correlation is the lesson.
- **Second cause: CRLF.** `core.autocrlf=true` rewrote `session-start.sh` to CRLF on checkout; bash then rejects the file itself (`$'\r': command not found`, `set: pipefail: invalid option name`). Re-breaks on every fresh clone unless the repo pins it.
- **Fix:** `.claude/hooks/graphify-pointer.mjs` (both matchers, one tested module); `.claude/hooks/run-session-start.mjs` (Git Bash first - `C:\Program Files\Git\bin\bash.exe` is NOT on PATH - falls back to PATH bash, runs the script by RELATIVE path with cwd=repo root, STRIPS a Windows-shaped `CLAUDE_PROJECT_DIR` so the script's `dirname "$0"` fallback resolves, and never exits non-zero); `.gitattributes` with `*.sh text eol=lf`; settings.json diff = exactly 3 command lines, 0 `python3` left; 3 new vitest suites including `settings-hooks.replay.test.mjs`, which replays the commands declared in settings.json through the platform shell and asserts BOTH the emit and the silence boundary (that assertion is what makes it a guard rather than a demo).
- **Verified:** `cmd /c "node .claude\hooks\run-session-start.mjs"` prints the 4 env-check lines (previously exit 127); `node scratch_verify/hook_assert.mjs` 5/5 PASS; vitest full suite green.
- Env facts worth not rediscovering: `where bash` -> WSL bash then the WindowsApps stub (Git Bash absent from PATH); `node` is NOT reachable from that WSL bash (`command -v node` empty); `python3` is not on the Windows PATH either (use `python`, or `graphify-out/.graphify_python` - which has a UTF-8 BOM, so PowerShell/`Get-Content` form only).
- Ledger row: AF-20260915-08. Durable class: `.claude/rules/recurring-bugs.md` "Environment & deploy" (two new entries). Deep detail: external memory `hook_wiring_dead_on_windows_2026_09_15.md`.

**Still-open items re-checked (unchanged, with reasons):** DL engine rebuild/re-weight (user decision, AF-20260913-05); futures-OI basis factor (calendar - 13 dates, needs 20; the new f_so_pcr IC +0.068 strengthens the case); `so_option_chain` history depth (time, nothing to fix).
