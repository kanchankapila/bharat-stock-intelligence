#!/bin/bash
# Complete Hermes Integration Setup for Bharat Stock Intelligence
# Run this script to set up everything end-to-end

set -e

REPO_ROOT="D:/Github/bharat-stock-intelligence"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Bharat Stock Intelligence → Hermes Agent Integration       ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# 1. Check prerequisites
echo "📋 Checking prerequisites..."

# Check Hermes installed
if ! command -v hermes &> /dev/null; then
    echo "❌ Hermes not found. Installing..."
    curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
    export PATH="$HOME/.hermes/bin:$PATH"
else
    echo "✅ Hermes found: $(hermes --version)"
fi

# Check MCP Python package
if ! python -c "import mcp" 2>/dev/null; then
    echo "📦 Installing MCP Python package..."
    pip install mcp
else
    echo "✅ MCP package installed"
fi

# Check PostgreSQL connectivity
if [ -z "$POSTGRES_URL" ]; then
    echo "⚠️  POSTGRES_URL not set. Please set it in your environment or ~/.hermes/.env"
    echo "   Example: postgresql://user:pass@localhost:5433/bharat"
fi

# 2. Create Hermes config directory
echo ""
echo "📁 Setting up Hermes configuration..."
mkdir -p "$HERMES_HOME"
mkdir -p "$HERMES_HOME/desktop-plugins"
mkdir -p "$HERMES_HOME/skills"
mkdir -p "$HERMES_HOME/scripts"
mkdir -p "$HERMES_HOME/logs"

# 3. Copy config
echo ""
echo "⚙️  Installing Hermes config..."
cp "$REPO_ROOT/hermes-config.yaml" "$HERMES_HOME/config.yaml"
echo "✅ Config installed to $HERMES_HOME/config.yaml"

# 4. Copy desktop plugin
echo ""
echo "🔌 Installing desktop plugin..."
mkdir -p "$HERMES_HOME/desktop-plugins/bharat-dashboard"
cp "$REPO_ROOT/bharat-dashboard-plugin.js" "$HERMES_HOME/desktop-plugins/bharat-dashboard/plugin.js"
echo "✅ Desktop plugin installed"

# 5. Install skills
echo ""
echo "🧠 Installing skills..."
for skill in "$REPO_ROOT"/bharat-*-skill.md; do
    if [ -f "$skill" ]; then
        name=$(basename "$skill" -skill.md)
        mkdir -p "$HERMES_HOME/skills/$name"
        cp "$skill" "$HERMES_HOME/skills/$name/SKILL.md"
        echo "  ✅ $name"
    fi
done

# 6. Create .env template
echo ""
echo "🔐 Creating .env template..."
cat > "$HERMES_HOME/.env.template" << 'EOF'
# Bharat Stock Intelligence - Hermes Environment
# Copy to ~/.hermes/.env and fill in values

# Database (REQUIRED)
POSTGRES_URL=postgresql://user:pass@localhost:5433/bharat

# Webhook platform
WEBHOOK_SECRET=your-webhook-secret-here-generate-with-openssl-rand-hex-32

# API Keys (for various providers)
OPENROUTER_API_KEY=sk-or-...
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GROQ_API_KEY=gsk_...
GOOGLE_API_KEY=...

# Telegram (for alerts)
TELEGRAM_BOT_TOKEN=<copy TELEGRAM_BOT_TOKEN from the repo .env>
TELEGRAM_CHAT_ID=<copy TELEGRAM_CHAT_ID from the repo .env>

# GitHub (for webhook delivery)
GITHUB_TOKEN=ghp_...

# AWS (for pg-backup)
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_DEFAULT_REGION=ap-south-1
S3_BACKUP_BUCKET=bharat-stock-backups
EOF

if [ ! -f "$HERMES_HOME/.env" ]; then
    cp "$HERMES_HOME/.env.template" "$HERMES_HOME/.env"
    # Auto-populate the values the repo .env already holds (real DB URL + Telegram
    # credentials) and generate a real webhook secret, so the copied .env is functional
    # rather than a placeholder sheet that silently breaks the first cron run.
    if [ -f "$REPO_ROOT/.env" ]; then
        set -a; source "$REPO_ROOT/.env"; set +a
        [ -n "$POSTGRES_URL" ] && sed -i "s|^POSTGRES_URL=.*|POSTGRES_URL=${POSTGRES_URL}|" "$HERMES_HOME/.env"
        [ -n "$TELEGRAM_BOT_TOKEN" ] && sed -i "s|^TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}|" "$HERMES_HOME/.env"
        [ -n "$TELEGRAM_CHAT_ID" ] && sed -i "s|^TELEGRAM_CHAT_ID=.*|TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID}|" "$HERMES_HOME/.env"
    fi
    if command -v openssl &> /dev/null; then
        sed -i "s|^WEBHOOK_SECRET=.*|WEBHOOK_SECRET=$(openssl rand -hex 32)|" "$HERMES_HOME/.env"
    fi
    echo "✅ Created ~/.hermes/.env.template and ~/.hermes/.env"
    echo "⚠️  EDIT ~/.hermes/.env — provider API keys (OPENROUTER/GITHUB/AWS) still need your values"
else
    echo "✅ ~/.hermes/.env already exists"
fi

# 7. Setup Hermes (run wizard if first time)
echo ""
echo "🚀 Running Hermes setup..."
if [ ! -f "$HERMES_HOME/config.yaml.bak" ]; then
    hermes setup || true
    cp "$HERMES_HOME/config.yaml" "$HERMES_HOME/config.yaml.bak"
    # Restore our config
    cp "$REPO_ROOT/hermes-config.yaml" "$HERMES_HOME/config.yaml"
else
    echo "✅ Hermes already configured"
fi

# 8. Enable webhook platform
echo ""
echo "🌐 Enabling webhook platform..."
hermes gateway setup || true

# 9. Register cron jobs
echo ""
echo "⏰ Registering cron jobs..."
chmod +x "$REPO_ROOT/register-hermes-crons.sh"
"$REPO_ROOT/register-hermes-crons.sh"

# 10. Register webhooks
echo ""
echo "🔗 Registering webhooks..."
chmod +x "$REPO_ROOT/register-hermes-webhooks.sh"
"$REPO_ROOT/register-hermes-webhooks.sh"

# 11. Verify MCP server works
echo ""
echo "🔍 Verifying MCP server..."
cd "$REPO_ROOT"
python -m mcp.market_intelligence_mcp list_fetchers 2>&1 | head -20 || true

# 12. Start Hermes gateway
echo ""
echo "🚀 Starting Hermes gateway..."
echo "Run this in a separate terminal:"
echo "  hermes gateway run"
echo ""
echo "Or with PM2:"
echo "  pm2 start ecosystem.hermes.cjs"

# 13. Create PM2 ecosystem for Hermes
echo ""
echo "📝 Creating PM2 ecosystem for Hermes..."
cat > "$REPO_ROOT/ecosystem.hermes.cjs" << 'EOF'
module.exports = {
  apps: [
    {
      name: 'hermes-gateway',
      script: 'hermes',
      args: 'gateway run',
      cwd: 'D:/Github/bharat-stock-intelligence',
      env: {
        HERMES_HOME: 'C:\\Users\\amitk\\.hermes',
        PATH: 'C:\\Users\\amitk\\.hermes\\bin;' + process.env.PATH
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      out_file: 'logs/hermes-gateway-out.log',
      error_file: 'logs/hermes-gateway-err.log',
      merge_logs: true,
      time: true
    },
    {
      name: 'hermes-cli',
      script: 'hermes',
      args: '--tui',
      cwd: 'D:/Github/bharat-stock-intelligence',
      env: {
        HERMES_HOME: 'C:\\Users\\amitk\\.hermes',
        PATH: 'C:\\Users\\amitk\\.hermes\\bin;' + process.env.PATH
      },
      autorestart: false,
      out_file: 'logs/hermes-cli-out.log',
      error_file: 'logs/hermes-cli-err.log',
      merge_logs: true,
      time: true
    }
  ]
};
EOF

echo "✅ Created ecosystem.hermes.cjs"

# 14. Summary
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  ✅ SETUP COMPLETE                                            ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "📋 NEXT STEPS:"
echo ""
echo "1. EDIT ~/.hermes/.env with your actual credentials"
echo ""
echo "2. START HERMES GATEWAY (required for webhooks, cron, desktop):"
echo "   Option A: hermes gateway run"
echo "   Option B: pm2 start ecosystem.hermes.cjs"
echo ""
echo "3. START HERMES DESKTOP APP (for UI dashboard):"
echo "   hermes desktop"
echo "   → Then: ⌘K → 'Reload desktop plugins'"
echo ""
echo "4. TEST MCP TOOLS:"
echo "   hermes chat -q \"List all fetchers\""
echo "   hermes chat -q \"Check ingestion health\""
echo "   hermes chat -q \"Show top 10 conviction picks\""
echo ""
echo "5. VERIFY CRON JOBS:"
echo "   hermes cron list"
echo "   hermes cron run ingestion-health-check  # test run"
echo ""
echo "6. VERIFY WEBHOOKS:"
echo "   hermes webhook list"
echo "   hermes webhook test github-pr-review"
echo ""
echo "7. MIGRATE FROM PM2 (when ready):"
echo "   pm2 stop bharat-server ml-api chatbot alphaquant-api engine-worker"
echo "   pm2 delete bharat-server ml-api chatbot alphaquant-api engine-worker"
echo "   # Cron jobs now run via Hermes"
echo ""
echo "📚 KEY FILES CREATED:"
echo "  ~/.hermes/config.yaml           - Main Hermes config"
echo "  ~/.hermes/.env                  - Secrets (EDIT THIS)"
echo "  ~/.hermes/desktop-plugins/bharat-dashboard/plugin.js"
echo "  ~/.hermes/skills/bharat-fetcher-health/SKILL.md"
echo "  ~/.hermes/skills/bharat-backtest-runner/SKILL.md"
echo "  ~/.hermes/skills/bharat-model-promotion/SKILL.md"
echo "  $REPO_ROOT/ecosystem.hermes.cjs - PM2 config for Hermes"
echo ""
echo "🎯 VERIFICATION COMMANDS:"
echo "  npx tsc --noEmit                    # TypeScript check"
echo "  npx vitest run                      # Frontend tests"
echo "  python -m pytest src/server/__tests__/ src/server/tests/  # Backend tests"
echo "  hermes doctor                       # Hermes health check"