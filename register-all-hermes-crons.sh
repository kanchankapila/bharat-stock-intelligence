#!/bin/bash
# Register ALL Hermes cron jobs including enhanced features

HERMES="hermes"
WORKDIR="D:/Github/bharat-stock-intelligence"
# Real credentials come from the repo .env (TELEGRAM Alerts block). Never hardcode a chat id
# here: a hardcoded placeholder silently delivers every alert to a nonexistent chat
# (found 2026-09-14, "no mocked data" pass).
if [ -f "$WORKDIR/.env" ]; then
    set -a; . "$WORKDIR/.env"; set +a
fi
: "${TELEGRAM_CHAT_ID:?Set TELEGRAM_CHAT_ID in $WORKDIR/.env before registering}"

add_cron() {
    local name=$1; local schedule=$2; local prompt=$3; local skills=$4; local profile=${5:-"bharat-ops"}; local deliver=$6; local chat=$7
    cmd="$HERMES --profile $profile cron add $name --schedule \"$schedule\" --prompt \"$prompt\" --workdir \"$WORKDIR\""
    [ -n "$skills" ] && cmd="$cmd --skills \"$skills\""
    [ -n "$deliver" ] && cmd="$cmd --deliver $deliver --deliver-chat-id \"$chat\""
    eval $cmd
    echo "  Added: $name ($schedule) [$profile]"
}

# ============ OPERATIONS PROFILE (bharat-ops) ============
echo "📋 Registering OPS profile cron jobs..."

# High-frequency health checks
add_cron "health-check-5min" "*/5 * * * *" "Call inspect_ingestion_health, alert on NEW failures or DLQ > 5" "bharat-fetcher-health" "bharat-ops" "telegram" "$TELEGRAM_CHAT_ID"
add_cron "dlq-reprocess-hourly" "0 * * * *" "Hourly DLQ sweep: inspect_ingestion_health; for each fetcher with NEW DLQ entries re-run its missed window via run_fetcher (requeue_dlq is retired, DLQ rows are not replayable)" "bharat-fetcher-health" "bharat-ops" "telegram" "$TELEGRAM_CHAT_ID"

# Screener syncs (6:00-6:40 PM IST)
add_cron "et-marketstats-sync" "30 12 * * 1-5" "Run ET Marketstats screener sync (~92 screeners)" "bharat-fetcher-health" "bharat-ops" "telegram" "$TELEGRAM_CHAT_ID"
add_cron "trendlyne-screener-sync" "40 12 * * 1-5" "Run Trendlyne screener-stock sync" "bharat-fetcher-health" "bharat-ops" "telegram" "$TELEGRAM_CHAT_ID"
add_cron "mc-screener-sync" "50 12 * * 1-5" "Run MoneyControl screener sync (~1,400 screeners)" "bharat-fetcher-health" "bharat-ops" "telegram" "$TELEGRAM_CHAT_ID"
add_cron "etnow-screener-sync" "10 13 * * 1-5" "Run ETNow screener sync (~1,300 screeners)" "bharat-fetcher-health" "bharat-ops" "telegram" "$TELEGRAM_CHAT_ID"

# Daily ML pipeline (7:30-9:00 PM IST)
add_cron "ml-daily-ops" "0 14 * * 1-5" "Run full ML daily ops: 80+ fetchers, features, scoring, outcomes, drift, ensemble" "bharat-fetcher-health,bharat-backtest-runner" "bharat-ops" "telegram" "$TELEGRAM_CHAT_ID"
add_cron "stock-scoring" "0 15 * * 1-5" "Recalculate stock scores from stock_scores + technical_signals" "bharat-fetcher-health" "bharat-ops" "telegram" "$TELEGRAM_CHAT_ID"
add_cron "quant-scoring" "20 15 * * 1-5" "Run quant scoring: multi_factor_scorer, risk_metrics, snapshot, factor_backtest" "bharat-backtest-runner" "bharat-ops" "telegram" "$TELEGRAM_CHAT_ID"
add_cron "unified-ranker" "30 15 * * 1-5" "Run unified_ranker.py for final unified_recommendations" "bharat-backtest-runner,bharat-model-promotion" "bharat-ops" "telegram" "$TELEGRAM_CHAT_ID"

# Intraday (market hours 9:15-15:30 IST = 3:45-10:00 UTC)
add_cron "intraday-fetcher" "*/5 4-10 * * 1-5" "Fetch 15m bars for full NSE universe" "bharat-fetcher-health" "bharat-ops"
add_cron "live-screener-collect" "*/15 4-10 * * 1-5" "Collect live screener data" "bharat-fetcher-health" "bharat-ops"
add_cron "mover-intraday" "*/15 4-10 * * 1-5" "Capture intraday mover snapshots" "bharat-fetcher-health" "bharat-ops"

# Post-market (4:05 PM IST)
add_cron "mover-eod-capture" "35 10 * * 1-5" "Capture EOD mover lists (gainers/losers/gaps)" "bharat-fetcher-health" "bharat-ops" "telegram" "$TELEGRAM_CHAT_ID"

# Weekly/Monthly
add_cron "fundamentals-sync" "0 3 * * 6" "Full fundamentals sync (Saturday 8:30 AM IST)" "bharat-fetcher-health" "bharat-ops" "telegram" "$TELEGRAM_CHAT_ID"
add_cron "ml-weekly-retrain" "0 20 * * 0" "Weekly ML retrain + model promotion gates (Sunday 1:30 AM IST)" "bharat-backtest-runner,bharat-model-promotion" "bharat-ops" "telegram" "$TELEGRAM_CHAT_ID"

# Audio Briefings (NEW - TTS)
add_cron "pre-market-briefing" "0 3 * * 1-5" "Run tts_briefing.py pre_market for Telegram voice note" "" "bharat-ops" "telegram" "$TELEGRAM_CHAT_ID"
add_cron "post-market-briefing" "30 10 * * 1-5" "Run tts_briefing.py post_market for Telegram voice note" "" "bharat-ops" "telegram" "$TELEGRAM_CHAT_ID"

# ============ RESEARCH PROFILE (bharat-research) ============
echo "📋 Registering RESEARCH profile cron jobs..."

add_cron "weekly-factor-discovery" "0 6 * * 0" "Run data_scientist agent, validate candidates, update kanban" "bharat-backtest-runner,bharat-model-promotion" "bharat-research" "telegram" "$TELEGRAM_CHAT_ID"
add_cron "monthly-model-audit" "0 2 1 * *" "Run auditor agent, check all promoted models, negative controls" "bharat-model-promotion,bharat-backtest-runner" "bharat-research" "telegram" "$TELEGRAM_CHAT_ID"
add_cron "quarterly-weight-opt" "0 6 1 */3 *" "Run optimizer agent, AlphaQuant walkforward, promote weights" "bharat-model-promotion" "bharat-research" "telegram" "$TELEGRAM_CHAT_ID"

# ============ SYNC & SPECIALIZED ============
add_cron "nse-sync" "0 13 * * 1-5" "Sync NSE master stock list" "bharat-fetcher-health" "bharat-ops"
add_cron "analyst-estimates" "30 8 * * 1-5" "Daily analyst estimates sync" "bharat-fetcher-health" "bharat-ops"
add_cron "pg-backup" "30 20 * * *" "Nightly PostgreSQL backup to S3" "aws-cli" "bharat-ops" "telegram" "$TELEGRAM_CHAT_ID"

echo ""
echo "✅ All cron jobs registered!"
echo "Run 'hermes --profile bharat-ops cron list' and 'hermes --profile bharat-research cron list' to verify"
