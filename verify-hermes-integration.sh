#!/bin/bash
# Verify Hermes Integration for Bharat Stock Intelligence
# Run after setup-hermes-integration.sh

set -e

REPO_ROOT="D:/Github/bharat-stock-intelligence"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Verifying Hermes Integration                                ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

PASS=0
FAIL=0

check() {
    local name=$1
    local cmd=$2
    echo -n "  $name... "
    if eval "$cmd" >/dev/null 2>&1; then
        echo "✅ PASS"
        ((PASS++))
    else
        echo "❌ FAIL"
        ((FAIL++))
    fi
}

check_output() {
    local name=$1
    local cmd=$2
    local expect=$3
    echo -n "  $name... "
    output=$(eval "$cmd" 2>&1)
    if echo "$output" | grep -q "$expect"; then
        echo "✅ PASS"
        ((PASS++))
    else
        echo "❌ FAIL (expected: $expect)"
        echo "     Output: $(echo "$output" | head -1)"
        ((FAIL++))
    fi
}

# 1. Hermes installation
echo "1. Hermes Installation"
check "hermes command exists" "command -v hermes"
check "hermes version" "hermes --version"
check "MCP Python package" "python -c 'import mcp'"

# 2. Config files
echo ""
echo "2. Configuration Files"
check "config.yaml exists" "test -f $HERMES_HOME/config.yaml"
check ".env exists" "test -f $HERMES_HOME/.env"
check "desktop plugin exists" "test -f $HERMES_HOME/desktop-plugins/bharat-dashboard/plugin.js"
check "skills installed" "test -d $HERMES_HOME/skills/bharat-fetcher-health && test -d $HERMES_HOME/skills/bharat-backtest-runner && test -d $HERMES_HOME/skills/bharat-model-promotion"

# 3. Config content validation
echo ""
echo "3. Config Validation"
check_output "MCP server configured" "grep -c 'bharat-intelligence' $HERMES_HOME/config.yaml" "1"
check_output "Webhook platform enabled" "grep -c 'webhook:' $HERMES_HOME/config.yaml" "1"
check_output "Toolsets include terminal" "grep -c 'terminal' $HERMES_HOME/config.yaml" "1"
check_output "Toolsets include cronjob" "grep -c 'cronjob' $HERMES_HOME/config.yaml" "1"

# 4. MCP Server Test
echo ""
echo "4. MCP Server Functionality"
cd "$REPO_ROOT"
check_output "MCP list_fetchers works" "python -m mcp.market_intelligence_mcp list_fetchers 2>&1" "fetcher"
check_output "MCP inspect_ingestion_health works" "python -m mcp.market_intelligence_mcp inspect_ingestion_health 2>&1" "heartbeats"

# 5. Database Connectivity
echo ""
echo "5. Database Connectivity"
if [ -n "$POSTGRES_URL" ]; then
    check_output "PostgreSQL connection" "psql \"$POSTGRES_URL\" -c 'SELECT 1' 2>&1" "1 row"
else
    echo "  ⚠️  SKIP: POSTGRES_URL not set"
fi

# 6. Cron Jobs
echo ""
echo "6. Cron Jobs"
if command -v hermes &> /dev/null; then
    cron_count=$(hermes cron list 2>&1 | grep -c "bharat\|ml-daily\|stock-scoring\|quant-scoring\|fundamentals\|weekly\|intraday\|mover\|trendlyne\|confluence\|digest\|sync\|dl-\|agent-\|health\|dlq\|quality\|ohlcv\|unified\|gdelt\|pg-backup" || true)
    echo "  Cron jobs registered: $cron_count"
    if [ "$cron_count" -gt 20 ]; then
        echo "  ✅ PASS"
        ((PASS++))
    else
        echo "  ❌ FAIL (expected >20)"
        ((FAIL++))
    fi
else
    echo "  ⚠️  SKIP: hermes not in PATH"
fi

# 7. Webhooks
echo ""
echo "7. Webhooks"
if command -v hermes &> /dev/null; then
    webhook_count=$(hermes webhook list 2>&1 | grep -c "github\|prometheus\|grafana\|fetcher\|job_\|agent" || true)
    echo "  Webhooks registered: $webhook_count"
    if [ "$webhook_count" -gt 5 ]; then
        echo "  ✅ PASS"
        ((PASS++))
    else
        echo "  ❌ FAIL (expected >5)"
        ((FAIL++))
    fi
else
    echo "  ⚠️  SKIP: hermes not in PATH"
fi

# 8. Desktop Plugin Syntax
echo ""
echo "8. Desktop Plugin"
check_output "Plugin JS syntax valid" "node --check $HERMES_HOME/desktop-plugins/bharat-dashboard/plugin.js 2>&1" ""

# 9. TypeScript Build
echo ""
echo "9. TypeScript Build"
cd "$REPO_ROOT"
check "npx tsc --noEmit" "npx tsc --noEmit 2>&1 | tail -5"

# 10. Python Tests
echo ""
echo "10. Python Tests"
check "pytest smoke test" "python -m pytest src/server/__tests__/ -x -q --tb=line 2>&1 | head -20"

# Summary
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  RESULTS: $PASS passed, $FAIL failed"
echo "╚══════════════════════════════════════════════════════════════╝"

if [ $FAIL -eq 0 ]; then
    echo ""
    echo "🎉 All checks passed! Integration is ready."
    echo ""
    echo "Next: Start Hermes gateway and test:"
    echo "  hermes gateway run"
    echo "  hermes chat -q \"Check ingestion health\""
    exit 0
else
    echo ""
    echo "⚠️  Some checks failed. Review output above."
    exit 1
fi