---
paths:
  - "**/*.test.{ts,tsx,mjs}"
  - "**/tests/**"
  - "**/__tests__/**"
  - "**/conftest.py"
  - "src/server/pg_test_support.py"
  - "vite.config.ts"
  - "vitest.*.ts"
  - ".claude/hooks/**"
  - ".github/**"
  - "package.json"
  - "{,backend-python/}requirements*.txt"
  - "ecosystem.config.cjs"
  - "scripts/*.ps1"
  - "scripts/sql.py"
  - "src/server/pyboot/**"
  - "src/server/pythonRunner.ts"
  - ".gitattributes"
---
# Testing, environment & deploy bug classes

Split out of `recurring-bugs.md` (the index) on 2026-09-26 so each area loads only when you touch matching files. Same rules as the index: every class here has recurred; **🤖** = enforced by `scripts/check_recurring_bugs.py`; forensic detail in `docs/recurring-bugs-history.md`.

## Investigating production without breaking it

- **A client-side timeout does NOT cancel the server-side query — it orphans it**, and on a big table that orphan can hold a lock that blocks the whole platform for hours, which then gets misdiagnosed as a storage-engine cost problem. Diagnose lock contention (`pg_stat_activity`, `wait_event_type = 'Lock'`) before theorizing about decompression/storage cost — a query "hanging" on one specific table while others respond normally is lock contention until proven otherwise. Prevent it with a server-side `SET LOCAL statement_timeout`, not a client-side `timeout` wrapper.

- **Matching a `pg_stat_activity` row to a suspected-orphan bug BY QUERY TEXT ALONE, without checking its `query_start` against wall-clock time, can kill the wrong connection — including the very job you're trying to unblock.** 2026-08-30: a genuinely orphaned `idle in transaction` connection from an earlier killed script (matching the exact bug class above) was found and `pg_terminate_backend()`'d — but a SECOND `pg_stat_activity` snapshot, taken right after relaunching the real job, showed another `idle in transaction` row with the same `INSERT INTO feature_store...` query text and a `duration` that read as suspiciously small (single-digit/negative milliseconds from a JS `now() - query_start` computation). That row was pattern-matched to "another instance of the same orphan bug" and killed too — except a near-zero duration is the opposite signal: it meant the transaction had JUST started, i.e. it was the newly-launched legitimate job's own connection caught mid-batch between commits, not a stale orphan. Killing it crashed the job (`sqlalchemy.exc.PendingRollbackError: Can't reconnect until invalid transaction is rolled back`). No data was lost (the writes were `ON CONFLICT DO UPDATE`, so already-committed rows survived), but the job had to be restarted from scratch. **Tell:** `idle in transaction` alone is not evidence of an orphan — a live batch job legitimately sits `idle in transaction` between statements while accumulating a batch before its next `commit()`. Before terminating any backend PID, cross-check `query_start` against `now()` on the SAME query (not two separate snapshots minutes apart) and prefer `pg_blocking_pids(pid)` / a `wait_event_type = 'Lock'` read on some OTHER session to confirm something is actually blocked ON this connection, not just that this connection's query text looks familiar.
- **A migration's own "files remaining" progress counter cannot count the files it never reaches** — derive coverage counts from the source tree (`grep -rl`), never from the instrument measuring its own coverage.
- **A test that WRITES through one engine (a raw driver) and READS through another (an app-level facade) asserts nothing**, and stays green as long as both happen to land on the same backend. Pick one; if the code under test uses the facade, the fixture must too.
- **Moving a test substrate onto the real dialect is not fixture churn — budget for real production bugs it will surface**, because the old substrate structurally could not fail on them (wrong column names, wrong PK assumptions, methods the driver doesn't support all passed silently under a more forgiving engine).
- **A test parser that reads another file by hardcoded PATH and swallows the read error (`except OSError: continue`) degrades silently**, and the failure surfaces somewhere unrelated with a message that reads like a different bug entirely. Assert the file exists; don't silently continue on a missing input.
- **A schema DDL file that qualifies some statements to a schema but not others (e.g. indexes but not `CREATE TABLE`) creates tables where you point it and then indexes production's copy** when applied anywhere but the default schema. Schema-qualify everything or assert nothing outside the target schema was touched.

## Automated bulk-edit passes

- **A script that injects the same lines into hundreds of files will land them in the wrong
  place in a handful, and the wrong place is not distributed evenly -- it clusters on the files
  with an unusual header.** A 2026-08-28 pass inserted `import polars as pl` at absolute line 1
  of ~200 `src/server/*.py`. In 17 files that put it ABOVE the shebang (making `#!` inert), and
  in `event_triggers.py` it pushed `from __future__ import annotations` out of first-statement
  position -- a hard `SyntaxError` that failed pytest at COLLECTION, so **the entire suite ran
  zero tests while the session-log recorded it as "running green."** In one more
  (`investsights_fundamentals_fetcher.py`) the injected class block landed INSIDE the module
  docstring, where it is inert text that no import error ever reports.
  **Tells, in the order they are cheap to check:** (1) `py_compile` every file the pass touched
  -- not a sampled few, and note that `pytest -q`'s summary line does NOT distinguish "collected
  and passed" from "aborted during collection", so read for `Interrupted:`/`ERROR collecting`
  specifically; (2) `head -1` every touched file and confirm nothing precedes a `#!`;
  (3) AST-walk for the injected symbol rather than grepping for it -- a grep matches the copy
  sitting dead inside a docstring, an `ast.ImportFrom` walk does not.
- **An import-time dependency added by a bulk pass must be declared where CI installs from, and
  in this repo that is `backend-python/requirements.txt`, NOT the repo-root `requirements.txt`.**
  The same pass made `polars`/`tenacity` import-time deps of ~200 modules and declared them only
  at the root, so every one of them would `ModuleNotFoundError` on a clean checkout while passing
  locally purely because the dev venv already had both. Sibling of "Declared != installed" below,
  inverted: installed where you are testing, undeclared where it runs.
- **"Onboarded N files" is a count of files EDITED, never of capability delivered -- verify the
  injected construct is actually reachable before recording it as done.** The same pass added a
  `BaseFetcher` subclass to 74 fetchers and a `WorkflowDAG` import to 37 engines; measured
  afterwards, **zero of the 74 classes were instantiated, `@governed_fetcher` decorated zero
  functions, zero DAGs were built, and the injected `to_polars_df` helper had zero call sites
  across all 199 copies.** Nothing behaved differently than before the pass. The check is one
  grep per construct (instantiation, decorator application, call site) -- and it is the
  difference between scaffolding and a feature. Same family as ml-model-bugs.md's
  "evidence-shaped output" class, in bulk-refactor form.

- **A test that locates a value in SOURCE TEXT by character distance from a marker breaks when
  you add a COMMENT — and the failure names the source, not your comment.**
  `jobRegistryGraceMinutesConsistency.test.ts` finds each job's `lockDuration` by scanning
  forward from the first occurrence of its jobName marker, capped at `MAX_LOOKAHEAD = 4000`
  chars. Adding a 3-line explanatory comment INSIDE `addJobWithCatchup(regimeQueue, ...)`'s opts
  object pushed `'regime-intraday'` -> `lockDuration` from 3933 to 4189 and failed two cases with
  "no lockDuration found near marker ... source shape may have changed" (CI 2026-08-31). Nothing
  about the behaviour changed; only the whitespace between two tokens did.
  **Second instance in this file** — `queues.ts` already carries an inline warning about the
  same hazard for the `'ml-daily-ops'` marker, which is what makes this a class and not an
  accident. It was documented, read, and walked into anyway.
  **Two traps when fixing it, both hit here on the first attempt (which made it WORSE, 4646):**
  (1) moving the comment ABOVE the call is the right fix — text before the marker costs zero
  distance — but (2) if your new comment QUOTES the marker string, the comment becomes the
  FIRST occurrence and moves the search origin earlier, which is worse than where you started.
  The test's own docstring warns about a stray reference to the same string; that warning applies
  to comments you add while fixing it. Refer to the marker descriptively, and assert the literal
  still appears exactly the expected number of times.
  **Margins here are thin by nature** (~100 chars after the fix; only 67 on main beforehand), so
  measure rather than eyeball: compute `src.indexOf(marker)` and the nearest `lockDuration` match
  offset directly, and compare against the pre-change baseline from `git show <ref>:<file>` — not
  merely against the cap, or you will land back at the edge without noticing.
  **How it reached CI:** the comment edits were followed by `tsc --noEmit` only. CLAUDE.md
  requires vitest for ANY `.ts` change, and the green vitest run being relied on predated the
  edits. A typecheck cannot see a source-text-parsing test. **Re-run the suite after the LAST
  edit, not after the last edit you considered risky** — this one looked like a pure comment.
## Environment & deploy

- **Declared ≠ installed.** A dependency in `package.json`/`requirements.txt` but not actually installed silently breaks a live job for days.
- **On Windows `pip` cannot upgrade a package whose `.pyd` a running service holds open (`[WinError 5] Access is denied`), and an interrupted upgrade leaves `~pkg` + `~pkg-x.y.dist-info` that make `pip check` call a working package "not installed".** Found 2026-09-25 (AF-20260925-01): `websockets` 16.0 files present, metadata half-removed, held by a uvicorn service. pip rolls back cleanly (verify with `pip freeze` diff), so a failed attempt is safe but useless — aligning the venv needs the four venv services (`ml-api`, `chatbot`, `alphaquant-api`, `engine-worker`) stopped first. Also: the manifest can be the one that is wrong — `curl_cffi` was pinned OLDER (0.15.0) than what production runs (0.16.2); check installed-vs-pinned direction before "aligning", and never downgrade a TLS-fingerprint library on a hunch.
- **SQLite-era SQL that Postgres rejects, inside a bare `except`, reads as "no data" for weeks:** a SELECT alias used in `HAVING`/`WHERE` (`HAVING total_news >= 3`), a non-aggregated column beside `GROUP BY`, `ROUND(double, int)`, and column names that only existed on the old schema (`auc`/`accuracy`/`created_at` vs `cv_roc_auc`/`cv_accuracy`/`trained_at`). Three chatbot tools were dead this way (AF-20260925-05) with a green suite. Immunise with a connection proxy that records failed statements, call EVERY function and EVERY branch on the real production schema (`pg_db_conn`), assert zero failures, and negative-control against `HEAD`. **Hypertable "latest row per symbol" (`MAX(ts) GROUP BY symbol`) must be time-bounded on BOTH the subquery and the outer scan** — bounding only the subquery still walked every chunk (>60s); bounded on both it is 0.3-0.7s. Always set a server-side `SET statement_timeout` on probes: a client-side timeout leaves an orphaned scan loading the shared DB.
- **Written ≠ applied.** A migration verified against a throwaway cluster is not applied to production. Confirm `npm run migrate:up` ran against the real `POSTGRES_URL`.
- **Committed ≠ deployed.** `.ts` is not hot-reloaded; `pm2 restart bharat-server` is required. Check `pm_uptime` against the fix commit's timestamp.
- **pm2 on Windows watches the PID it LAUNCHED, and here that is never the real process — so
  `max_memory_restart` and `node_args` silently apply to a wrapper.** `venv\Scripts\python.exe` is
  a redirector that spawns the real interpreter; `tsx`'s CLI spawns a child node. Measured
  2026-09-11: pm2 reported 1MB per Python service while the real interpreters held 2.0-2.6GB
  private, and 18MB for bharat-server whose real node held 0.7GB without the
  `--max-old-space-size` flag (the default V8 limit, 4,288MB here, is the cap that actually
  applies). And `runPython` children are invisible to pm2 entirely — which is how dl_trainer
  reached 38-52.7GB commit and killed the WSL2 VM three times. **Tell:** `pm2 list` memory in the
  single-digit MB for a process that imports torch. **The ceiling that works is kernel-enforced on
  the real process:** `src/server/pyboot/sitecustomize.py` (Windows Job Object, whole process
  tree) — on every runPython child via `pythonRunner.ts` (`PY_CHILD_MEM_LIMIT_MB`, default
  20480, observe-first until measured peaks justify tightening) and on the four Python services
  via `ecosystem.config.cjs`'s `pyService` env. Every
  runPython run now logs `peakMemMb`; set ceilings from those, not from estimates.
- **Registered ≠ running, for a pm2 `cron_restart` job specifically.** `pm2 start` launches it immediately once regardless of schedule; if that first launch fails (dependency not up yet), it settles into `stopped`/`pid 0` and waits for its NEXT cron slot with zero retries — up to 7 days of silent dormancy for a weekly job, indistinguishable in `pm2 list` from healthy idling. Check `pm2 describe <name>` / `pm2 logs` for the actual last failure before concluding "no scheduler exists." After fixing the underlying cause, a `cron_restart` job does not self-heal — `pm2 restart <name>` manually.
- **A standalone script that imports the DB facade without loading `.env` can silently talk to the wrong backend and print convincing wrong numbers.** Print the resolved connection target and assert a row count against a number you already know from a trusted client before believing an ad hoc script's output. (Structurally closed here 2026-08-15 — `usePostgres()`/`use_postgres()` now default to Postgres unconditionally with no env-var override for any real process, so this specific failure mode is history; the general lesson — verify the connection before trusting the result — still applies to any future default-selection logic.)
- **A server that binds its port LAST will restart forever on `EADDRINUSE` without pm2 ever detecting instability**, if the crash happens after `min_uptime` has already elapsed (e.g. after initializing other services first). Attach an explicit error handler to the listener so a bind failure surfaces immediately instead of escalating through generic exception handling with the real cause buried in noise.
- **A manual `UPDATE app_settings` is not a fix** — it reverts on any fresh DB and is invisible to every other environment. Seed it in a migration.
- **Deleting a thing does not delete the checks and instructions that point at it — and an orphaned check does not go quiet, it starts emitting false signals in the opposite direction.** Grep the removed identifier across `.md`, `.claude/commands/`, `.claude/skills/`, and validator/bootstrap code whenever you remove an env var, column, file, or fallback — a stale check can crash a correct process, or a freshness check pointed at a superseded table can warn on every run forever while the table nothing reads sits there as the actual bug. **Tell for the latter:** a freshness check that has NEVER passed is more likely watching an abandoned table than reporting a real outage — grep who actually reads the table before fixing the fetcher.

- **A hook that cannot run exits 0 and prints nothing — indistinguishable from a hook that passed.** Measured 2026-09-15: all three `.claude/settings.json` hook commands were dead on this Windows host. `bash` on PATH resolves to WSL's `bash.exe`, which cannot open a Windows path (`/bin/bash: d:\Github\...\session-start.sh: No such file or directory`, exit 127), and where it did start, `session-start.sh`'s own `cd "$CLAUDE_PROJECT_DIR" || exit 0` hit the same mismatch and exited 0 — so the session-start environment/Definition-of-done check and both `graphify` PreToolUse reminders were documented in `CLAUDE.md` and every skill while enforcing nothing. **The two graphify hooks were inline bash one-liners wrapping `python3`**, and WSL bash could not parse their embedded `\"` quoting at all (`syntax error near unexpected token '('`, exit 127). **Tell:** a rule stated in three separate places with zero observed effect; test the hook by replaying its declared command with the payload on stdin and asserting stdout (`npx vitest run .claude/hooks/settings-hooks.replay.test.mjs`). Fix: a hook must be a `node .claude/hooks/*.mjs` module with a vitest suite beside it (the repo's other three already were — the two that broke were the two without tests), and a shell script it calls must be launched by a bash that resolves the repo (Git Bash) with a RELATIVE path from the repo root, never through `$CLAUDE_PROJECT_DIR`, which is a Windows path. A hook must never exit non-zero: bricking a session is worse than the problem it reports.
- **Windows PowerShell 5.1 writes a UTF-8 BOM, and a BOM in a JSON data file breaks every reader
  that isn't defensively coded -- while the defensive ones make it invisible.** 2026-09-18
  (AF-20260918-03): `scripts/stocklist.json`, the provider-mapping master, gained `EF BB BF` in
  commit `d6d39566` (2026-09-12) and kept it for six days. Every production fetcher reads it via
  helpers using `encoding="utf-8-sig"`, so production was fine and nothing alerted; everything
  reading plain `utf-8` broke -- 28 live_datasource tests across 9 vendors errored at SETUP, and the
  mapping-regeneration scripts in `scripts/` would have failed on their next run. Node's
  `JSON.parse` rejects a BOM too; RFC 8259 forbids one.
  **Attribution tell: many unrelated vendors failing in the SAME few files at SETUP is a shared
  fixture, not the vendors.** Group errors by message before reading any of them.
  **Fix the file, not the readers** -- converting readers to `utf-8-sig` one by one is the
  per-call-site guard class. From PowerShell 5.1 write BOM-less with
  `[IO.File]::WriteAllText($p, $text, [Text.UTF8Encoding]::new($false))`; `Set-Content -Encoding
  utf8` and `Out-File -Encoding utf8` both add one. Guarded by
  `src/server/tests/test_json_files_have_no_bom.py` (derived from `git ls-files '*.json'`).
  Same family as the `.graphify_python` BOM noted in memory and the CRLF entry below: Windows
  tooling silently changing bytes that other tools treat as content.

- **CRLF from a Windows checkout breaks every bash script under `.claude/hooks/`.** git's `core.autocrlf=true` rewrote `session-start.sh` to CRLF on checkout, so bash rejected it outright (`$'\r': command not found`, `set: pipefail: invalid option name`) — and the failure re-appears on every fresh clone until the repository pins it. `* text=auto` (if previously set) does not survive: the file must be pinned `*.sh text eol=lf` in `.gitattributes`, and re-normalized in the working copy (`scratch_verify/lf_fix.py`). `.mjs` hooks are immune (node tolerates CRLF); this is why hooks here should be node modules.

## Testing

- **A warning printed by a test runner is not a verdict — CI and hooks read the EXIT CODE.** A suite that skips everything it can't reach (e.g. no DB) and still exits 0 is advisory-only to any automation consuming it; flip the exit code non-zero when a test was skipped for a reason that shouldn't be silently tolerated (e.g. an unreachable required dependency).
- **A live test that SKIPS when its source is empty stops testing anything the day that source
  retires -- and the skip reason ("holiday or blocked") keeps it looking benign forever.**
  2026-09-18 (AF-20260918-05): four tests skipped on every run. The bulk-deals test probed only
  the NSE routes, which had retired, while production had moved to a MoneyControl fallback that
  no test covered; the rollover test built a bare `requests.Session()` that nsearchives refuses,
  while the fetcher (with a Referer) wrote 210 symbols a day. Behind the permanent skip sat a real
  defect (stale DDL, above) and a read-back from the wrong table that had never executed.
  **Two rules fall out.** (1) A live test must call the fetcher's OWN entry point -- its source
  chain, its session factory, its URL builder -- never a copy; every case today was a copy that
  had drifted (`TODAY_PLUS_14`, the NSE-only chain, the bare session). (2) On a trading day an
  empty source is a FAILURE, not a skip; reserve skips for genuinely closed-market conditions.
  **Tell:** `SKIPPED` lines whose reason blames a holiday on a weekday -- run with `-rs` and read
  them, a skip count alone says nothing.
- **A `live_datasource`-gated test is code that DOES NOT RUN by default, so it rots silently** — the gate must stay (a third-party outage must never redden CI), but treat these files as needing a periodic manual full run, and after any bulk change touching test fixtures, explicitly check which of the gated files it did not execute. A stub that dispatches on its input (not a blanket return) fails loudly on an unexpected call instead of confidently answering with someone else's data.
- **An unqualified `information_schema.columns`/`information_schema.tables` query can silently read a leaked throwaway test schema as a second copy of a real table**, producing duplicate column names that break downstream code with an error naming no table or schema. 🤖 Automated — `check_information_schema_missing_table_schema`. Fix: `AND table_schema = current_schema()`, not a hardcoded `'public'` (which breaks inside test fixtures that deliberately scope into their own schema).
- **A throwaway-schema fixture that keeps `public` on the `search_path` reaches PRODUCTION for every name the fixture forgot to create — and on a busy table the ACCESS EXCLUSIVE LOCK, not the DDL, is the damage.** Caught live 2026-09-17 (AF-20260917-11): `conftest.py`'s `pg_schema` used `SET search_path TO "<throwaway>", public` under a comment asserting "the throwaway schema is FIRST, so an unqualified name can only ever shadow a production table, never write to one." **"First" only protects a name the schema HAS.** A test whose schema held 2 tables ran `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS …` against `public.technical_signals`; the column already existed so the DDL was a no-op, but the queued ACCESS EXCLUSIVE lock — stuck behind the nightly `pg_dump` — blocked **every subsequent reader** of the platform's main feature table for minutes. An `IF NOT EXISTS` that changes nothing still takes the lock. **Two tells, both cheap:** (1) `SHOW search_path` in the fixture — if `public` is on it, the isolation is partial by construction; (2) in `pg_stat_activity`, a DDL statement whose backend has a `t_`/`pytest_` search_path but whose target table is not in that schema. **The meta-lesson is the one this file already states in the comments-vs-guards entry**: the sibling fixture `pg_test_support.pg_memory_conn()` omitted `public` and documented exactly this hazard, and `CLAUDE.md` said `pg_conn` "puts `public` on the search_path, so a table the fixture forgot silently resolves to the real one" — three sources, two of them right, and the wrong one was the one sitting next to the code. When two places describe the same guard incompatibly, believe neither until you run the probe. Immunized by `src/server/tests/test_pg_schema_isolation.py`, whose negative control is that `SELECT 1 FROM technical_signals` **does not raise** against the unfixed fixture.

- **Negative-control every new test**: revert the fix, confirm the test fails, restore. Suites here have been 100% green while protecting nothing.
- **A test that reimplements the logic under test** (hand-copies the resolution logic into the test file instead of importing it) passes against the unfixed source, because the mirror never sees the fix or the bug. Call the real function.
- **A test that derives its expectation from the constant it is testing** passes vacuously (`all([])` is `True`).
- **A test that relies on a library's inferred default to manufacture its own precondition** silently stops testing anything when the library changes its default. Construct the condition explicitly.
- **Env vars a shared facade reads are shared state across a test worker process** — a static top-level `import`/env-set in one test file can pollute every other test file sharing that worker, even in a suite that's itself skipped. Guard any real-credential-loading import inside the same conditional that gates the suite, never as a static top-level import.
- **A config env var a library snapshots at IMPORT time is a no-op if set after the import, and the obvious test for it passes against the broken ordering** — `os.environ["X"] == "1"` after import passes whether or not the setting took effect if a `setdefault` was used. Assert the library's own resolved constant (in a clean subprocess), not `os.environ`.
- **A guard test built on a hand-enumerated allowlist only guards what someone remembered to list.** Derive the list from the source tree (scan for the pattern and assert the scan equals the allowlist) so a new instance fails the test instead of silently slipping through.
- **A tokenizer/AST-based check whose logic silently depends on which Python version parses it** (e.g. PEP 701 f-string tokenization changed in 3.12) can pass on a dev venv and fail on CI with neither side erroring. Keep a local venv matching CI's actual interpreter version for testing changes to any such check; write the check's own emptiness self-test (assert it finds what it's meant to guard) so a silent 0-matches failure mode can't hide behind a merely-passing suite.
- **A daily job's output read before its upstream landed looks exactly like broken wiring.** feature_store's latest-day rows showed pcr_oi 3.5% / delivery/fii/max_pain 0% while the same joins measured 78-100% over the prior week - the refresh (17:26 IST) simply ran before the option-chain/PCR writers (18:30 IST), and a holiday removed the T-1 source entirely (NULLs are NEVER_FILL semantics, not a defect). Coverage verdicts need a WINDOW of dates plus an upstream max(date) cross-check, never the latest day alone; after upstream lands, a same-day targeted rebuild (`feature_engineering.py --date today`) repairs the rows.
- **A legacy display-format TEXT date column twinned with a parsed ISO column poisons every ad-hoc max(date)/min(date).** insider_trades `date` held '31 Oct, 2025' display strings beside ISO rows, so string sort made the table read 10.5 months stale in three separate audits while `date_iso` (the column every reader actually uses) was fresh. When a table carries both, normalize the display column to ISO at the writer AND backfill the rows; update any test that pins the display format - the pin is the bug.
