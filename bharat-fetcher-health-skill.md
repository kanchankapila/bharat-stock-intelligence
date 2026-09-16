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

Diagnose fetcher failures, inspect DLQ, requeue jobs, and monitor ingestion pipeline health.

## When to Use

- A fetcher shows as failed in the dashboard
- DLQ has entries that need reprocessing
- Data quality checks are failing
- You need to understand why a fetcher isn't running

## Tools Available

This skill uses the `bharat-intelligence` MCP server which exposes:
- `inspect_ingestion_health` - Full pipeline health check
- `get_fetcher_status` - Status of specific or all fetchers
- `run_fetcher` - Manually trigger a fetcher
- `list_fetchers` - List all available fetchers
- `requeue_dlq` - **RETIRED 2026-09-13** — returns an error by design. The DLQ table keeps no reconstructable payload and nothing consumes its status values, so the old relabel-to-RETRYING was a "success that wrote nothing". Re-run the failed fetch with `run_fetcher` instead.

## Procedures

### 1. Full Health Check
```
1. Call inspect_ingestion_health
2. Review heartbeats for failed/never-run jobs
3. Check DLQ counts per fetcher
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

### 3. DLQ Remediation (replaces the retired requeue_dlq)
```
1. Call inspect_ingestion_health to see DLQ counts
2. For each fetcher with DLQ entries: identify the failed window/symbols
   (read data_ingestion_dlq.reason + fetch_date), then re-run that fetcher
   over the missed window with run_fetcher — the DLQ row itself cannot be
   replayed (payload_sample is truncated to 2000 chars).
3. Monitor job_heartbeat / the next daily digest for the re-run's outcome
4. If same fetcher fails repeatedly: check upstream data source
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
| `DLQ count > 0` | Partial failures | Re-run the missed window with `run_fetcher` (DLQ rows are not replayable), then check root cause |
| `data_quality: FAIL` | Stale/freshness breach | Run fetcher manually, check source API |

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
"Re-run yesterday's block-deal fetch over the DLQ window"
"Show status of mc_broker_reco_fetcher"
"List all fetchers"
```