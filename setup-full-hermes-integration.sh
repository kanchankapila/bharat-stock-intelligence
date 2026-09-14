#!/bin/bash
# Complete Hermes + Bharat Integration Setup v2
# Implements all enhanced features: Kanban, TTS Briefings, TV Webhook, Profiles, Preview Widgets

set -e

REPO_ROOT="D:/Github/bharat-stock-intelligence"
# Real credentials come from the repo .env (TELEGRAM Alerts block). Never hardcode a chat id
# here: a hardcoded placeholder silently delivers every alert to a nonexistent chat
# (found 2026-09-14, "no mocked data" pass).
if [ -f "$REPO_ROOT/.env" ]; then
    set -a; . "$REPO_ROOT/.env"; set +a
fi
: "${TELEGRAM_CHAT_ID:?Set TELEGRAM_CHAT_ID in $REPO_ROOT/.env before registering}"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"

echo "╔═══════════════════════════════════════════════════════════════════╗"
echo "║  Bharat Stock Intelligence → Hermes Agent Full Integration      ║"
echo "╚═══════════════════════════════════════════════════════════════════╝"
echo ""

# 1. Install dependencies
echo "📦 Installing dependencies..."
pip install edge-tts pyttsx3 httpx fastapi uvicorn --quiet 2>&1 | tail -3

# 2. Create directory structure
echo ""
echo "📁 Creating directory structure..."
mkdir -p "$HERMES_HOME/profiles/bharat-ops"
mkdir -p "$HERMES_HOME/profiles/bharat-research"
mkdir -p "$HERMES_HOME/desktop-plugins/bharat-dashboard/preview"
mkdir -p "$HERMES_HOME/scripts"
mkdir -p "$HERMES_HOME/skills/bharat-fetcher-health"
mkdir -p "$HERMES_HOME/skills/bharat-backtest-runner"
mkdir -p "$HERMES_HOME/skills/bharat-model-promotion"
mkdir -p "$REPO_ROOT/src/server/scripts"
mkdir -p "$REPO_ROOT/logs"

# 3. Copy Hermes configs
echo ""
echo "⚙️  Installing Hermes configurations..."
cp "$REPO_ROOT/hermes-config.yaml" "$HERMES_HOME/config.yaml"
cp "$REPO_ROOT/hermes-profiles.yaml" "$HERMES_HOME/profiles/bharat-ops/config.yaml"
# Extract research profile (second document in YAML)
awk '/^# ─── bharat-research Profile/,/^---$/' "$REPO_ROOT/hermes-profiles.yaml" | head -n -1 | tail -n +2 > "$HERMES_HOME/profiles/bharat-research/config.yaml"

# 4. Install desktop plugin
echo ""
echo "🔌 Installing desktop plugin..."
cp "$REPO_ROOT/bharat-dashboard-plugin.js" "$HERMES_HOME/desktop-plugins/bharat-dashboard/plugin.js"

# 5. Install preview widget
echo ""
echo "📊 Installing preview widget..."
cp "$REPO_ROOT/preview-stock-analysis.html" "$HERMES_HOME/desktop-plugins/bharat-dashboard/preview/stock-analysis.html"

# 6. Install skills
echo ""
echo "🧠 Installing skills..."
for skill_dir in "$HERMES_HOME/skills"/*/; do
    skill_name=$(basename "$skill_dir")
    if [ -f "$REPO_ROOT/${skill_name}-skill.md" ]; then
        cp "$REPO_ROOT/${skill_name}-skill.md" "$skill_dir/SKILL.md"
        echo "  ✅ $skill_name"
    fi
done

# 7. Install scripts
echo ""
echo "📜 Installing scripts..."
cp "$REPO_ROOT/src/server/scripts/tts_briefing.py" "$HERMES_HOME/scripts/tts_briefing.py"
chmod +x "$HERMES_HOME/scripts/tts_briefing.py"
# Create symlink for easy access
ln -sf "$HERMES_HOME/scripts/tts_briefing.py" "$REPO_ROOT/tts_briefing.py"

# 8. Install TV webhook handler
echo ""
echo "📡 Installing TradingView webhook handler..."
cp "$REPO_ROOT/src/server/tv_webhook_handler.py" "$REPO_ROOT/tv_webhook_handler.py"

# 9. Create .env template
echo ""
echo "🔐 Creating .env template..."
cat > "$HERMES_HOME/.env.template" << 'EOF'
# ============================================================
# Bharat Stock Intelligence — Hermes Environment
# COPY THIS TO ~/.hermes/.env AND FILL IN ALL VALUES
# ============================================================

# Database (REQUIRED)
POSTGRES_URL=postgresql://user:pass@localhost:5433/bharat

# Hermes Core
WEBHOOK_SECRET=generate-with-openssl-rand-hex-32
HERMES_HOME=/home/user/.hermes

# Model API Keys (at least one required)
OPENROUTER_API_KEY=sk-or-...
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GROQ_API_KEY=gsk_...
GOOGLE_API_KEY=...

# Telegram (for alerts & voice briefings)
TELEGRAM_BOT_TOKEN=<copy TELEGRAM_BOT_TOKEN from the repo .env>
TELEGRAM_CHAT_ID=<copy TELEGRAM_CHAT_ID from the repo .env>

# TradingView Webhook
TV_WEBHOOK_SECRET=generate-random-hex-32
TV_PASSPHRASE=your-secret-passphrase
TV_WEBHOOK_PORT=8003

# AlphaQuant API
ALPHAQUANT_URL=http://127.0.0.1:8002

# Risk Gates
MIN_WIN_PROB=0.52
MAX_POSITION_PCT=0.05

# AWS (for pg-backup)
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_DEFAULT_REGION=ap-south-1
S3_BACKUP_BUCKET=bharat-stock-backups

# GitHub (for webhook delivery)
GITHUB_TOKEN=ghp_...
EOF

if [ ! -f "$HERMES_HOME/.env" ]; then
    cp "$HERMES_HOME/.env.template" "$HERMES_HOME/.env"
    # Auto-populate real values from the repo .env (same as setup-hermes-integration.sh):
    # a placeholder DB URL or chat id would silently break the first cron run.
    if [ -f "$REPO_ROOT/.env" ]; then
        set -a; source "$REPO_ROOT/.env"; set +a
        [ -n "$POSTGRES_URL" ] && sed -i "s|^POSTGRES_URL=.*|POSTGRES_URL=${POSTGRES_URL}|" "$HERMES_HOME/.env"
        [ -n "$TELEGRAM_BOT_TOKEN" ] && sed -i "s|^TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}|" "$HERMES_HOME/.env"
        [ -n "$TELEGRAM_CHAT_ID" ] && sed -i "s|^TELEGRAM_CHAT_ID=.*|TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID}|" "$HERMES_HOME/.env"
    fi
    if command -v openssl &> /dev/null; then
        sed -i "s|^WEBHOOK_SECRET=.*|WEBHOOK_SECRET=$(openssl rand -hex 32)|" "$HERMES_HOME/.env"
    fi
    echo "✅ Created ~/.hermes/.env — provider keys (OPENROUTER/GITHUB/AWS/TV) still need your values"
else
    echo "✅ ~/.hermes/.env already exists"
fi

# 10. Create PM2 ecosystem for all services
echo ""
echo "📝 Creating PM2 ecosystem..."
cat > "$REPO_ROOT/ecosystem.full.cjs" << 'EOF'
module.exports = {
  apps: [
    // Core API Services (unchanged)
    {
      name: 'bharat-server',
      script: 'server.ts',
      interpreter: 'tsx',
      cwd: 'D:/Github/bharat-stock-intelligence',
      env: { PORT: 3000, NODE_ENV: 'production' },
      autorestart: true, max_restarts: 10, restart_delay: 3000,
      out_file: 'logs/bharat-server-out.log', error_file: 'logs/bharat-server-err.log'
    },
    {
      name: 'ml-api',
      script: 'src/server/python_api.py',
      interpreter: 'backend-python/venv/Scripts/python.exe',
      cwd: 'D:/Github/bharat-stock-intelligence',
      env: { PYTHON_API_PORT: 8000, PYTHONPATH: 'src/server' },
      autorestart: true, max_restarts: 10, restart_delay: 3000,
      out_file: 'logs/ml-api-out.log', error_file: 'logs/ml-api-err.log'
    },
    {
      name: 'chatbot',
      script: 'src/server/chatbot/app.py',
      interpreter: 'backend-python/venv/Scripts/python.exe',
      cwd: 'D:/Github/bharat-stock-intelligence',
      env: { CHATBOT_PORT: 8001, PYTHONPATH: 'src/server' },
      autorestart: true, max_restarts: 10, restart_delay: 3000,
      out_file: 'logs/chatbot-out.log', error_file: 'logs/chatbot-err.log'
    },
    {
      name: 'alphaquant-api',
      script: 'backend-python/main.py',
      interpreter: 'backend-python/venv/Scripts/python.exe',
      cwd: 'D:/Github/bharat-stock-intelligence',
      env: { PYTHON_PORT: 8002, PYTHONPATH: 'backend-python' },
      autorestart: true, max_restarts: 10, restart_delay: 3000,
      out_file: 'logs/alphaquant-out.log', error_file: 'logs/alphaquant-err.log'
    },
    // TradingView Webhook Handler (NEW)
    {
      name: 'tv-webhook',
      script: 'tv_webhook_handler.py',
      interpreter: 'backend-python/venv/Scripts/python.exe',
      cwd: 'D:/Github/bharat-stock-intelligence',
      env: { TV_WEBHOOK_PORT: 8003, PYTHONPATH: 'src/server' },
      autorestart: true, max_restarts: 10, restart_delay: 3000,
      out_file: 'logs/tv-webhook-out.log', error_file: 'logs/tv-webhook-err.log'
    },
    // Hermes Gateway (REPLACES BullMQ Cron)
    {
      name: 'hermes-gateway',
      script: 'hermes',
      args: 'gateway run',
      cwd: 'D:/Github/bharat-stock-intelligence',
      env: {
        HERMES_HOME: 'C:\\Users\\amitk\\.hermes',
        PATH: 'C:\\Users\\amitk\\.hermes\\bin;' + process.env.PATH
      },
      autorestart: true, max_restarts: 10, restart_delay: 5000,
      out_file: 'logs/hermes-gateway-out.log', error_file: 'logs/hermes-gateway-err.log'
    },
    // Hermes CLI (interactive)
    {
      name: 'hermes-cli-ops',
      script: 'hermes',
      args: '--profile bharat-ops',
      cwd: 'D:/Github/bharat-stock-intelligence',
      env: {
        HERMES_HOME: 'C:\\Users\\amitk\\.hermes',
        PATH: 'C:\\Users\\amitk\\.hermes\\bin;' + process.env.PATH
      },
      autorestart: false,
      out_file: 'logs/hermes-cli-ops-out.log', error_file: 'logs/hermes-cli-ops-err.log'
    },
    {
      name: 'hermes-cli-research',
      script: 'hermes',
      args: '--profile bharat-research',
      cwd: 'D:/Github/bharat-stock-intelligence',
      env: {
        HERMES_HOME: 'C:\\Users\\amitk\\.hermes',
        PATH: 'C:\\Users\\amitk\\.hermes\\bin;' + process.env.PATH
      },
      autorestart: false,
      out_file: 'logs/hermes-cli-research-out.log', error_file: 'logs/hermes-cli-research-err.log'
    }
  ]
};
EOF

# 11. Create comprehensive cron registration with all enhanced features
echo ""
echo "⏰ Creating enhanced cron registration..."
cat > "$REPO_ROOT/register-all-hermes-crons.sh" << 'SCRIPT_EOF'
#!/bin/bash
# Register ALL Hermes cron jobs including enhanced features

HERMES="hermes"
WORKDIR="D:/Github/bharat-stock-intelligence"

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
add_cron "dlq-reprocess-hourly" "0 * * * *" "Call requeue_dlq to retry failed ingestion entries" "bharat-fetcher-health" "bharat-ops" "telegram" "$TELEGRAM_CHAT_ID"

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
SCRIPT_EOF

chmod +x "$REPO_ROOT/register-all-hermes-crons.sh"

# 12. Create webhook registration
echo ""
echo "🔗 Creating webhook registration..."
cat > "$REPO_ROOT/register-all-hermes-webhooks.sh" << 'SCRIPT_EOF'
#!/bin/bash
HERMES="hermes"
WORKDIR="D:/Github/bharat-stock-intelligence"

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
SCRIPT_EOF

chmod +x "$REPO_ROOT/register-all-hermes-webhooks.sh"

# 13. Create Kanban init script
echo ""
echo "🎯 Creating Kanban initialization..."
cp "$REPO_ROOT/init-bharat-kanban.sh" "$HERMES_HOME/scripts/init-bharat-kanban.sh"
chmod +x "$HERMES_HOME/scripts/init-bharat-kanban.sh"

# 14. Verification script
echo ""
echo "✅ Creating verification script..."
cat > "$REPO_ROOT/verify-full-integration.sh" << 'SCRIPT_EOF'
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
SCRIPT_EOF

chmod +x "$REPO_ROOT/verify-full-integration.sh"

# 15. Run verification
echo ""
echo "🧪 Running verification..."
bash "$REPO_ROOT/verify-full-integration.sh"

echo ""
echo "╔════════════════════════════════════════════════════════════════════╗"
echo "║  ✅ SETUP COMPLETE — All Enhanced Features Installed             ║"
echo "╚════════════════════════════════════════════════════════════════════╝"
echo ""
echo "📋 ENHANCED FEATURES IMPLEMENTED:"
echo ""
echo "  1. AUTONOMOUS KANBAN WORKFLOW"
echo "     → hermes kanban init via init-bharat-kanban.sh"
echo "     → 4 agents (data-scientist, auditor, strategist, optimizer) as columns"
echo "     → Cards auto-move through validation gates"
echo ""
echo "  2. INLINE PREVIEW WIDGETS"
echo "     → ::preview{file=\"stock-analysis.html?symbol=RELIANCE\"}"
echo "     → Real-time price chart, factor breakdown, risk metrics, AI reasoning"
echo "     → Lightweight Charts + Tailwind, theme-aware"
echo ""
echo "  3. TTS AUDIO BRIEFINGS"
echo "     → tts_briefing.py pre_market / post_market"
echo "     → Edge TTS / pyttsx3 → Telegram voice notes"
echo "     → Cron: 8:30 AM & 4:00 PM IST daily"
echo ""
echo "  4. TRADINGVIEW WEBHOOK BRIDGE"
echo "     → tv_webhook_handler.py on port 8003"
echo "     → HMAC verification, quant risk gates, AlphaQuant execution"
echo "     → Blocks trades failing calibrated win_prob / regime / position limits"
echo ""
echo "  5. MULTI-PROFILE ROUTING"
echo "     → bharat-ops (gemini-2.5-flash): 5-min health, DLQ, briefings"
echo "     → bharat-research (claude-3.5-sonnet): weekly discovery, monthly audit"
echo "     → hermes --profile bharat-ops / --profile bharat-research"
echo ""
echo "  6. DOMAIN SKILLS (measurement.md compliant)"
echo "     → bharat-fetcher-health, bharat-backtest-runner, bharat-model-promotion"
echo ""
echo "📁 KEY FILES:"
echo "  ~/.hermes/config.yaml                    # Main config"
echo "  ~/.hermes/profiles/bharat-ops/config.yaml"
echo "  ~/.hermes/profiles/bharat-research/config.yaml"
echo "  ~/.hermes/desktop-plugins/bharat-dashboard/plugin.js"
echo "  ~/.hermes/desktop-plugins/bharat-dashboard/preview/stock-analysis.html"
echo "  ~/.hermes/scripts/tts_briefing.py"
echo "  ~/.hermes/skills/bharat-*/SKILL.md"
echo "  $REPO_ROOT/ecosystem.full.cjs"
echo "  $REPO_ROOT/src/server/mcp/market_intelligence_mcp.py (enhanced)"
echo "  $REPO_ROOT/src/server/tv_webhook_handler.py"
echo ""
echo "🚀 START COMMANDS:"
echo "  pm2 start ecosystem.full.cjs"
echo "  hermes --profile bharat-ops gateway run"
echo "  ./register-all-hermes-crons.sh"
echo "  ./register-all-hermes-webhooks.sh"
echo "  ./init-bharat-kanban.sh"
SCRIPT_EOF

chmod +x "$REPO_ROOT/setup-full-hermes-integration.sh"
bash "$REPO_ROOT/setup-full-hermes-integration.sh"