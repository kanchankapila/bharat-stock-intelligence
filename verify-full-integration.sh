#!/bin/bash
# Verify complete Hermes + Bharat integration

REPO_ROOT="D:/Github/bharat-stock-intelligence"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"

echo "╔════════════════════════════════════════════════════════════════════╗"
echo "║  Full Integration Verification                                   ║"
echo "╚════════════════════════════════════════════════════════════════════╝"

PASS=0; FAIL=0
check() { local n=$1; local c=$2; echo -n "  $n... "; if eval "$c" >/dev/null 2>&1; then echo "✅"; ((PASS++)); else echo "❌"; ((FAIL++)); fi; }

echo "1. Core Files"
check "MCP server enhanced" "grep -q 'query_market_rag\|run_alphaquant_backtest\|run_agent_role' $REPO_ROOT/src/server/mcp/market_intelligence_mcp.py"
check "TTS briefing script" "test -f $REPO_ROOT/src/server/scripts/tts_briefing.py"
check "TV webhook handler" "test -f $REPO_ROOT/src/server/tv_webhook_handler.py"
check "Preview widget" "test -f $REPO_ROOT/preview-stock-analysis.html"

echo "2. Hermes Config"
check "Main config" "test -f $HERMES_HOME/config.yaml"
check "Ops profile" "test -f $HERMES_HOME/profiles/bharat-ops/config.yaml"
check "Research profile" "test -f $HERMES_HOME/profiles/bharat-research/config.yaml"
check "Desktop plugin" "test -f $HERMES_HOME/desktop-plugins/bharat-dashboard/plugin.js"
check "Preview widget installed" "test -f $HERMES_HOME/desktop-plugins/bharat-dashboard/preview/stock-analysis.html"

echo "3. Skills"
check "Fetcher health skill" "test -f $HERMES_HOME/skills/bharat-fetcher-health/SKILL.md"
check "Backtest runner skill" "test -f $HERMES_HOME/skills/bharat-backtest-runner/SKILL.md"
check "Model promotion skill" "test -f $HERMES_HOME/skills/bharat-model-promotion/SKILL.md"

echo "4. Scripts"
check "Setup script" "test -f $REPO_ROOT/setup-hermes-integration.sh"
check "Cron registration" "test -f $REPO_ROOT/register-all-hermes-crons.sh"
check "Webhook registration" "test -f $REPO_ROOT/register-all-hermes-webhooks.sh"
check "Kanban init" "test -f $HERMES_HOME/scripts/init-bharat-kanban.sh"
check "TTS briefing installed" "test -f $HERMES_HOME/scripts/tts_briefing.py"

echo "5. TypeScript"
check "tsc passes" "cd $REPO_ROOT && npx tsc --noEmit"

echo "6. Python Syntax"
check "MCP server" "python -m py_compile $REPO_ROOT/src/server/mcp/market_intelligence_mcp.py"
check "TTS briefing" "python -m py_compile $REPO_ROOT/src/server/scripts/tts_briefing.py"
check "TV webhook" "python -m py_compile $REPO_ROOT/src/server/tv_webhook_handler.py"

echo ""
echo "════════════════════════════════════════════════════════════════════"
echo "RESULTS: $PASS passed, $FAIL failed"
if [ $FAIL -eq 0 ]; then
    echo "🎉 ALL CHECKS PASSED — Integration ready!"
    echo ""
    echo "NEXT STEPS:"
    echo "  1. Edit ~/.hermes/.env with your credentials"
    echo "  2. pm2 start ecosystem.full.cjs"
    echo "  3. hermes --profile bharat-ops gateway run"
    echo "  4. ./register-all-hermes-crons.sh"
    echo "  5. ./register-all-hermes-webhooks.sh"
    echo "  6. ./init-bharat-kanban.sh"
    echo "  7. hermes desktop → ⌘K → Reload desktop plugins"
    echo "  8. Test: hermes chat -q 'Analyze RELIANCE with full widget'"
    exit 0
else
    echo "⚠️  Some checks failed"
    exit 1
fi
