#!/bin/bash
# Hermes Webhook Subscriptions for Bharat Stock Intelligence
# Run after: hermes gateway setup (enables webhook platform on port 8644)

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

echo "Registering Bharat Stock Intelligence webhook subscriptions..."

# Helper
add_webhook() {
    local name=$1
    local events=$2
    local prompt=$3
    local skills=$4
    local deliver=${5:-"telegram"}
    local deliver_chat=${6:-$TELEGRAM_CHAT_ID}
    local script=${7:-""}
    local secret=${8:-""}
    
    echo "Adding webhook: $name (events: $events)"
    
    cmd="$HERMES webhook subscribe $name --events \"$events\" --prompt \"$prompt\" --workdir \"$WORKDIR\""
    
    if [ -n "$skills" ]; then
        cmd="$cmd --skills \"$skills\""
    fi
    
    if [ -n "$deliver" ]; then
        cmd="$cmd --deliver $deliver"
        if [ -n "$deliver_chat" ]; then
            cmd="$cmd --deliver-chat-id \"$deliver_chat\""
        fi
    fi
    
    if [ -n "$script" ]; then
        cmd="$cmd --script \"$script\""
    fi
    
    if [ -n "$secret" ]; then
        cmd="$cmd --secret \"$secret\""
    fi
    
    eval $cmd
}

# ============================================================
# GITHUB WEBHOOKS (CI/CD, PR reviews, issues)
# ============================================================

add_webhook "github-pr-review" "pull_request" \
    "PR #{pull_request.number} {action}: {pull_request.title}
By: {pull_request.user.login}
Branch: {pull_request.head.ref} → {pull_request.base.ref}

{pull_request.body}

Please review this PR for Bharat Stock Intelligence. Focus on:
1. Fetcher changes (new/removed/modified)
2. Scoring/ranking logic changes
3. Database migration safety
4. Job schedule changes
5. MCP tool additions

Run: npx tsc --noEmit && python -m pytest src/server/__tests__/ src/server/tests/
If tests pass, approve. If not, request changes." \
    "github-code-review,test-driven-development" \
    "github_comment" ""

add_webhook "github-push-main" "push" \
    "Push to {ref} by {pusher.name}
Repo: {repository.full_name}
Commits: {commits.length}

Head commit: {head_commit.message}
Author: {head_commit.author.name}

Files changed: {commits[].modified | join(\", \")}

Triggering CI validation..." \
    "test-driven-development" \
    "telegram" "$TELEGRAM_CHAT_ID"

add_webhook "github-issue-triage" "issues" \
    "New GitHub issue #{issue.number}: {issue.title}
Action: {action}
Author: {issue.user.login}
Labels: {issue.labels[].name | join(\", \")}

Body:
{issue.body}

Please triage this issue for Bharat Stock Intelligence." \
    "bharat-fetcher-health" \
    "telegram" "$TELEGRAM_CHAT_ID"

# ============================================================
# NSE/BSE MARKET DATA WEBHOOKS (if you have provider webhooks)
# ============================================================

# Example: If your data provider supports webhooks on price updates
# add_webhook "nse-tick" "market_data" \
#     "New tick for {payload.symbol}: ₹{payload.price} (vol: {payload.volume}) at {payload.timestamp}
#     Update live prices cache and check price alerts." \
#     "bharat-fetcher-health" \
#     "origin" ""

# ============================================================
# MONITORING/ALERTING WEBHOOKS
# ============================================================

add_webhook "prometheus-alert" "alert" \
    "Alert: {alert.labels.alertname}
Severity: {alert.labels.severity}
Instance: {alert.labels.instance}
Summary: {alert.annotations.summary}
Description: {alert.annotations.description}

Started: {alert.startsAt}
Generator: {alert.generatorURL}

Please investigate and suggest remediation." \
    "bharat-fetcher-health,systematic-debugging" \
    "telegram" "$TELEGRAM_CHAT_ID"

add_webhook "grafana-alert" "grafana" \
    "Grafana Alert: {title}
State: {state}
Message: {message}
Rule: {ruleName}
Dashboard: {dashboardURL}
Panel: {panelURL}

Eval matches: {evalMatches[] | map(\"{.metric} = {.value}\") | join(\", \")}" \
    "bharat-fetcher-health" \
    "telegram" "$TELEGRAM_CHAT_ID"

# ============================================================
# SCHEDULED TRIGGERS (via cron calling webhook)
# ============================================================

# These would be triggered by external cron (e.g., GitHub Actions, GitLab CI, Jenkins)
# add_webhook "daily-backtest-trigger" "schedule" \
#     "Daily scheduled backtest trigger. Run factor validation pipeline." \
#     "bharat-backtest-runner" \
#     "telegram" "$TELEGRAM_CHAT_ID"

# ============================================================
# DIRECT DELIVERY (no agent, zero LLM cost)
# ============================================================

add_webhook "fetcher-complete-notification" "fetcher_done" \
    "✅ Fetcher {payload.fetcher} completed: {payload.status} ({payload.rows} rows, {payload.duration_ms}ms)" \
    "" \
    "telegram" "$TELEGRAM_CHAT_ID" \
    "" \
    "" \
    "--deliver-only"

add_webhook "job-failed-alert" "job_failed" \
    "🚨 Job {payload.job_name} FAILED
Queue: {payload.queue}
Error: {payload.error}
Duration: {payload.duration_ms}ms
Started: {payload.started_at}

Check Hermes dashboard or run: hermes chat -q \"Inspect ingestion health\"" \
    "" \
    "telegram" "$TELEGRAM_CHAT_ID" \
    "" \
    "" \
    "--deliver-only"

# ============================================================
# INTERNAL HERMES-TO-HERMES (inter-agent communication)
# ============================================================

add_webhook "agent-handoff" "agent_handoff" \
    "Agent {payload.from_agent} → {payload.to_agent}
Task: {payload.task}
Context: {payload.context}
Priority: {payload.priority}" \
    "" \
    "telegram" "$TELEGRAM_CHAT_ID" \
    "" \
    "" \
    "--deliver-only"

echo ""
echo "All webhook subscriptions registered! Run 'hermes webhook list' to verify."
echo ""
echo "Next steps:"
echo "1. Configure GitHub webhook: Settings → Webhooks → Add webhook"
echo "   - Payload URL: http://<your-host>:8644/webhook/github-pr-review"
echo "   - Content type: application/json"
echo "   - Secret: (shown in 'hermes webhook list')"
echo "   - Events: Pull requests, Pushes, Issues"
echo ""
echo "2. Configure monitoring (Prometheus/Grafana) to POST to:"
echo "   http://<your-host>:8644/webhook/prometheus-alert"
echo ""
echo "3. Set WEBHOOK_SECRET in ~/.hermes/.env"
echo "4. Start gateway: hermes gateway run"