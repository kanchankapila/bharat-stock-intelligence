# Bharat Stock Intelligence → Hermes Agent Migration Guide

Complete migration from PM2 + BullMQ to Hermes Agent for scheduling, monitoring, AI access, and multi-agent workflows.

## Architecture Comparison

| Component | Before (PM2) | After (Hermes) |
|-----------|--------------|----------------|
| **API Server** | `bharat-server` (port 3000) | Same, unchanged |
| **ML API** | `ml-api` (port 8000) | Same, unchanged |
| **Chatbot** | `chatbot` (port 8001) | Same, unchanged |
| **AlphaQuant** | `alphaquant-api` (port 8002) | Same, unchanged |
| **Engine Worker** | `engine-worker` (port 8005) | **MCP Server** + Hermes tools |
| **Scheduling** | BullMQ (Redis) + PM2 cron | **Hermes Cron** (durable, chained) |
| **Monitoring** | `pm2 logs` + Telegram | **Hermes Webhooks** + Desktop Plugin + Telegram |
| **AI Access** | MCP server only | **MCP + Native tools + Delegation + Skills** |
| **UI** | React frontend only | **React + Desktop Plugin + TUI + Web Dashboard** |
| **Collaboration** | Single-user | **Multi-profile, Kanban, Session sharing** |

## Migration Steps

### Phase 1: Parallel Run (Week 1)
1. Install Hermes alongside PM2
2. Configure Hermes with MCP server
3. Register all cron jobs in Hermes
4. Register webhooks
5. Install desktop plugin
6. Verify all MCP tools work
7. Run both systems in parallel

### Phase 2: Validation (Week 2)
1. Compare job execution: Hermes vs PM2
2. Verify Telegram alerts match
3. Validate desktop plugin shows correct data
4. Test webhook deliveries (GitHub, monitoring)
5. Run backtests via Hermes skills
6. Verify model promotion gates work

### Phase 3: Cutover (Week 3)
1. Stop PM2 cron jobs (keep services running)
2. Let Hermes cron take over
3. Monitor for 1 week
4. Stop PM2 services one by one:
   - `engine-worker` → replaced by MCP
   - Keep `bharat-server`, `ml-api`, `chatbot`, `alphaquant-api` (they're API services, not scheduled jobs)
5. Update deployment docs

### Phase 4: Cleanup (Week 4)
1. Remove BullMQ queue definitions (optional, keep for reference)
2. Remove PM2 ecosystem.config.cjs cron jobs
3. Archive old monitoring scripts
4. Document new workflows

## Key Files Created

| File | Purpose |
|------|---------|
| `hermes-config.yaml` | Main Hermes configuration |
| `register-hermes-crons.sh` | All 45+ cron job registrations |
| `register-hermes-webhooks.sh` | Webhook subscriptions |
| `bharat-dashboard-plugin.js` | Desktop plugin for live monitoring |
| `bharat-fetcher-health-skill.md` | Fetcher diagnostics skill |
| `bharat-backtest-runner-skill.md` | Backtest validation skill |
| `bharat-model-promotion-skill.md` | ML promotion gates skill |
| `setup-hermes-integration.sh` | One-command setup |
| `verify-hermes-integration.sh` | Verification script |
| `ecosystem.hermes.cjs` | PM2 config for Hermes gateway |

## Cron Job Mapping

| PM2 Job | Hermes Cron | Schedule (IST) |
|---------|-------------|----------------|
| `et-marketstats-sync` | `et-marketstats-sync` | 6:00 PM Mon-Fri |
| `trendlyne-screener-sync` | `trendlyne-screener-sync` | 6:10 PM Mon-Fri |
| `mc-screener-sync` | `mc-screener-sync` | 6:20 PM Mon-Fri |
| `etnow-screener-sync` | `etnow-screener-sync` | 6:40 PM Mon-Fri |
| `ml-daily-ops` | `ml-daily-ops` | 7:30 PM Mon-Fri |
| `stock-scoring` | `stock-scoring` | 8:30 PM Mon-Fri |
| `quant-scoring` | `quant-scoring` | 8:50 PM Mon-Fri |
| `unified-ranker` | `unified-ranker` | 9:00 PM Mon-Fri |
| `fundamentals-sync` | `fundamentals-sync` | 8:30 AM Sat |
| `ml-weekly-retrain` | `ml-weekly-retrain` | 1:30 AM Sun |
| `intraday-fetcher` | `intraday-fetcher` | Every 5min 9:15-15:30 |
| `live-screener-collect` | `live-screener-collect` | Every 15min 9:15-15:30 |
| `mover-screener-capture` | `mover-screener-capture` | 4:05 PM Mon-Fri |
| `pg-backup-nightly` | `pg-backup-nightly` | 2:00 AM Daily |
| ... | ... | ... |

**Total: 45+ cron jobs migrated**

## Webhook Endpoints

| Webhook | URL | Events |
|---------|-----|--------|
| GitHub PR Review | `http://host:8644/webhook/github-pr-review` | `pull_request` |
| GitHub Push | `http://host:8644/webhook/github-push-main` | `push` |
| GitHub Issues | `http://host:8644/webhook/github-issue-triage` | `issues` |
| Prometheus | `http://host:8644/webhook/prometheus-alert` | `alert` |
| Grafana | `http://host:8644/webhook/grafana-alert` | `grafana` |
| Fetcher Complete | `http://host:8644/webhook/fetcher-complete-notification` | `fetcher_done` |
| Job Failed | `http://host:8644/webhook/job-failed-alert` | `job_failed` |

## Skills Installed

| Skill | Commands |
|-------|----------|
| `bharat-fetcher-health` | "Check ingestion health", "Run fetcher X", "Requeue DLQ" |
| `bharat-backtest-runner` | "Run factor backtest for X", "Walkforward optimize", "Reverse engineer movers" |
| `bharat-model-promotion` | "Validate ml_ensemble promotion", "Rollback model", "Check promotion gates" |

## Verification Checklist

- [ ] `hermes doctor` passes
- [ ] `hermes chat -q "List all fetchers"` returns 81+ fetchers
- [ ] `hermes chat -q "Check ingestion health"` shows heartbeats
- [ ] `hermes cron list` shows 45+ jobs
- [ ] `hermes webhook list` shows 10+ webhooks
- [ ] Desktop plugin loads in `hermes desktop` (⌘K → Reload plugins)
- [ ] Telegram alerts arrive for test cron run
- [ ] GitHub webhook test delivers to PR
- [ ] `npx tsc --noEmit` passes
- [ ] `python -m pytest src/server/__tests__/ src/server/tests/` passes
- [ ] MCP server responds: `python -m mcp.market_intelligence_mcp inspect_ingestion_health`

## Rollback Plan

If issues arise:

```bash
# 1. Stop Hermes cron
hermes cron pause all

# 2. Restart PM2 cron jobs
pm2 restart all

# 3. Stop Hermes gateway
pm2 stop hermes-gateway

# 4. Investigate logs
hermes cron list --verbose
pm2 logs bharat-server
```

## Enhanced Capabilities (Post-Migration)

### 1. **Chained Jobs**
```yaml
# dlq-reprocess only runs if eod-fetch succeeded
hermes cron add dlq-reprocess --schedule "0 * * * *" --context-from eod-fetch
```

### 2. **Multi-Platform Alerts**
Same cron job delivers to Telegram, Discord, Email, GitHub comments.

### 3. **Agent Delegation**
```bash
# Background research agent
hermes chat -q "Analyze all failed fetchers last week, find root causes, write report" --background
```

### 4. **Webhook-Driven Backtests**
GitHub PR modifying a factor → auto-runs backtest → posts results as PR comment.

### 5. **Desktop Dashboard**
Live pipeline health, top picks, fetcher status, quick actions - all in Hermes desktop app.

### 6. **Persistent Memory**
Cross-session memory of fetcher issues, backtest results, model decisions.

### 7. **Skill Curator**
Auto-archives unused skills, consolidates overlapping ones, maintains skill health.

## Environment Variables Required

```bash
# ~/.hermes/.env
POSTGRES_URL=postgresql://user:pass@localhost:5433/bharat
WEBHOOK_SECRET=openssl rand -hex 32
TELEGRAM_BOT_TOKEN=<copy TELEGRAM_BOT_TOKEN from the repo .env>
TELEGRAM_CHAT_ID=<copy TELEGRAM_CHAT_ID from the repo .env>
OPENROUTER_API_KEY=sk-or-...
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
S3_BACKUP_BUCKET=bharat-stock-backups
```

## Support Commands

```bash
# Health check
hermes doctor

# View all cron jobs
hermes cron list

# Run a job manually
hermes cron run ml-daily-ops

# View webhook subscriptions
hermes webhook list

# Test webhook
hermes webhook test github-pr-review

# View skills
hermes skill list

# Load a skill
hermes skill load bharat-fetcher-health

# Desktop app
hermes desktop

# TUI
hermes --tui

# Web dashboard
hermes dashboard
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| MCP tools not showing | Restart Hermes after config change |
| Cron not firing | Check `hermes cron list`, verify schedule syntax (cron is LOCAL time) |
| Webhook 404 | Ensure `hermes gateway run` is running on port 8644 |
| Desktop plugin not loading | ⌘K → "Reload desktop plugins", check console for errors |
| Telegram not delivering | Verify `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env` |
| Python path errors | Ensure `PYTHONPATH` in MCP config points to `src/server` |
| Permission denied | Run `chmod +x` on all `.sh` scripts |

## Contacts

- **Architecture**: See `CLAUDE.md` and `.claude/rules/`
- **MCP Tools**: `src/server/mcp/market_intelligence_mcp.py`
- **Job Definitions**: `src/server/jobs/*.jobs.ts`
- **Hermes Docs**: https://hermes-agent.nousresearch.com/docs/