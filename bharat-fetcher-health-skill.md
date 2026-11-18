---
name: bharat-fetcher-health
description: "Diagnose and remediate fetcher failures in Bharat Stock Intelligence pipeline."
version: 1.0.0
author: Bharat Stock Intelligence
license: MIT
metadata:
  hermes:
    tags: [bharat, fetcher, health, diagnostics, pipeline]
    created_by: "agent"
---

# Bharat Fetcher Health Skill

Diagnose fetcher failures, re-run missed windows, and monitor ingestion pipeline health.

## When to Use

- A fetcher shows as failed in the dashboard
- A job step failed and its window needs re-running
- Data quality checks are failing
- You need to understand why a fetcher isn't running

## Tools Available

This skill uses the `bharat-intelligence` MCP server which exposes:
- `inspect_ingestion_health` - Full pipeline health check
- `get_fetcher_status` - Status of specific or all fetchers
- `run_fetcher` - Manually trigger a fetcher
- `list_fetchers` - List all available fetchers
- `requeue_dlq` - **RETIRED 2026-09-13** — returns an error by design. The `data_ingestion_dlq` table itself was dropped 2026-10-05 (migration `20261005100000`, AF-20261003-07). Re-run the failed fetch with `run_fetcher` instead.

## Procedures

### 1. Full Health Check
```
1. Call inspect_ingestion_health
2. Review heartbeats for failed/never-run jobs
3. Check per-step failures in job_run_history (status/error) for the failing job
4. Review data quality failures
5. Take action on each issue
```

### 2. Diagnose Specific Fetcher
```
1. Call get_fetcher_status with fetcher_name
2. Check last_run_at, last_status, last_error
3. If failed: examine error, check dependencies
4. Run fetcher manually with run_fetcher to test
```

### 3. Missed-Window Remediation
```
1. Call inspect_ingestion_health for failed heartbeats and DQ failures
2. For each failed step: read job_run_history.error for the run to find the
   failed window/symbols, then re-run that fetcher over it with run_fetcher.
3. Monitor job_heartbeat / the next daily digest for the re-run's outcome
4. If same fetcher fails repeatedly: check upstream data source.
   **Lookup alternate working sources in the 3,000+ discovery registry:**
   - Query `market_endpoint_registry` in Postgres (:5433, 3,408 live working endpoints; `v_working_market_endpoints`, `v_stock_screeners`, `v_fno_endpoints`).
   - Run `python -m url_explorer.ingest --find-alternates "<targets>" --exclude <failing-host>` from `src/server` to check `url_endpoints` (834 templates).
   - Check the optional local `urls_v2.db` corpus if present (the flat `unique_urls.txt` was deleted 2026-10-23; `git show c2ceae0e^:unique_urls.txt`) and `DATA_FETCHING_GUIDE.md` for proven headers, cookies, and payload shapes.
```

### 4. Trading Holiday Awareness
Many jobs skip on trading holidays (NSE/BSE closed). Check:
- `shouldSkipOnTradingHoliday` logic in queues.ts
- Job schedules in registerJob.ts
- NSE holiday calendar in nse_stocks table

## Common Failure Patterns

| Pattern | Cause | Remediation |
|---------|-------|-------------|
| `last_status: null` | Never ran | Check schedule, dependencies, manual run |
| `last_error: timeout` | Budget too low | Increase lockDuration/timeout in job config |
| `N steps failed` in job_run_history | Partial failures | Re-run the missed window with `run_fetcher`, then check root cause |
| `data_quality: FAIL` | Stale/freshness breach | Run fetcher manually; if upstream is dead/stale, query `market_endpoint_registry` (3,408 endpoints) / `url_endpoints` (`--find-alternates`) for active alternates |

## Integration with Hermes

- Desktop plugin shows live health in status bar
- Cron job `ingestion-health-check` runs every 15 min
- Telegram alerts on failures
- Webhook can trigger from external monitoring

## Commands

```bash
# Via Hermes chat
"Check ingestion health"
"Run the intraday fetcher"
"Re-run yesterday's block-deal fetch for the failed window"
"Show status of mc_broker_reco_fetcher"
"List all fetchers"
```