# Job Pipeline Monitoring + Telegram Alerts — Design

**Date:** 2026-07-02
**Status:** Approved by user, pending spec review

## Problem

The platform runs ~35 scheduled BullMQ jobs (market data, scoring, ML ops, screener syncs,
agents) plus Python engines invoked from within them. There is no single place to see
whether all of them ran today, and no notification when one silently stops running — which
is exactly the class of bug that caused the multi-week `stock_scores` staleness incident
(see `alphaquant_split_brain` memory) and the outcome-resolution-loop breakage (see
`prod_readiness_program` memory). The user wants:

1. Confidence that all job pipelines / data fetchers are currently running without errors.
2. A Telegram alert the moment a critical job is later than its usual completion time with
   no success yet today.
3. A daily digest on Telegram at 9 PM IST summarizing every job's status.

## Current state (found during investigation)

- `src/server/jobHeartbeat.ts` already exists: a `job_heartbeat` table + `recordHeartbeat()` /
  `getStaleJobs()`, wired into **6** of ~35 queue workers (stock-refresh, stock-scoring,
  news-sentiment, outcome-resolver, ml-daily-ops, intraday-fetcher). `getStaleJobs()` uses a
  flat per-job hour threshold and only `console.warn`s — nothing reaches Telegram today.
- `src/server/monitoringService.ts:68` exports `updateMonitorState(taskName, state, message)`
  — called from **13 sites** in `queues.ts` (quant-eod-sync, technical-scan,
  outcome-resolver-5d/15d, performance-tracker, fii-dii-fetcher, finbert-scorer,
  ml-ensemble-score, reward-engine, rl-agent-update, signal-type-stats, ml-ensemble-train,
  strategy-optimizer, dl-engine-infer, regime-detector, dl-trainer, ohlcv-backfill,
  screener-performance, company-profiles-sync) but the function body is a **no-op stub**.
  Implementing it to delegate to `recordHeartbeat` activates tracking for all 13 call sites
  in one change.
- `src/server/telegramService.ts` has a working `sendMarkdownMessage()` reading
  `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` from `.env` or `app_settings` (both currently
  blank — user will supply values before rollout).
- `cron-parser@^5.6.0` is already a direct project dependency (BullMQ also vendors its own
  copy internally), so lateness math can use real cron evaluation instead of flat hour
  windows.
- Remaining queues with **no instrumentation at all** (need `recordHeartbeat` added to their
  worker `completed`/`failed` handlers): mc-screener-sync, etnow-screener-sync, nse-sync,
  fundamentals-sync, quant-scoring, signal-outcomes, trendlyne-intraday, ml-weekly-retrain,
  research-premarket, research-postclose, dl-macro-fetch, preopen-snapshot,
  market-regime-refresh, dl-feature-refresh, dl-retrain-weekly, confluence-compute,
  confluence-outcomes, agent-data-scientist, agent-strategist, agent-auditor,
  agent-optimizer, unified-ranker, live-screener-collect, ai-signals (event-driven, no
  cron — heartbeat only, no lateness check).
- `dl-retrain-emergency` is drift-triggered, not scheduled — heartbeat only, excluded from
  lateness checks, shown in digest as "event-triggered."

## Architecture

Four pieces, all additive to existing modules — no existing job logic changes.

### 1. `src/server/jobRegistry.ts` (new)

A static array, one entry per scheduled job:

```ts
interface JobScheduleEntry {
  jobName: string;        // matches the string passed to recordHeartbeat()
  label: string;          // human-readable, used in Telegram messages
  cronPattern?: string;   // BullMQ repeat pattern; absent = event-driven (no lateness check)
  everyMs?: number;       // for `every:` based repeats (confluence-compute, news/trendlyne intraday)
  graceMinutes: number;   // how late is "late" — default 45, tuned per job during implementation
  critical: boolean;      // false = shown in digest only, no real-time ping
}
```

Populated from the cron patterns already read out of `queues.ts` (captured during this
investigation — 30+ patterns spanning stock-refresh at 4 PM IST through the 9 PM IST
DL-inference window). This registry is the single source of truth for "when should this
job have finished" — it replaces the flat `STALE_THRESHOLD_MS` map in `jobHeartbeat.ts`.

### 2. `jobHeartbeat.ts` extensions

- `getLateJobs()`: for each registry entry with a `cronPattern`/`everyMs`, compute today's
  most recent expected fire time (`cron-parser`'s `prev()` from "now", or `now` rounded down
  to the last `everyMs` boundary). A job is late if `now > firetime + graceMinutes` **and**
  `last_success_at < firetime`. Event-driven jobs (no pattern) are skipped.
- New `last_alert_sent_at` column on `job_heartbeat` (epoch ms) so the watchdog pings once
  per late occurrence, not every 15-minute poll — reset implicitly because the next
  occurrence's expected firetime is later than the stored alert timestamp.
- Keep `getStaleJobs()` for the existing hourly console log (cheap safety net, unchanged).

### 3. Wire remaining jobs

- Implement `updateMonitorState()` in `monitoringService.ts` to call `recordHeartbeat`
  (`state==='success'` → `'success'`, else `'failed'` with `message`) — activates the 13
  already-instrumented-but-dead call sites for free.
- Add `recordHeartbeat('<job>', ...)` calls to the ~23 remaining worker `completed`/`failed`
  handlers listed above that call neither helper today. Mechanical, one queue at a time,
  verified against each worker's actual success/failure branches (some jobs, e.g.
  `ohlcv-backfill`, have two named repeatables sharing one worker — heartbeat per repeatable
  name, not per worker, so lateness tracks each schedule independently).

### 4. `src/server/jobWatchdog.ts` (new)

- **Late-job check**: `setInterval` every 15 minutes (same pattern as the existing
  `startHeartbeatMonitor`), calls `getLateJobs()`, and for each newly-late **critical** job
  sends one Telegram message via `telegramService.sendMarkdownMessage()`, then stamps
  `last_alert_sent_at`. Message includes job label, expected time, hours late, last error if
  any.
- **Daily digest**: a new BullMQ repeatable queue `QUEUE_JOB_DIGEST`, cron `30 15 * * *`
  (9:00 PM IST, every day — Sunday/weekly jobs like nse-sync and fundamentals-sync need
  covering too). Builds one table across the full registry: ✅ OK / ⚠️ LATE / ❌ FAILED /
  ⏳ not due yet, with last-success time, and sends it as a single Telegram message.

## Data flow

```
Worker completed/failed
   → recordHeartbeat(jobName, status, error)      [existing table, extended]
        ↓
   job_heartbeat table (last_run_at, last_success_at, last_alert_sent_at)
        ↓
   jobWatchdog setInterval (15 min)  ──late?──▶  telegramService.sendMarkdownMessage()
        ↓
   QUEUE_JOB_DIGEST (daily 9 PM IST) ──always──▶  telegramService.sendMarkdownMessage()
```

## Error handling

- `recordHeartbeat` already swallows its own errors (heartbeat must never break a job) —
  unchanged.
- Telegram send failures (`sendMarkdownMessage` returns `false` on error, already logged) do
  not throw — a missed alert is logged to console as a fallback, not a crash.
- If Telegram credentials are unset, `sendMarkdownMessage` no-ops (existing behavior) — the
  watchdog still runs and logs to console, so nothing breaks before credentials are added.

## Testing

- Unit tests for `getLateJobs()` lateness math: fixed `now`, a handful of registry entries
  with known cron patterns, assert late/not-late/not-yet-due classification.
- Unit test for digest formatting (pure function, given a set of heartbeat rows).
- Manual smoke test once Telegram credentials are set: trigger `sendMarkdownMessage` directly
  to confirm delivery, then force one job's `last_success_at` far in the past in the DB and
  confirm the watchdog fires exactly one alert.

## Non-goals (deferred, per user's answers)

- Standalone Python fetcher scripts not invoked via BullMQ (fii_dii_fetcher.py run directly,
  etc.) are out of scope for now — only the ~35 BullMQ-scheduled pipelines.
- No new UI/tRPC surface for job health — Telegram is the only delivery channel requested.
