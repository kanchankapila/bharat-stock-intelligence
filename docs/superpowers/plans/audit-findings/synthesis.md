# Codebase Health Audit — Synthesis

Merged from agent-a (TS API/router), agent-b (TS infra/plumbing), agent-c (TS business/services), agent-d (Python fetchers), agent-e (Python scoring/ML/backtesting core). Classified per the plan's Global Constraints fix policy: auto-fix = compile/type errors, unhandled exceptions, swallowed-error anti-patterns, obvious logic bugs; flag = scoring math, trading thresholds, DB writes/schema, or a behavioral judgment call.

## Auto-fix (34 items)

### TS — surface swallowed errors / add logging (no behavior change to return values)
- `src/server/routers/ml.router.ts:301` — `runFullBacktest`: throw `TRPCError` on failure instead of returning a same-shaped `{message}`.
- `src/server/routers/ml.router.ts:320` — `optimizeScreenerWeights`: same fix.
- `src/server/routers/technicals.router.ts:225` — `getTvTa`: throw instead of returning `{error}`.
- `src/server/routers/technicals.router.ts:234` — `getTvScreener`: same fix.
- `src/server/routers/misc.router.ts:191` — `analyzePortfolio`: throw instead of returning `{error}`.
- `src/server/routers/telegram.router.ts:25,47,59,74,97` — add `console.error` before returning config defaults on catch.
- `src/server/routers/trendlyne.router.ts:86` — `getTrendlyneHealth`: add `console.error` before returning failure shape.
- `src/server/routers/market.router.ts:75` — `getMarketOverview`: add `console.error` inside the bare `catch {}`.
- `src/server/routers/commandCenter.router.ts:89` — add `console.error` inside the schema-drift catch.
- `src/server/routers/misc.router.ts:44` — log malformed `detected_patterns` JSON instead of silent drop.
- `src/server/mcApiService.ts:344` — log first 200 chars of response body on JSON parse failure instead of silent `null`.

### TS — crash prevention
- `src/server/websocketService.ts:79-89` — wrap the `pingTimer` loop body (or each `ws.ping()`/`ws.terminate()` call) in try/catch so a stale socket can't crash the Node process.

### TS — DB connection safety (matches documented IPv6/localhost incident class)
- `src/server/pgConfig.ts:14` — default `host` to `'127.0.0.1'` instead of `'localhost'`.
- `src/server/redisConfig.ts:2` — same default change for `REDIS_BASE.host`.
- `src/server/db.ts:20,2391` — replace inline `!process.env.USE_POSTGRES || ...` duplication with the existing `usePostgres()` helper from `pgConfig.ts`.

### TS — job observability (mechanical, follows existing sibling pattern in the same file)
- `src/server/queues.ts:2254-2268` — add `recordHeartbeat` calls to the `trendlyne-daily-fetch` worker's `completed`/`failed` handlers, and register it in `jobRegistry.ts`'s `JOB_REGISTRY`, following the pattern already used by every other queue worker in this file.
- `src/server/queues.ts:439-440,447-448,666,818-819,978` — replace bare `.catch(() => {})` with `.catch(e => console.warn(...))`, matching sibling `runPython(...)` calls in the same functions.

### TS — missing request timeouts (mechanical, matches this codebase's `AbortSignal.timeout(10000)` convention used elsewhere in each of these same files)
- `src/server/insightService.ts:244` — add timeout (keep existing fallback logic as-is; see Flagged section for the fabricated-data question).
- `src/server/stockMapping.ts:54`
- `src/server/fnoService.ts:191,282`
- `src/server/marketIntelService.ts:463,476,501,531,578`
- `src/server/niftytraderService.ts:65,70,75`
- `src/server/topMoversService.ts:30`
- `src/server/globalMarketService.ts:22`
- `src/server/technicalSignalsService.ts:909,999`
- `src/server/marketData.ts:24,61,73,189,244,288,315,355`
- `src/server/etnow.ts:94`
- `src/server/ollamaManager.ts:10` — short timeout (2000-3000ms; this is a health-check, not a data fetch)
- `src/server/scoringService.ts:229` — add `console.warn` in the `catch {}` around malformed `records_json`.

### Python — date-binding correctness bugs (matches documented rule: Postgres DATE columns need `datetime.date` objects, not strings)
- `src/server/insider_transactions_fetcher.py:265,282` — bind `date.today() - timedelta(days=days)` directly; drop `.isoformat()`.
- `src/server/delivery_volume_fetcher.py:119,134-138` — bind `trade_date` directly; drop `.isoformat()`.

### Python — swallowed-exception logging (add a log line before existing fallback; fallback behavior unchanged)
- `src/server/mc_advance_decline_fetcher.py:73-79` — log the unparseable date string before defaulting to today.
- `src/server/nt_pcr_ts_fetcher.py:63-73` — log before falling back to the hardcoded `_FALLBACK` index map.
- `src/server/nt_change_oi_fetcher.py:66-68` — same fix.
- `src/server/nt_oi_snapshot_fetcher.py:76-78` — same fix.
- `src/server/unified_ranker.py:468-531` — add `print(f"... failed: {e}")` in the six `_get_*_scores` exception handlers, matching the existing pattern already used at line 432 (`_get_screener_membership`) in the same file. Logging only — fallback return values (`{}`/`0.0`) unchanged.
- `src/server/strategy_optimizer.py:317-324` — narrow bare `except:` to `except requests.RequestException:` around the fire-and-forget notification POST.

### Python — dry-run flag correctness (operator-intent bugs: `--dry-run` currently doesn't prevent writes)
- `src/server/ml_ensemble.py:2636-2659` — thread `dry_run` into the default `do_train`/`do_score` path (mirroring the guard already present in `incremental_update()`) so `--dry-run` without `--incremental` doesn't call `save_ensemble()`/`score_pending()`.
- `src/server/backtest_optimizer.py:136-158` — move the `DELETE FROM backtesting_runs WHERE run_name LIKE 'opt_%'` cleanup inside the `if not dry_run:` branch so `--dry-run` doesn't delete rows.

## Flagged for review (5 items — do not auto-fix)

- **`src/server/insightService.ts:242-260`** (`getIndexData`) — on fetch failure, falls through to a **hardcoded fake index snapshot** (`NIFTY 50 @ 22450.30`) indistinguishable from live data to callers. The safe fix (return `null`/throw) is a behavior change: any caller currently relying on "always get a number back" would need to handle the null case. Needs your call on whether callers can tolerate that, and whether the fake data should just be deleted outright.
- **`src/server/queues.ts:429-701,776-823`** (`processMlDailyOps`, `processMlWeeklyRetrain`) — each of ~50 Python sub-steps is individually caught and logged, but the job as a whole always reports `{success: true}` to `recordHeartbeat`, even if every sub-step failed. Changing this to reflect partial/total failure would start surfacing new alerts in the job-monitoring/Telegram-digest system — an intentional alerting-behavior change, not a pure bug fix, so it needs your sign-off on the new alert semantics (e.g. threshold for "degraded" vs "failed").
- **`src/server/routers/agents.router.ts:101,112,123,134,163`, `technicals.router.ts:37`, `fundamentals.router.ts:15`, `research.router.ts:79`** — fire-and-forget background job triggers only log to the server console on failure; the frontend has no way to learn a job failed (contrast with `monitor.router.ts`'s `triggerScript`, which persists failure state to `app_settings`). Fixing this means adding a new persistence path across 8 call sites — a real feature addition, not a one-line fix, so it should be scoped as its own follow-up rather than folded into this audit's auto-fix pass.
- **`src/server/reward_engine.py:135-143`** (`update_weights`) — N+1 per-row `SELECT` queries with no default `--days` cutoff over the full outcomes history; a live `--dry-run` run hung >150s with no output. This risks the cron job silently timing out and leaving `signal_type_weights` stale (which `scoring_engine.py` reads at startup). The fix (batch-fetch via JOIN, add a bounded default window) is a real query restructuring that needs verification the batched result matches the per-row semantics exactly — flagging rather than auto-fixing a scoring-adjacent query.
- **`src/server/scoring_engine.py:444-472`** — the `news_sentiment_items` load falls back to the legacy `news_articles` table on *any* exception (not just "table missing"), and that fallback path sets `sentiment_score=1.0`/`impact='MEDIUM'` for every article — a maximum-bullish default. This directly touches scoring math (per Global Constraints, always flagged), and narrowing the exception type doesn't fully resolve the deeper question of whether `1.0`/`MEDIUM` is the right fallback value at all.

## Noted, not actioned (low priority / needs domain input, out of scope for this pass)

- `src/server/routers/fno.router.ts:40` — already logs the error; returning `[]` vs adding a `stale` flag is a minor API-shape preference, not a bug.
- `src/server/routers/screeners.router.ts:35` — `params: z.any()` bypasses validation; a real fix needs per-provider schema knowledge this audit doesn't have.
- Heavy `as any` casting on DB row results across routers — a broad typing refactor, not a bug.
- `src/server/python_api.py` — unconditional heavy `torch`/`dl_engine` import adds ~20s cold-start latency; a performance/lazy-loading design choice, not a correctness bug.
- 79 total `.isoformat()) call sites across 40 Python files (agent-d) — only the 2 sites above were verified against an actual Postgres DATE column; a blanket sweep risks false fixes on sites that are actually fine (e.g. binding into a TEXT column or a non-DB string field). Flagging as a follow-up audit item, not fixing blind.
