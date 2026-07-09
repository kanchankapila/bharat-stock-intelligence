## Audit Findings — Infrastructure/Plumbing Slice (`src/server/`)

Read all 23 files in scope. Grepped for swallowed-error patterns, unguarded timers, and the three specific historical-incident classes. `queues.ts` (2778 lines) required chunked reading; findings below trace to specific process functions and worker registrations.

### CRASH

- `src/server/websocketService.ts:79-89` | CRASH | The `pingTimer` `setInterval` callback calls `ws.ping()`/`ws.terminate()` on every connected client with no try/catch around the loop body; `ws.ping()` throws synchronously if a socket's `readyState` has flipped to `CONNECTING`/`CLOSED` between the iteration check and the call (a real race under many concurrent clients). An uncaught throw here brings down the whole Node process — the same failure shape as the documented 49-hour crash-loop. Fix: wrap the loop body (or each `ping()`/`terminate()` call) in try/catch and drop the client on error instead of propagating.

### SILENT

- `src/server/queues.ts:2254-2268` | SILENT | The `trendlyne-daily-fetch` worker (`QUEUE_TRENDLYNE_DAILY_FETCH`, cron `30 4 * * 1-5`) never calls `recordHeartbeat`/`updateMonitorState`, and `'trendlyne-daily-fetch'` appears in neither `JOB_REGISTRY` (`jobRegistry.ts`) nor as a `queueName` in `MONITOR_SCRIPTS` (`monitorScripts.ts`) — confirmed both by direct grep. If this job fails silently for weeks (Trendlyne API change, rate limit, etc.) there is zero observability: no Telegram alert, no daily digest line, no staleness detection — exactly the undetected-staleness shape of the original `stock_scores` incident. Fix: add a `recordHeartbeat` call in the worker's `completed`/`failed` handlers and an entry in `JOB_REGISTRY`.

- `src/server/queues.ts:429-701` (`processMlDailyOps`) and `:776-823` (`processMlWeeklyRetrain`) | SILENT | ~50 Python sub-steps are each wrapped in `.catch(e => console.warn(...))` and the outer function unconditionally returns `{ success: true }`. If every sub-script fails (e.g. shared outage), `job_heartbeat` still records `'success'` for `ml-daily-ops`/`ml-weekly-retrain`, masking a total failure at the job level. Largely mitigated by per-effect `MONITOR_SCRIPTS` freshness checks downstream, but coverage across all ~50 steps isn't verified, so a step lacking a downstream freshness check could regress silently for a long time. Consider tracking a partial-failure count and downgrading `recordHeartbeat` to `'failed'`/`'degraded'` when more than N sub-steps error.

- `src/server/pgConfig.ts:14` | SILENT | `PG_CONFIG.host` falls back to `'localhost'` (not `'127.0.0.1'`) when `POSTGRES_HOST`/`POSTGRES_URL` are unset — precisely the class of bug from the memory note "Windows 11 localhost→::1 kills ALL Python→Postgres connections." `envConfig.ts:30-35` FATAL-exits if `USE_POSTGRES=true` and neither var is set, mitigating the risk, but it only checks *presence*, not that the value isn't itself `'localhost'` — a future `.env` edit (`POSTGRES_HOST=localhost`) would pass validation and reintroduce the bug. Fix: default to `'127.0.0.1'` instead of `'localhost'`, matching `.env`'s current explicit value.

- `src/server/redisConfig.ts:2` | SILENT | Same `'localhost'` fallback pattern for `REDIS_BASE.host` (`.env` also sets `REDIS_HOST=localhost` currently). Lower severity since `cacheService.ts` has a full in-memory fallback, but BullMQ (`queues.ts`) has no such fallback for its Redis connection — an IPv6 resolution issue here would silently drop the app into the `setInterval` degraded mode (`queues.ts:2582-2622`) rather than crashing, which is itself easy to miss in logs.

### MINOR

- `src/server/db.ts:20` and `:2391` | MINOR | The Postgres-mode guard is duplicated inline as `!process.env.USE_POSTGRES || process.env.USE_POSTGRES === 'false'` instead of importing `usePostgres()` from `pgConfig.ts`. Currently harmless only because `envConfig.ts` fatals on any value other than exactly `'true'`/`'false'`/unset, but it's a DRY violation that could silently diverge (reintroducing the split-brain SQLite-write pattern) if that validation is ever relaxed or the two checks edited independently. Fix: import and reuse `usePostgres()`.

- `src/server/queues.ts:439-440,447-448,666,818-819,978` | MINOR | Several `runPython(...)` calls use `.catch(() => {})` with zero logging (e.g. `fii_dii_fetcher.py`, `pcr_fetcher.py`, `institutional_quant_engine.py`, `finbert_scorer.py`, `online_learner.py`, `strategy_optimizer.py`, `backtester.py`), unlike sibling calls in the same functions that at least `console.warn` the error. Failures here leave no trace anywhere (not even a log line), making root-causing a stale downstream table harder than it needs to be. Fix: standardize on the `console.warn` pattern used elsewhere in the same functions.

### Not reproduced (checked and clean)

- No handler returns `{success:false}` without throwing — the specific `stock_scores`-staleness pattern (`processStockScoring`, `queues.ts:312-317`) now correctly throws.
- `jobHeartbeat.ts`/`jobWatchdog.ts` are robust: every public function and both `setInterval` callbacks are wrapped in try/catch, and `getLateJobs` explicitly forces `tz: 'Etc/UTC'` — matches the fix noted in memory for the 49-hour crash-loop.
- `db.ts`'s two `setInterval`-driven SQLite writers (WAL checkpoint, `confluence_signals` pruning) are both correctly gated on `USE_POSTGRES` and don't run in Postgres mode.
