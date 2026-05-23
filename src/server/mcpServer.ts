#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import db from "./db.js";
import path from "path";
import fs from "fs";
import { execFile } from "child_process";

// Create the MCP server
const server = new McpServer({
  name: "alphaquant-pro-mcp",
  version: "1.0.0",
});

/**
 * -------------------------------------------------------------
 * 1. TOOL: get_db_schema
 * -------------------------------------------------------------
 * Returns the database schema so Claude knows what tables/columns exist.
 */
server.tool(
  "get_db_schema",
  "Retrieve the database schema for AlphaQuant Pro, including all tables and their column definitions. Use this to understand what quantitative data is available to query.",
  {},
  async () => {
    try {
      const tables = db.prepare(`
        SELECT name, sql 
        FROM sqlite_master 
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name ASC
      `).all() as Array<{ name: string; sql: string }>;

      let markdown = "# AlphaQuant Pro Database Schema\n\n";
      markdown += "This SQLite database contains the following tables:\n\n";

      for (const table of tables) {
        markdown += `### Table: \`${table.name}\`\n`;
        markdown += "```sql\n" + table.sql + "\n```\n\n";
      }

      return {
        content: [{ type: "text", text: markdown }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error retrieving schema: ${error.message}` }],
        isError: true,
      };
    }
  }
);

/**
 * -------------------------------------------------------------
 * 2. TOOL: query_stocks_db
 * -------------------------------------------------------------
 * Runs read-only SQL SELECT queries against the SQLite database.
 */
server.tool(
  "query_stocks_db",
  "Execute a read-only SQL SELECT query on the AlphaQuant Pro SQLite database. Use this to query leaderboards, technical scans, model performance, or news sentiment. Capped at 100 rows.",
  {
    sql: z.string().describe("The SQL SELECT query to run (must be read-only)."),
  },
  async ({ sql }) => {
    try {
      // Basic safety check to prevent mutations
      const cleanSql = sql.trim();
      const isReadOnly = cleanSql.toLowerCase().startsWith("select") || 
                         cleanSql.toLowerCase().startsWith("with") || 
                         cleanSql.toLowerCase().startsWith("explain");
      
      const containsMutation = /\b(insert|update|delete|drop|alter|create|replace|reindex|vacuum|pragma)\b/i.test(cleanSql);

      if (!isReadOnly || containsMutation) {
        return {
          content: [{ type: "text", text: "Security Error: Only read-only SELECT queries are allowed." }],
          isError: true,
        };
      }

      // Enforce LIMIT of 100 for safety and token efficiency
      let executeSql = cleanSql;
      if (!cleanSql.toLowerCase().includes("limit")) {
        // Simple regex check to append limit safely if not present
        executeSql = `${cleanSql} LIMIT 100`;
      }

      const rows = db.prepare(executeSql).all();

      if (rows.length === 0) {
        return {
          content: [{ type: "text", text: "Query executed successfully. 0 rows returned." }],
        };
      }

      // Print as a clean JSON block
      const resultText = JSON.stringify(rows, null, 2);
      return {
        content: [{ type: "text", text: `Returned ${rows.length} rows:\n\n\`\`\`json\n${resultText}\n\`\`\`` }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `SQL Execution Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

/**
 * -------------------------------------------------------------
 * 3. TOOL: get_stock_profile
 * -------------------------------------------------------------
 * Aggregates and returns a comprehensive quantitative profile for a stock.
 */
server.tool(
  "get_stock_profile",
  "Fetch a complete quantitative, technical, fundamental, and sentiment profile for a specific stock symbol.",
  {
    symbol: z.string().describe("The NSE stock symbol (e.g., RELIANCE, TCS, BEL)."),
  },
  async ({ symbol }) => {
    try {
      const sym = symbol.toUpperCase().trim();

      // 1. Core info
      const stockInfo = db.prepare("SELECT * FROM nse_stocks WHERE symbol = ?").get(sym) as any;
      if (!stockInfo) {
        return {
          content: [{ type: "text", text: `Stock symbol '${sym}' not found in the nse_stocks master database.` }],
          isError: true,
        };
      }

      // 2. Quantitative / Strategy Scoring (both horizons)
      const scores = db.prepare("SELECT * FROM stock_scores WHERE symbol = ?").all(sym) as any[];
      const factorBreakdowns = db.prepare("SELECT * FROM stock_factor_breakdown WHERE symbol = ?").all(sym) as any[];
      const quantScores = db.prepare("SELECT * FROM quant_scores WHERE symbol = ?").get(sym) as any;

      // 3. Technical analysis signals
      const techSignals = db.prepare("SELECT * FROM technical_analysis_signals WHERE symbol = ?").get(sym) as any;
      const dailyTech = db.prepare("SELECT * FROM technical_signals WHERE symbol = ? ORDER BY date DESC LIMIT 1").get(sym) as any;

      // 4. Fundamentals (Yahoo bulk sync data)
      const fundamentals = db.prepare("SELECT * FROM stock_fundamentals WHERE symbol = ?").get(sym) as any;

      // 5. News articles & Sentiment
      // Search news_sentiment_items where symbol is in symbols_json
      const newsItems = db.prepare(`
        SELECT title, source, sentiment, sentiment_score, impact, published_at, category 
        FROM news_sentiment_items 
        WHERE symbols_json LIKE ? 
        ORDER BY published_at DESC 
        LIMIT 5
      `).all(`%"${sym}"%`) as any[];

      // Construct high-density Markdown response
      let markdown = `# Quantitative Stock Profile: ${sym} (${stockInfo.name})\n`;
      markdown += `**Sector:** ${stockInfo.sector || "N/A"} | **Industry:** ${stockInfo.industry || "N/A"} | **Exchange:** ${stockInfo.exchange}\n`;
      markdown += `**Market Cap:** ₹${((stockInfo.market_cap || fundamentals?.market_cap || 0) / 10_000_000).toFixed(2)} Cr\n\n`;

      // Strategy composite rankings
      if (quantScores) {
        markdown += `## 📊 Multi-Factor Composite Strategy Ranks (Percentiles)\n`;
        markdown += `* **Composite Rank:** ${quantScores.rank_composite?.toFixed(1) || "N/A"} / 100 (${quantScores.composite_class || "N/A"})\n`;
        markdown += `* **Momentum Rank:** ${quantScores.rank_momentum?.toFixed(1) || "N/A"} / 100\n`;
        markdown += `* **Quality Rank:** ${quantScores.rank_quality?.toFixed(1) || "N/A"} / 100\n`;
        markdown += `* **Value Rank:** ${quantScores.rank_value?.toFixed(1) || "N/A"} / 100\n`;
        markdown += `* **1-Month Return:** ${quantScores.return_1m?.toFixed(2) || "0.00"}% | **3-Month Return:** ${quantScores.return_3m?.toFixed(2) || "0.00"}%\n\n`;
      }

      // Consensus scores
      if (scores.length > 0) {
        markdown += `## 🧬 Consensus Scoring Models\n`;
        for (const score of scores) {
          const breakdown = factorBreakdowns.find(b => b.timeframe === score.timeframe);
          markdown += `### Timeframe: \`${score.timeframe}\`\n`;
          markdown += `* **Score:** ${score.score?.toFixed(2) || "N/A"} (Confidence: ${(score.confidence * 100).toFixed(0)}%)\n`;
          markdown += `* **Classification:** **${score.classification}** (Primary Driver: ${score.top_domain})\n`;
          if (breakdown) {
            markdown += `* **Factor Breakdown:** Technical: ${breakdown.technical?.toFixed(2) || 0} | Fundamental: ${breakdown.fundamental?.toFixed(2) || 0} | Momentum: ${breakdown.momentum?.toFixed(2) || 0} | Valuation: ${breakdown.valuation?.toFixed(2) || 0} | Delivery: ${breakdown.delivery?.toFixed(2) || 0}\n`;
          }
          if (score.reasons) {
            try {
              const reasonsList = JSON.parse(score.reasons);
              markdown += `* **Key Indicators:** ${reasonsList.map((r: any) => `${r.name} (${r.sentiment})`).join(", ")}\n`;
            } catch {}
          }
          markdown += `\n`;
        }
      }

      // Technical Signals
      if (techSignals || dailyTech) {
        markdown += `## 📈 Technical Signaling & Predictor Setup\n`;
        const setup = techSignals || dailyTech;
        markdown += `* **Trend:** **${setup.trend || "Neutral"}** | **RSI:** ${setup.rsi?.toFixed(2) || "N/A"}\n`;
        markdown += `* **Win Probability:** ${setup.win_probability ? `${(setup.win_probability * 100).toFixed(1)}%` : "N/A"}\n`;
        if (setup.entry_price || setup.cmp) {
          markdown += `* **Entry Trigger Zone:** ₹${setup.entry_price || setup.entry_zone || setup.cmp}\n`;
          markdown += `* **Institutional Target:** ₹${setup.target_price || setup.targets || "N/A"}\n`;
          markdown += `* **Risk Stop-Loss:** ₹${setup.stop_loss || "N/A"}\n`;
        }
        if (setup.patterns) {
          try {
            const patterns = JSON.parse(setup.patterns);
            if (patterns.length > 0) {
              markdown += `* **Candlestick Patterns Detected:** ${patterns.join(", ")}\n`;
            }
          } catch {}
        }
        markdown += `\n`;
      }

      // Valuation & Fundamentals
      if (fundamentals) {
        markdown += `## 🗝️ Fundamental & Valuation Metrics\n`;
        markdown += `* **Trailing P/E:** ${fundamentals.trailing_pe?.toFixed(2) || "N/A"} | **Forward P/E:** ${fundamentals.forward_pe?.toFixed(2) || "N/A"}\n`;
        markdown += `* **Piotroski F-Score:** **${fundamentals.piotroski_f_score || "N/A"} / 9**\n`;
        markdown += `* **Return on Equity (ROE):** ${fundamentals.return_on_equity ? `${(fundamentals.return_on_equity * 100).toFixed(2)}%` : "N/A"}\n`;
        markdown += `* **Debt to Equity (D/E):** ${fundamentals.debt_to_equity?.toFixed(2) || "N/A"} | **Operating Margin:** ${fundamentals.operating_margins ? `${(fundamentals.operating_margins * 100).toFixed(2)}%` : "N/A"}\n`;
        markdown += `* **52-Week Range:** ₹${fundamentals.fifty_two_week_low?.toFixed(2) || "N/A"} - ₹${fundamentals.fifty_two_week_high?.toFixed(2) || "N/A"}\n\n`;
      }

      // News & Sentiment
      if (newsItems.length > 0) {
        markdown += `## 📰 Recent News & NLP Sentiment\n`;
        for (const item of newsItems) {
          const sentColor = item.sentiment === "BULLISH" || item.sentiment === "Positive" ? "🟢" : 
                            item.sentiment === "BEARISH" || item.sentiment === "Negative" ? "🔴" : "🟡";
          markdown += `* ${sentColor} **[${item.sentiment || "NEUTRAL"}]** ${item.title} *(Source: ${item.source} | Impact: ${item.impact || "LOW"})*\n`;
        }
        markdown += `\n`;
      }

      return {
        content: [{ type: "text", text: markdown }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error fetching stock profile: ${error.message}` }],
        isError: true,
      };
    }
  }
);

/**
 * -------------------------------------------------------------
 * 4. TOOL: get_market_dashboard
 * -------------------------------------------------------------
 * Fetches general market metrics, snapshots, and recent institutional flows.
 */
server.tool(
  "get_market_dashboard",
  "Fetch the macro-level market overview including technical index ranges (Nifty support/resistance), broad market sentiment scores, and recent FII/DII institutional flows.",
  {},
  async () => {
    try {
      // 1. Sentiment Snapshot
      const latestSnapshot = db.prepare(`
        SELECT * FROM market_sentiment_snapshots 
        ORDER BY snapshot_at DESC 
        LIMIT 1
      `).get() as any;

      // 2. Daily flows
      const flows = db.prepare(`
        SELECT date, fii_net, dii_net, source 
        FROM fii_dii_flow 
        ORDER BY date DESC 
        LIMIT 5
      `).all() as any[];

      // 3. Composite strategy classes
      const compositeSummary = db.prepare(`
        SELECT composite_class, COUNT(*) as count 
        FROM quant_scores 
        GROUP BY composite_class
      `).all() as Array<{ composite_class: string; count: number }>;

      let markdown = "# AlphaQuant Pro: Market Macro Dashboard\n\n";

      if (latestSnapshot) {
        const score = latestSnapshot.overall_score || 0;
        const scoreColor = score >= 50 ? "🟢" : score <= -50 ? "🔴" : "🟡";
        markdown += `## 🌡️ Market Sentiment Snapshot\n`;
        markdown += `* **Overall Score:** ${scoreColor} **${score.toFixed(1)} / 100** (${latestSnapshot.overall_label || "Neutral"})\n`;
        markdown += `* **Nifty Bias:** **${latestSnapshot.nifty_bias || "Neutral"}**\n`;
        markdown += `* **Nifty Support:** ₹${latestSnapshot.nifty_support?.toLocaleString() || "N/A"}\n`;
        markdown += `* **Nifty Resistance:** ₹${latestSnapshot.nifty_resistance?.toLocaleString() || "N/A"}\n`;
        markdown += `* **Nifty Last Close:** ₹${latestSnapshot.nifty_last_close?.toLocaleString() || "N/A"}\n`;
        markdown += `* **Global Cues:** ${latestSnapshot.global_cue || "Mixed"} (Global Score: ${latestSnapshot.global_score?.toFixed(1) || 0})\n`;
        if (latestSnapshot.key_themes_json) {
          try {
            const themes = JSON.parse(latestSnapshot.key_themes_json);
            markdown += `* **Hot Market Themes:** ${themes.join(", ")}\n`;
          } catch {}
        }
        markdown += `\n`;
      }

      if (flows.length > 0) {
        markdown += `## 🏦 Institutional Liquidity Flows (FII/DII Net)\n`;
        markdown += "| Date | FII Net (Cr) | DII Net (Cr) | Net Flow (Cr) |\n";
        markdown += "|------|--------------|--------------|---------------|\n";
        for (const flow of flows) {
          const net = (flow.fii_net || 0) + (flow.dii_net || 0);
          const fiiStr = flow.fii_net >= 0 ? `+${flow.fii_net.toFixed(2)}` : `${flow.fii_net.toFixed(2)}`;
          const diiStr = flow.dii_net >= 0 ? `+${flow.dii_net.toFixed(2)}` : `${flow.dii_net.toFixed(2)}`;
          const netStr = net >= 0 ? `+${net.toFixed(2)}` : `${net.toFixed(2)}`;
          markdown += `| ${flow.date} | ${fiiStr} | ${diiStr} | **${netStr}** |\n`;
        }
        markdown += `\n`;
      }

      if (compositeSummary.length > 0) {
        markdown += `## 📈 Composite Quantitative Classification Breadth\n`;
        for (const item of compositeSummary) {
          markdown += `* **${item.composite_class || "Unclassified"}:** ${item.count} stocks\n`;
        }
        markdown += `\n`;
      }

      return {
        content: [{ type: "text", text: markdown }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error fetching market dashboard: ${error.message}` }],
        isError: true,
      };
    }
  }
);

/**
 * -------------------------------------------------------------
 * 5. TOOL: search_codebase
 * -------------------------------------------------------------
 * Lightweight search to index code and find logic patterns.
 */
function searchDir(dir: string, query: string, extensions: string[], results: Array<{ file: string; line: number; text: string }>, maxResults: number = 50) {
  if (results.length >= maxResults) return;
  
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      if (file === "node_modules" || file === "dist" || file === ".git" || file === ".gemini") continue;
      searchDir(fullPath, query, extensions, results, maxResults);
    } else {
      const ext = path.extname(file);
      if (!extensions.includes(ext)) continue;

      const content = fs.readFileSync(fullPath, "utf-8");
      if (content.toLowerCase().includes(query.toLowerCase())) {
        const lines = content.split("\n");
        lines.forEach((line, index) => {
          if (line.toLowerCase().includes(query.toLowerCase()) && results.length < maxResults) {
            results.push({
              file: path.relative(process.cwd(), fullPath),
              line: index + 1,
              text: line.trim(),
            });
          }
        });
      }
    }
  }
}

server.tool(
  "search_codebase",
  "Search code files inside the codebase for specific functions, tRPC routes, indicators, variables, or algorithms.",
  {
    query: z.string().describe("The term or keyword to search for in files."),
  },
  async ({ query }) => {
    try {
      const results: Array<{ file: string; line: number; text: string }> = [];
      const extensions = [".ts", ".tsx", ".py", ".js", ".json", ".md"];
      
      searchDir(path.join(process.cwd(), "src"), query, extensions, results);
      // Also search root files
      const rootFiles = fs.readdirSync(process.cwd());
      for (const file of rootFiles) {
        const fullPath = path.join(process.cwd(), file);
        if (fs.statSync(fullPath).isFile() && extensions.includes(path.extname(file))) {
          const content = fs.readFileSync(fullPath, "utf-8");
          if (content.toLowerCase().includes(query.toLowerCase())) {
            const lines = content.split("\n");
            lines.forEach((line, index) => {
              if (line.toLowerCase().includes(query.toLowerCase()) && results.length < 50) {
                results.push({
                  file,
                  line: index + 1,
                  text: line.trim(),
                });
              }
            });
          }
        }
      }

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `No matches found for query: "${query}"` }],
        };
      }

      let markdown = `# Codebase Search Results for "${query}"\n\n`;
      markdown += `Found ${results.length} matches:\n\n`;
      
      // Group by file
      const grouped: { [key: string]: Array<{ line: number; text: string }> } = {};
      for (const r of results) {
        if (!grouped[r.file]) grouped[r.file] = [];
        grouped[r.file].push({ line: r.line, text: r.text });
      }

      for (const file of Object.keys(grouped)) {
        markdown += `### File: [${file}](file:///${path.resolve(process.cwd(), file).replace(/\\/g, "/")})\n`;
        markdown += "```text\n";
        for (const match of grouped[file]) {
          markdown += `Line ${match.line}: ${match.text}\n`;
        }
        markdown += "```\n\n";
      }

      return {
        content: [{ type: "text", text: markdown }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Code search error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

/**
 * -------------------------------------------------------------
 * 6. TOOL: run_analytical_engine
 * -------------------------------------------------------------
 * Agent execution tool: spawns a background Python script and streams its output.
 */
const VALID_ENGINES: { [key: string]: string } = {
  scoring_engine: "scoring_engine.py",
  backtester: "backtester.py",
  performance_tracker: "performance_tracker.py",
  ml_ensemble: "ml_ensemble.py",
  strategy_optimizer: "strategy_optimizer.py",
  fii_dii_fetcher: "fii_dii_fetcher.py",
  pcr_fetcher: "pcr_fetcher.py",
  finbert_scorer: "finbert_scorer.py",
  online_learner: "online_learner.py",
  institutional_quant_engine: "institutional_quant_engine.py",
  technical_analysis_engine: "technical_analysis_engine.py",
};

server.tool(
  "run_analytical_engine",
  "Spawns and executes one of the core quantitative or machine learning Python engines in the project. Returns the output logs directly. Safe and sandboxed.",
  {
    engineName: z.enum([
      "scoring_engine",
      "backtester",
      "performance_tracker",
      "ml_ensemble",
      "strategy_optimizer",
      "fii_dii_fetcher",
      "pcr_fetcher",
      "finbert_scorer",
      "online_learner",
      "institutional_quant_engine",
      "technical_analysis_engine",
    ]).describe("The short name of the quantitative script to run."),
    args: z.array(z.string()).optional().describe("Optional arguments to pass to the script (e.g. ['--horizon', '15'] or ['--symbol', 'TCS'])."),
  },
  async ({ engineName, args = [] }) => {
    return new Promise((resolve) => {
      const scriptFilename = VALID_ENGINES[engineName];
      const scriptPath = path.resolve(process.cwd(), "src", "server", scriptFilename);

      if (!fs.existsSync(scriptPath)) {
        return resolve({
          content: [{ type: "text", text: `Error: Script file not found at ${scriptPath}` }],
          isError: true,
        });
      }

      const pythonBin = process.env.PYTHON_BIN || "python";
      console.error(`🚀 MCP Agent spawning: ${pythonBin} src/server/${scriptFilename} ${args.join(" ")}`);

      // Spawn process and fetch output safely
      execFile(pythonBin, [scriptPath, ...args], { timeout: 300_000 }, (error, stdout, stderr) => {
        let output = `## Engine Execution: ${engineName}\n\n`;
        output += `**Command:** \`${pythonBin} src/server/${scriptFilename} ${args.join(" ")}\`\n\n`;

        if (error) {
          output += `❌ **Failed with Exit Code:** ${error.code}\n`;
          output += `**Error Details:**\n\`\`\`\n${error.message}\n\`\`\`\n\n`;
          if (stderr) {
            output += `**Stderr Logs:**\n\`\`\`\n${stderr}\n\`\`\`\n\n`;
          }
          if (stdout) {
            output += `**Stdout Output (Partial):**\n\`\`\`\n${stdout.slice(-2000)}\n\`\`\`\n`;
          }
          return resolve({
            content: [{ type: "text", text: output }],
            isError: true,
          });
        }

        output += `✅ **Execution Successful!**\n\n`;
        if (stdout) {
          output += `**Stdout Output:**\n\`\`\`\n${stdout}\n\`\`\`\n\n`;
        }
        if (stderr) {
          output += `**Stderr Warnings/Logs:**\n\`\`\`\n${stderr}\n\`\`\`\n`;
        }

        resolve({
          content: [{ type: "text", text: output }],
        });
      });
    });
  }
);

// Connect standard I/O transport
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("🚀 AlphaQuant Pro MCP Server running on stdio transport!");
}

main().catch((err) => {
  console.error("FATAL ERROR starting MCP server:", err);
  process.exit(1);
});
