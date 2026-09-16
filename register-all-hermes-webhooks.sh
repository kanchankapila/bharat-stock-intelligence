#!/bin/bash
HERMES="hermes"
WORKDIR="D:/Github/bharat-stock-intelligence"
# Real credentials come from the repo .env (TELEGRAM Alerts block). Never hardcode a chat id
# here: a hardcoded placeholder silently delivers every alert to a nonexistent chat
# (found 2026-09-14, "no mocked data" pass).
if [ -f "$WORKDIR/.env" ]; then
    set -a; . "$WORKDIR/.env"; set +a
fi
: "${TELEGRAM_CHAT_ID:?Set TELEGRAM_CHAT_ID in $WORKDIR/.env before registering}"

add_webhook() {
    local name=$1; local events=$2; local prompt=$3; local skills=$4; local deliver=$5; local chat=$6; local profile=${7:-"bharat-ops"}; local deliver_only=$8
    cmd="$HERMES --profile $profile webhook subscribe $name --events \"$events\" --prompt \"$prompt\" --workdir \"$WORKDIR\""
    [ -n "$skills" ] && cmd="$cmd --skills \"$skills\""
    [ -n "$deliver" ] && cmd="$cmd --deliver $deliver"
    [ -n "$chat" ] && cmd="$cmd --deliver-chat-id \"$chat\""
    [ "$deliver_only" = "true" ] && cmd="$cmd --deliver-only"
    eval $cmd
}

# GitHub
add_webhook "gh-pr-review" "pull_request" "Review PR #{pull_request.number}: {pull_request.title} by {pull_request.user.login}. Check fetcher changes, scoring logic, migrations, MCP tools." "github-code-review,test-driven-development" "github_comment" ""
add_webhook "gh-push" "push" "Push to {ref}: {head_commit.message}. Trigger CI validation." "test-driven-development" "telegram" "$TELEGRAM_CHAT_ID"
add_webhook "gh-issues" "issues" "New issue #{issue.number}: {issue.title} by {issue.user.login}. Triage for Bharat." "bharat-fetcher-health" "telegram" "$TELEGRAM_CHAT_ID"

# Monitoring
add_webhook "prometheus-alert" "alert" "Alert: {alert.labels.alertname} [{alert.labels.severity}]. {alert.annotations.summary}" "bharat-fetcher-health,systematic-debugging" "telegram" "$TELEGRAM_CHAT_ID"
add_webhook "grafana-alert" "grafana" "Grafana: {title} [{state}]. {message}" "bharat-fetcher-health" "telegram" "$TELEGRAM_CHAT_ID"

# Internal events (direct delivery, no LLM cost)
add_webhook "fetcher-done" "fetcher_done" "✅ {payload.fetcher}: {payload.status} ({payload.rows} rows, {payload.duration_ms}ms)" "" "telegram" "$TELEGRAM_CHAT_ID" "bharat-ops" "true"
add_webhook "job-failed" "job_failed" "🚨 {payload.job_name} FAILED: {payload.error}" "" "telegram" "$TELEGRAM_CHAT_ID" "bharat-ops" "true"
add_webhook "tv-alert" "tv_alert" "TradingView: {payload.symbol} {payload.action} @ {payload.price}. Validating risk gates..." "bharat-fetcher-health" "telegram" "$TELEGRAM_CHAT_ID" "bharat-ops" "true"

echo "✅ All webhooks registered! Run 'hermes webhook list' to verify"
