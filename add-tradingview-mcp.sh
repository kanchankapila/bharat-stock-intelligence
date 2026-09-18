#!/bin/bash
# Configure Hermes to connect to TradingView official MCP server
# Run after: hermes setup

set -e

HERMES="hermes"
WORKDIR="D:/Github/bharat-stock-intelligence"

echo "🔗 Adding TradingView MCP server to Hermes..."

# Add TradingView MCP server (requires OAuth - will prompt for auth on first use)
$HERMES mcp add tradingview --transport http --url "https://mcp.tradingview.com/mcp" --workdir "$WORKDIR"

echo "✅ TradingView MCP server added."
echo ""
echo "On first use, Hermes will prompt you to authorize with your TradingView account via OAuth."
echo ""
echo "Available TradingView MCP tools:"
echo "  • list_watchlists / get_watchlist / create_watchlist / add_to_watchlist"
echo "  • get_ohlcv / get_economic_data / search_symbols"
echo "  • run_screener / get_symbol_data / get_technicals_rating"
echo "  • get_news / get_forecasts / get_financials / get_financial_history"
echo "  • create_alert / list_alerts / get_alerts_log"
echo "  • get_documents (filings, transcripts, presentations)"
echo ""
echo "Test with: hermes mcp call tradingview list_watchlists"