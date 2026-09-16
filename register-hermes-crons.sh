#!/bin/bash
# Hermes Cron Job Registration for Bharat Stock Intelligence
# Run this after installing Hermes and configuring it
#
# Telegram delivery credentials are read from the repo's .env (TELEGRAM_CHAT_ID /
# TELEGRAM_BOT_TOKEN) — the same values telegramService.ts reads. A registration
# pointing at a placeholder chat id would silently deliver every alert to a chat
# that does not exist, so this script REFUSES to run without the real values.

set -e

HERMES="hermes"
WORKDIR="D:/Github/bharat-stock-intelligence"
# Real credentials come from the repo .env (TELEGRAM Alerts block). Never hardcode a chat id
# here: a hardcoded placeholder silently delivers every alert to a nonexistent chat
# (found 2026-09-14, "no mocked data" pass).
if [ -f "$WORKDIR/.env" ]; then
    set -a; . "$WORKDIR/.env"; set +a
fi
: "${TELEGRAM_CHAT_ID:?Set TELEGRAM_CHAT_ID in $WORKDIR/.env before registering}"

# Load real credentials from the repo .env (KEY=VALUE lines; no export needed).
if [ -f "$WORKDIR/.env" ]; then
    set -a
    source "$WORKDIR/.env"
    set +a
fi

if [ -z "$TELEGRAM_CHAT_ID" ]; then
    echo "ERROR: TELEGRAM_CHAT_ID is not set." >&2
    echo "Set it in $WORKDIR/.env (same value telegramService.ts uses) and re-run." >&2
    exit 1
fi

echo "Registering Bharat Stock Intelligence cron jobs with Hermes..."

# Helper function to add cron job
add_cron() {
    local name=$1
    local schedule=$2
    local prompt=$3
    local skills=$4
    local deliver=${5:-""}
    local deliver_chat=${6:-""}
    
    echo "Adding cron job: $name ($schedule)"
    
    cmd="$HERMES cron add $name --schedule \"$schedule\" --prompt \"$prompt\" --workdir \"$WORKDIR\""
    
    if [ -n "$skills" ]; then
        cmd="$cmd --skills \"$skills\""
    fi
    
    if [ -n "$deliver" ]; then
        cmd="$cmd --deliver $deliver"
        if [ -n "$deliver_chat" ]; then
            cmd="$cmd --deliver-chat-id \"$deliver_chat\""
        fi
    fi
    
    eval $cmd
}

# ============================================================
# SCREENER SYNC JOBS (Weekdays, 6:00-6:40 PM IST)
# ============================================================

add_cron "et-marketstats-sync" "30 12 * * 1-5" \
    "Run ET Marketstats screener sync. Fetches ~92 screeners and updates screener_appearances table." \
    "bharat-fetcher-health" \
    "telegram" "$TELEGRAM_CHAT_ID"

add_cron "trendlyne-screener-sync" "40 12 * * 1-5" \
    "Run Trendlyne screener-stock sync. Updates screener_appearances for Trendlyne universe." \
    "bharat-fetcher-health" \
    "telegram" "$TELEGRAM_CHAT_ID"

add_cron "mc-screener-sync" "50 12 * * 1-5" \
    "Run MoneyControl screener sync. Fetches ~1,400 screeners sequentially with rate limiting." \
    "bharat-fetcher-health" \
    "telegram" "$TELEGRAM_CHAT_ID"

add_cron "etnow-screener-sync" "10 13 * * 1-5" \
    "Run ETNow screener sync. Fetches ~1,300 screeners with 800ms rate limit delay each." \
    "bharat-fetcher-health" \
    "telegram" "$TELEGRAM_CHAT_ID"

# ============================================================
# DAILY ML OPERATIONS (Weekdays, 7:30 PM IST)
# ============================================================

add_cron "ml-daily-ops" "0 14 * * 1-5" \
    "Run full ML daily operations chain: 80+ fetchers, feature engineering, model scoring, outcome resolution, drift detection, ensemble training. This is the main nightly pipeline." \
    "bharat-backtest-runner,bharat-fetcher-health" \
    "telegram" "$TELEGRAM_CHAT_ID"

# ============================================================
# STOCK SCORING (Weekdays, 8:30 PM IST)
# ============================================================

add_cron "stock-scoring" "0 15 * * 1-5" \
    "Recalculate composite stock scores from stock_scores and technical_signals. Runs after ml-daily-ops." \
    "bharat-fetcher-health" \
    "telegram" "$TELEGRAM_CHAT_ID"

# ============================================================
# QUANT SCORING (Weekdays, 8:50 PM IST)
# ============================================================

add_cron "quant-scoring" "20 15 * * 1-5" \
    "Run quant strategy scoring: runQuantScoring, multi_factor_scorer, risk_metrics_engine, snapshotQuantScores, factor_backtest for value_book_to_price and momentum_12_1." \
    "bharat-backtest-runner" \
    "telegram" "$TELEGRAM_CHAT_ID"

# ============================================================
# FUNDAMENTALS SYNC (Saturday 8:30 AM IST)
# ============================================================

add_cron "fundamentals-sync" "0 3 * * 6" \
    "Run full fundamentals sync (phase2Only=false). Deep fundamental data fetch for all symbols." \
    "bharat-fetcher-health" \
    "telegram" "$TELEGRAM_CHAT_ID"

# ============================================================
# WEEKLY ML RETRAIN (Sunday 2:00 AM IST)
# ============================================================

add_cron "ml-weekly-retrain" "0 20 * * 0" \
    "Run weekly ML retrain: sync index maps, earnings surprise, MF holdings, MarketsMojo financials/shareholding/fintrend, finstack cashflow, insider transactions, trendlyne fundamentals, extra_endpoints weekly scope, outcome resolver, exit_labeler, ml_ensemble full train." \
    "bharat-backtest-runner,bharat-model-promotion" \
    "telegram" "$TELEGRAM_CHAT_ID"

# ============================================================
# INTRADAY JOBS (Market hours, weekdays)
# ============================================================

add_cron "intraday-fetcher" "*/5 4-10 * * 1-5" \
    "Fetch 15m intraday bars for full NSE universe (last 24h). Runs every 5 min during market hours (9:15-15:30 IST = 3:45-10:00 UTC)." \
    "bharat-fetcher-health"

add_cron "live-screener-collect" "*/15 4-10 * * 1-5" \
    "Collect live screener data from NiftyTrader/ETNow/etc. Runs every 15 min during market hours." \
    "bharat-fetcher-health"

add_cron "mover-intraday-capture" "*/15 4-10 * * 1-5" \
    "Capture intraday mover screener snapshots (NT live cross-section). Runs every 15 min during market hours." \
    "bharat-fetcher-health"

add_cron "nt-live-filter-capture" "*/15 4-10 * * 1-5" \
    "Capture per-filter live screener data from NiftyTrader. Runs every 15 min during market hours." \
    "bharat-fetcher-health"

# ============================================================
# POST-MARKET JOBS (Weekdays, after close)
# ============================================================

add_cron "mover-screener-capture" "35 10 * * 1-5" \
    "Capture end-of-day mover screener lists (gainers/losers/gap-up/down). Runs at 4:05 PM IST (10:35 UTC)." \
    "bharat-fetcher-health" \
    "telegram" "$TELEGRAM_CHAT_ID"

# ============================================================
# DL/ML SPECIALIZED JOBS
# ============================================================

add_cron "dl-macro-fetch" "0 2 * * 1-5" \
    "Fetch macro data for DL models. Runs at 7:30 AM IST (2:00 UTC)." \
    "bharat-fetcher-health"

add_cron "dl-feature-refresh" "30 2 * * 1-5" \
    "Refresh DL feature store. Runs at 8:00 AM IST (2:30 UTC)." \
    "bharat-fetcher-health"

add_cron "dl-inference" "0 3 * * 1-5" \
    "Run DL inference for regime detection and scoring. Runs at 8:30 AM IST (3:00 UTC)." \
    "bharat-backtest-runner"

add_cron "dl-regime-update" "30 3 * * 1-5" \
    "Update regime labels for DL models. Runs at 9:00 AM IST (3:30 UTC)." \
    "bharat-model-promotion"

add_cron "dl-retrain-weekly" "0 20 * * 6" \
    "Weekly DL retrain (Saturday 1:30 AM IST)." \
    "bharat-model-promotion" \
    "telegram" "$TELEGRAM_CHAT_ID"

# ============================================================
# TRENDLYNE SPECIALIZED JOBS
# ============================================================

add_cron "trendlyne-daily-fetch" "0 14 * * 1-5" \
    "Daily Trendlyne fetch for metrics/ratios. Runs alongside ml-daily-ops." \
    "bharat-fetcher-health"

add_cron "trendlyne-midweek" "0 14 * * 2" \
    "Tuesday Trendlyne advanced tech + price analysis fetch." \
    "bharat-fetcher-health"

add_cron "trendlyne-ratios-monthly" "0 3 * * 1#1" \
    "First Monday of month: Trendlyne ratios monthly deep fetch." \
    "bharat-fetcher-health"

add_cron "trendlyne-checklist-cycle" "*/30 4-10 * * 1-5" \
    "Trendlyne checklist fundamentals cycle (self-rescheduling). Runs during market hours with 15-45 min random intervals." \
    "bharat-fetcher-health"

# ============================================================
# CONFLUENCE JOBS
# ============================================================

add_cron "confluence-compute" "*/10 4-10 * * 1-5" \
    "Compute confluence signals from technical + screener + news overlap. Runs every 10 min during market hours." \
    "bharat-backtest-runner"

add_cron "confluence-outcomes" "0 14 * * 1-5" \
    "Resolve confluence signal outcomes. Runs with ml-daily-ops." \
    "bharat-backtest-runner"

# ============================================================
# DIGEST/ALERT JOBS
# ============================================================

add_cron "job-digest-morning" "30 2 * * 1-5" \
    "Morning job digest (8:00 AM IST). Summarizes overnight job status." \
    "bharat-fetcher-health" \
    "telegram" "$TELEGRAM_CHAT_ID"

add_cron "job-digest-evening" "10 15 * * 1-5" \
    "Evening job digest (4:40 PM IST). Summarizes day's job status." \
    "bharat-fetcher-health" \
    "telegram" "$TELEGRAM_CHAT_ID"

add_cron "recommendations-digest" "0 15 * * 1-5" \
    "Daily recommendations digest (4:30 PM IST). Sends top conviction picks." \
    "bharat-backtest-runner" \
    "telegram" "$TELEGRAM_CHAT_ID"

# ============================================================
# SYNC JOBS
# ============================================================

add_cron "nse-sync" "0 13 * * 1-5" \
    "Sync NSE master stock list. Runs at 6:30 PM IST (13:00 UTC)." \
    "bharat-fetcher-health"

add_cron "analyst-estimates-sync" "30 8 * * 1-5" \
    "Daily analyst estimates sync (Mon-Fri 14:15 UTC = 7:45 PM IST). Hybrid direct-engine rewrite." \
    "bharat-fetcher-health"

add_cron "company-profiles-sync" "0 2 * * 0" \
    "Weekly company profiles sync (Sunday 7:30 AM IST)." \
    "bharat-fetcher-health"

add_cron "tickertape-scorecard" "0 4 * * 6" \
    "Weekly Tickertape scorecard sync (Saturday 9:30 AM IST)." \
    "bharat-fetcher-health"

add_cron "quant-eod-sync" "0 15 * * 1-5" \
    "Quant EOD sync (8:30 PM IST). Runs after stock-scoring." \
    "bharat-fetcher-health"

# ============================================================
# AGENT JOBS (On-demand via Hermes chat, but can schedule)
# ============================================================

# These are typically triggered manually via Hermes chat:
# hermes chat -q "Run agent data scientist analysis on RELIANCE"
# But we can add a weekly schedule for automated research:

add_cron "agent-data-scientist-weekly" "0 6 * * 0" \
    "Weekly agent data scientist: autonomous research on factor performance and signal quality." \
    "bharat-backtest-runner,bharat-model-promotion" \
    "telegram" "$TELEGRAM_CHAT_ID"

add_cron "agent-strategist-weekly" "30 6 * * 0" \
    "Weekly agent strategist: portfolio construction and regime allocation review." \
    "bharat-backtest-runner" \
    "telegram" "$TELEGRAM_CHAT_ID"

# ============================================================
# HEALTH MONITORING
# ============================================================

add_cron "ingestion-health-check" "*/15 * * * *" \
    "Check ingestion health every 15 min: call inspect_ingestion_health, alert on DLQ > 0 or job failures." \
    "bharat-fetcher-health" \
    "telegram" "$TELEGRAM_CHAT_ID"

add_cron "dlq-reprocess" "0 * * * *" \
    "Hourly DLQ sweep: call inspect_ingestion_health; for each fetcher with NEW DLQ entries, read the missed window from data_ingestion_dlq and re-run that fetcher over it via the run_fetcher MCP tool (requeue_dlq is retired — DLQ rows are not replayable)." \
    "bharat-fetcher-health"

add_cron "data-quality-checks" "0 1 * * 1-5" \
    "Run data quality checks at 6:30 AM IST (1:00 UTC)." \
    "bharat-fetcher-health" \
    "telegram" "$TELEGRAM_CHAT_ID"

# ============================================================
# OHLCV BACKFILL (On-demand, but can schedule weekly catch-up)
# ============================================================

add_cron "ohlcv-backfill-weekly" "0 5 * * 6" \
    "Weekly OHLCV backfill catch-up (Saturday 10:30 AM IST)." \
    "bharat-fetcher-health"

# ============================================================
# UNIFIED RANKER (After all scoring)
# ============================================================

add_cron "unified-ranker" "30 15 * * 1-5" \
    "Run unified_ranker.py to produce final unified_recommendations. Runs after quant-scoring (8:50 PM IST)." \
    "bharat-backtest-runner,bharat-model-promotion" \
    "telegram" "$TELEGRAM_CHAT_ID"

# ============================================================
# GDELT SENTIMENT
# ============================================================

add_cron "gdelt-sentiment" "0 6 * * *" \
    "Daily GDELT geopolitical sentiment fetch (11:30 AM IST)." \
    "bharat-fetcher-health"

# ============================================================
# PG BACKUP (Daily 2:00 AM IST)
# ============================================================

add_cron "pg-backup-nightly" "30 20 * * *" \
    "Nightly PostgreSQL backup to S3. Runs at 2:00 AM IST (20:30 UTC)." \
    "aws-cli" \
    "telegram" "$TELEGRAM_CHAT_ID"

echo ""
echo "All cron jobs registered! Run 'hermes cron list' to verify."
echo ""
echo "Note: Update the Telegram chat ID ($TELEGRAM_CHAT_ID) to your actual chat ID."
echo "Set WEBHOOK_SECRET in ~/.hermes/.env for webhook platform."