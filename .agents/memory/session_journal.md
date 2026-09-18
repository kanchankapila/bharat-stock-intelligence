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

## 2026-09-17 — Pipeline audit closed with open findings

- Report: d:/Github/bharat-stock-intelligence/docs/data-pipeline-audit-2026-09-17.md; ledger AF-20260917-01..08. Audit/reporting complete, remediation unperformed; no application/production changes by this pass.
- Do not reinterpret 14 September holiday bars as a missed trading session. ALPSINDUS daily row already suspect, intraday absent. Do not purge 25 post-reference-exit rows without writer/exchange provenance and authoritative calendar checks.
- 16 September first retained intraday cycle 10:56:33 IST (22 total) is a latency symptom, not proof of missing cron: opening slot/market guard exist. Feature snapshot predates nightly arrivals; establish consumption watermarks rather than assuming fresh table maxima prove timely scoring.
- DoD FAIL: tsc 0; Vitest 1,383 passed/1 failed/44 skipped, signalOutcomesServiceSource.test.ts:6:1 beforeEach 10s timeout; pytest not run. No retries or fixes. Other sessions' passing runs do not supersede this evidence.
- Blockers: Evidence/Calendar for data repair and causal attribution; Sequential for isolated test diagnosis/full gate and subsequent implementation. Registry validated 13 September is not current endpoint health.


## 2026-09-17 (later) — "resolve all" pass on the 2026-09-17 audit findings

- Gate rerun GREEN on the inherited tree (tsc 0 / vitest 1,384+44sk / pytest 2,771+249sk) — the earlier signalOutcomesServiceSource timeout never reproduced (single, file, repeat, two-file reruns all ms-scale); a concurrent pg_stat_activity poller saw peak 6 conns, 0 lock waiters. A later full vitest run timed out in two DIFFERENT tests that then passed in isolation → environmental-under-load is the durable lesson; do NOT raise per-test/hook timeouts to mask it.
- Backup fix for AF-20260917-06 EXISTS but is NOT green-gated-landed: pg_dump in scripts/backup_pg.py now excludes pytest_*/vitest_* UUID schemas (patch parked in scratch/af20260917_06_backup_scope.patch, reapplied; focused pytest 2/2; live temp-DB A/B dump check with negative control in scratch/backup_scope_live_check.txt). OPEN: full DoD on this diff + a real backup/restore drill before closing AF-06.
- stock_scores refresh still unproven (AF-03); AF-01/02/04/05/07 unchanged. No findings closed. Never cite the ml-api restart as proof scoring recovered.

## 2026-09-17 (even later) — backup restore drill PASSED; AF-06 + AF-08 closed

- scripts/backup_pg.py pg_dump schema exclusions (pytest_*/vitest_* UUID-shaped) are now GATED (full DoD green on the diff) AND production-proven: real --force backup 4387.5MB TOC-verified (0 test-schema entries in 492 TABLE DATA rows), heartbeat success, then full restore drill into scratch db bharat_intel_drill: exit 0, empty stderr, 6/6 hypertables by name, exact row parity (stock_ohlcv 2,686,570 / technical_signals 121,823 / unified_recommendations 57,349), post_restore ok, drill db dropped. AF-20260917-06 CLOSED. AF-20260917-08 CLOSED (gate green twice; original vitest timeout never reproduced; environmental-under-load class measured with pg_stat_activity poller — never mask with raised timeouts).
- Durable ops lessons: (1) Windows `Get-ChildItem` shows 0 bytes for a file actively written by another process — read true size via open-handle seek before declaring a dump stuck; (2) pg_stat_activity: filter pg_dump/pg_restore by application_name, not query text; (3) TimescaleDB 2.30 chunk catalog is `_timescaledb_catalog.chunk`, and `timescaledb_information.hypertables` has no `table_name` column in this version; (4) comparing live catalog vs restored snapshot needs the dump's write-time TOC as arbiter — live schema drifts between dump and check.

- Do NOT treat a Vitest 5s testTimeout as a code defect: same file passes at ms-scale in isolation; reproduce under full-suite load before touching code, and never "fix" by editing timeouts.

## 2026-09-18 (close) — frontend modernization shipped: /deep-learning + /news

- Shipped: five-tab Deep Learning Intelligence page (predictions / model performance / market regime / feature attribution / prediction history — `src/components/DLIIntelligenceCenter.tsx`) and the News Intelligence hub (`NewsIntelligenceHub.tsx`), on the shared bsi-* design system with new primitives (`TabBar` with roving-tabindex keyboard support, `DataTable`, `MetricTile`, `ScoreRadial`, `DataHealthChip`, `KpiCounter`, `IntelligenceQueryError`) and `src/lib/intelligenceDisplay.ts` helpers. Routes `/deep-learning` and `/news` wired in `V1Routes.tsx` + `AppShell.tsx`; the Research sub-tab keeps the existing `DLDashboard`.
- Durable bug class (unit conventions — read the WRITER before rendering): `deep_learning_predictions.exp_ret_*d` is a fraction (dl_engine.py; render ×100, matching `DLPredictionCard`) while `actual_ret_*d`/`outcome_*d` are written in PERCENT by `outcome_resolver.py` (`(exit-entry)/entry*100`). The history tab initially double-scaled actual returns ("−217.13%" for a 5-day RELIANCE move); fixed with `percentPoint()` and pinned in `intelligenceDisplay.test.tsx`. Live browser verification against real rows+outcomes is what caught it — tsc and unit mocks were green throughout.
- Upstream news summaries can be full HTML (Google News RSS ships `<a href>…<font>Source</font>`): entity decoding alone is insufficient; `stripHtmlToText()` (strip tags → decode → collapse whitespace) now renders summaries. Everything stays React-escaped text; no `dangerouslySetInnerHTML` anywhere.
- Browser acceptance on the running app: 390px viewport no document-level overflow; TabBar ArrowRight/End move aria-selected AND focus with the panel following; RELIANCE 90-day history renders rows with outcomes; genuine empty states verified (no-prediction session; genuinely-empty 8h news window — distinct from error); fault-injected getNewsItems fetch rejection → role=alert QueryError + Try again → 200 cards recovered. Env gotcha: CDP Offline emulation does NOT block localhost, so error-path testing needs in-page fetch fault injection.
- Gate: tsc 0; `intelligenceDisplay.test.tsx` 9/9; full vitest 1,418 passed / 1 failed / 44 skipped — the 1 is `signalReadersTechnicalFold` 5s timeout under THREE concurrent vitest processes, green 3/3 in isolation immediately after, matching the known environmental-under-load class recorded 2026-09-17 (never mask with raised timeouts). pytest COMPLETED 2,799 passed / 0 failed / 249 skipped in 18:48 on the backend-python venv (warnings only, all inside negative controls).
- Env fact: VS Code shell integration can die mid-session (even `Write-Output` unobservable, and multi-line here-strings get mangled through the wrapper). Recovery pattern that worked: `Start-Process cmd /v:on /d /c "... & echo !errorlevel! > %TEMP%\x.exit" -WindowStyle Hidden -PassThru`, then read the `.exit`/`.log` files — completion evidence without a live shell. Prefer the file-editing tool over shell heredocs for memory/appends.
- Honesty note: the DLI Feature Attribution tab reports unavailability when the inference writer has stored no attribution (`dl_engine.py:1001` documents why) — the page never synthesizes explanations, scores, or zero-stands-in-for-missing values.


## 2026-09-18 — audit close-out round 2: alternate-source verification, block-deal history, two silent-misattribution fixes

- **A vitest test had DELETED two production tables, and nothing noticed for 21 days.**
  `npm run schema:drift` (run only to close an unrelated row) found `high_flyer_daily_stats` and
  `high_flyer_retrospective` in the snapshot but absent from live, while 15 files still read them
  — including a scheduled `ml-daily-ops` step and the daily Telegram accuracy digest.
  `signalAccuracyDigest.test.ts` drops exactly those two by name; `high_flyer_candidates` (same
  Python DDL block, never named in a test) survived, which is what pinned the attribution.
  **Durable tell: when a subsystem loses exactly the objects some test names and keeps the ones it
  doesn't, read the test — don't theorise.** Its only guard was a line-1
  `DATABASE_URL=':memory:'`, dead since the SQLite removal (2026-08-19). A guard written for an
  architecture that no longer exists reads exactly like a guard that works.
- **`db_compat.safe_alter(conn_or_none, ddl)` documented its first arg as "accepted and ignored"**
  and always opened its own connection — so ALTERs against a table created in the caller's still-open
  transaction failed and were swallowed into a `print()`. **That exact symptom had already been
  "fixed" in this helper on 2026-09-04 via a different root cause (a double `IF NOT EXISTS` regex).
  When a symptom returns to a function you already fixed, the prior fix being right is not evidence
  the cause is the same.**
- **A stale in-code `CREATE TABLE IF NOT EXISTS` silently undoes a migration on recreate** while
  `pgmigrations` keeps recording it as applied. Verify a column's type through `information_schema`,
  never through the migration ledger.
- **A vendor can drop ONE field and stay green everywhere.** `fundamentals_history.return_on_equity`
  decayed 86% → 6.1% over six weeks with no alert. Proof it is the vendor and not us costs one query:
  `fundamentalsSyncService.ts` reads `debtToEquity` and `returnOnEquity` from the SAME
  `financialData` object in the SAME response, and d/e reads 85%. **Find a sibling column from the
  same response and compare coverage before opening the fetcher.**
- **I reported "no in-repo ROE alternate is a drop-in" and that was WRONG** — I measured
  `investsights_factor_scores.roe` (0.7727, percent, sign flips) instead of
  `investsights_fundamentals_history.return_on_equity` (**Pearson 0.9608, same scale, ZERO sign
  flips**). Two tables from one vendor, two ROE definitions.
  `information_schema.columns WHERE column_name ILIKE '%roe%'` lists all four candidates in a second.
- **The constraint was our own cap, not the vendor.** That table held 288 symbols because of a
  `--limit 300` default whose comment said "widen once a real run's timing is known" — a measurement
  nobody had taken. Taken: **1000/1000 symbols in 129s, zero failures**. Coverage 287 → 929 symbols.
  **A self-documented placeholder cap is a deferred measurement, and it reads as "this source
  doesn't have the data" forever until someone runs it.**
- **Header isolation must start from the EMPTY set.** Probing NiftyTrader with
  `sec-fetch-site: same-site` returned 403 on all four routes — nearly reported as a vendor-wide
  regression. With NO headers at all: 200/25KB. `same-origin` is correct; the wrong VALUE lowered
  access. Starting from a "realistic browser header set" and subtracting hides this, because every
  variant carries the bad value. Also: **405 ≠ 401** — those screener routes are POST; only a POST
  with a real token proves the Prime gate.
- **Built `mc_block_deal_history_fetcher.py`** (NSE historical 503 on 30/30 dates). Live:
  **RELIANCE 0 → 32 rows**, 2,468 rows / 172 symbols back to 2024-08-26; HDFCBANK 36, ICICIBANK 28,
  INFY 24. Weekly, not daily — the endpoint returns full history every call.
- **62 of 2,340 `mcsymbol` codes are ambiguous** (`KMF → {KOTAK, KOTAKBANK, MAHINDRA}`), and two
  fetchers built the reverse map with a dict comprehension → silent misattribution on a Nifty 50
  name. This class was ALREADY documented and still got written twice, so the fix is a shared helper
  (`mc_symbol_map.py`), not another paragraph. Tell: `count(*)` vs `count(DISTINCT code)`.
- **The NiftyTrader live screener reported success on a total outage:** the missing-token path exits
  non-zero, but a token that is present-and-unentitled 401s every filter through the ordinary
  "failed filter" branch → nothing written, exit 0, summary printed to stdout where the stderr-only
  classifier cannot see it. Fixed, gated on "did anything land" not on a fail rate.
- **Process note on myself:** I committed `b140e26d` after re-running only the two test files I had
  touched instead of the full suite. Three vitest failures appeared in the next full run and did not
  reproduce (the documented under-load class — the isolated re-run is 1419/1419, and a concurrent
  session independently recorded the same signature the same day), but that shortcut is exactly what
  lets a real regression through.

## 2026-09-18 (afternoon) — the three "still open" items moved forward

- **pm2 autostart was never installed.** AF-20260917-14 credited 6 clean days to the fix; live, there
  was no scheduled task and nothing in Startup — the host just hadn't rebooted. The installer's
  logon-only retry sat outside any try, so it died having installed nothing. Third privilege-free
  rung added (per-user Startup `.cmd` → `pm2 resurrect`) and RUN; `dump.pm2` refreshed to 6 apps.
  **Before crediting a good metric to a fix, confirm the fix exists in the running system.**
- **Recovered ROE wired into the DL path only** (`_merge_fundamentals`, InvestSights fills NaN only,
  point-in-time on `fetched_date`). Safe because DL's blend weight is 0.0. The ensemble has seen
  ROE = 0 for ~94% of names since ~08-23 via `num('return_on_equity', 0)` — consistently in train and
  serve, so no skew today; swapping the source is folded into AF-20260913-07's retrain measurement.
- **09-18 is a Friday.** Weekend windows: `ml-weekly-data` Fri 23:30 IST, `ml-weekly-retrain` Sat
  09-19, `dl-retrain-weekly` Sun 09-20 (I had written "Sat 09-20" — re-read BullMQ, not the ledger).
  All retained retrain failures are orphans from mid-run restarts → no `.ts` changes this weekend.
- **Redis needs `REDIS_PASSWORD`** for any ad-hoc BullMQ inspection script (NOAUTH otherwise).
- A concurrent session's snapshot commit swept my staged batch into `e1db34b0` under a generic
  message — nothing lost, but check `git log` before assuming your staged files are still yours.

## 2026-09-18 (market hours) — full live_datasource run

- TS live 39/40 (the 1 was a Trendlyne timeout under concurrent load, 4.8s alone) + GDELT skip (retired).
- Python live: every non-pass was OURS. 28 errors = a UTF-8 BOM in `scripts/stocklist.json` since
  2026-09-12 (production immune only because its readers use `utf-8-sig`). 1 failure = a gated test
  hand-copying a renamed constant. 4 skips = tests probing retired/bare-session paths, hiding a
  stale `ensure_schema` DDL (2nd instance in 2 days).
- **Tells to reuse:** many vendors failing in the SAME few files at SETUP = a shared fixture;
  a skip that blames a holiday on a weekday = a dead canary (run `-rs` and read the reasons).
- **Live tests must call the fetcher's own entry point** (source chain / session factory / URL
  builder) — all three rotted tests today were copies that had drifted.
- **Guard design:** measure what a guard flags first. Full-column DDL scan = 42 hits (noise);
  PRIMARY-KEY scan = the 1 real defect. Shipped the PK one.
- Live tests write only to throwaway schemas via `pg_db_conn`/`pg_memory_conn`, so running them
  during market hours is safe — but don't run them concurrently with the full suite (connection race).
