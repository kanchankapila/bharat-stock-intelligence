import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.resolve(process.cwd(), process.env.DATABASE_URL || 'database.sqlite');
const db = new Database(dbPath);

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');

/**
 * Initialize Database Schema
 * All tables required for all features are created here if they don't exist.
 */
db.exec(`
  -- 1. Users & Personalization
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT,
    name TEXT,
    photoURL TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS watchlist (
    userId TEXT NOT NULL,
    symbol TEXT NOT NULL,
    addedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (userId, symbol),
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
  );

  -- 2. Core Stock Data
  CREATE TABLE IF NOT EXISTS nse_stocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    sector TEXT,
    industry TEXT,
    isin TEXT,
    listing_date TEXT,
    exchange TEXT DEFAULT 'NSE',
    status TEXT DEFAULT 'ACTIVE',
    market_cap REAL,
    pe_ratio REAL,
    dividend_yield REAL,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_nse_symbol ON nse_stocks(symbol);
  CREATE INDEX IF NOT EXISTS idx_nse_sector ON nse_stocks(sector);

  -- 3. Historical Data & Scans Cache
  CREATE TABLE IF NOT EXISTS historical_ohlc (
    symbol TEXT NOT NULL,
    duration TEXT NOT NULL, -- 'D', 'W', 'M', '15m', etc.
    data TEXT NOT NULL, -- JSON string
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, duration)
  );

  CREATE TABLE IF NOT EXISTS technical_scans (
    symbol TEXT PRIMARY KEY,
    data TEXT, -- JSON string
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- 4. Trendlyne Intelligence
  CREATE TABLE IF NOT EXISTS trendlyne_screeners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    screener_id TEXT UNIQUE NOT NULL,
    screener_name TEXT NOT NULL,
    screenpk TEXT NOT NULL,
    description TEXT,
    sentiment TEXT DEFAULT 'neutral', -- 'bullish', 'bearish', 'neutral'
    category TEXT DEFAULT 'technical', -- 'technical', 'fundamental', 'valuation', 'delivery'
    timeframe TEXT DEFAULT 'long_term', -- 'intraday', 'long_term'
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS trendlyne_screener_stocks (
    screener_id TEXT NOT NULL,
    stock_id TEXT NOT NULL,
    symbol TEXT,
    PRIMARY KEY (screener_id, stock_id),
    FOREIGN KEY (screener_id) REFERENCES trendlyne_screeners(screener_id)
  );

  CREATE INDEX IF NOT EXISTS idx_tss_symbol ON trendlyne_screener_stocks(symbol);

  -- 5. MoneyControl Intelligence
  CREATE TABLE IF NOT EXISTS moneycontrol_screeners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id TEXT UNIQUE NOT NULL,
    cat_id TEXT NOT NULL,
    screener_name TEXT NOT NULL,
    type TEXT NOT NULL, -- 'proscanner', 'techscanner', or 'technical-trends'
    is_positive INTEGER DEFAULT 1, -- 1 for positive, 0 for negative
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS moneycontrol_screener_stocks (
    scan_id TEXT NOT NULL,
    mcsymbol TEXT NOT NULL,
    stock_name TEXT,
    symbol TEXT,
    PRIMARY KEY (scan_id, mcsymbol),
    FOREIGN KEY (scan_id) REFERENCES moneycontrol_screeners(scan_id)
  );

  CREATE INDEX IF NOT EXISTS idx_mss_symbol ON moneycontrol_screener_stocks(symbol);

  -- 5b. Unified Screener Metadata (NLP Inferred)
  CREATE TABLE IF NOT EXISTS screener_master (
    scan_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source TEXT NOT NULL,
    inferred_sentiment TEXT, -- 'bullish', 'bearish', 'neutral'
    inferred_category TEXT,  -- 'technical', 'fundamental', etc.
    inferred_timeframe TEXT DEFAULT 'long_term', -- 'long_term', 'intraday'
    confidence REAL,
    weight_override REAL,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- 6. ETnow Intelligence (Placeholder for future sync)
  CREATE TABLE IF NOT EXISTS etnow_screeners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    screener_id TEXT UNIQUE NOT NULL,
    screener_name TEXT NOT NULL,
    query_condition TEXT,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS etnow_screener_stocks (
    screener_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    stock_name TEXT,
    PRIMARY KEY (screener_id, symbol),
    FOREIGN KEY (screener_id) REFERENCES etnow_screeners(screener_id)
  );

  -- 6b. News & Sentiment
  CREATE TABLE IF NOT EXISTS news_articles (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    summary TEXT,
    source TEXT,
    sentiment TEXT, -- 'Positive', 'Negative', 'Neutral'
    category TEXT,
    url TEXT,
    symbols TEXT, -- Comma-separated symbols
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- 7. Scoring & Analysis Signals
  CREATE TABLE IF NOT EXISTS stock_scores (
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL, -- 'long_term' | 'intraday'
    score REAL,
    confidence REAL,
    classification TEXT, -- 'Strong Buy' | 'Buy' | 'Hold' | 'Sell' | 'Strong Sell'
    top_domain TEXT, -- 'Fundamental' | 'Technical' | 'Momentum' | 'Delivery'
    positive_count INTEGER,
    negative_count INTEGER,
    reasons TEXT, -- JSON string of screener names/sentiments
    last_updated TEXT,
    PRIMARY KEY (symbol, timeframe)
  );

  CREATE INDEX IF NOT EXISTS idx_ss_score ON stock_scores(score);
  CREATE INDEX IF NOT EXISTS idx_ss_class ON stock_scores(classification);
  CREATE INDEX IF NOT EXISTS idx_ss_timeframe ON stock_scores(timeframe);

  CREATE TABLE IF NOT EXISTS stock_factor_breakdown (
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL DEFAULT 'long_term',
    technical REAL DEFAULT 0,
    fundamental REAL DEFAULT 0,
    momentum REAL DEFAULT 0,
    valuation REAL DEFAULT 0,
    delivery REAL DEFAULT 0,
    news REAL DEFAULT 0,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, timeframe),
    FOREIGN KEY (symbol, timeframe) REFERENCES stock_scores(symbol, timeframe) ON DELETE CASCADE
  );

  -- 8. Historical Price Data (Structured for Python Analysis)
  CREATE TABLE IF NOT EXISTS stock_ohlcv (
    symbol TEXT NOT NULL,
    date TEXT NOT NULL,
    open REAL,
    high REAL,
    low REAL,
    close REAL,
    volume INTEGER,
    PRIMARY KEY (symbol, date)
  );

  -- 9. Technical Analysis Signals & Predictions
  CREATE TABLE IF NOT EXISTS technical_analysis_signals (
    symbol TEXT PRIMARY KEY,
    trend TEXT, -- 'Bullish' | 'Bearish' | 'Neutral'
    rsi REAL,
    macd TEXT,
    bollinger TEXT,
    patterns TEXT, -- JSON array of detected candlestick patterns
    entry_price REAL,
    target_price REAL,
    stop_loss REAL,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- 10. Signals
  CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    type TEXT CHECK(type IN ('BUY', 'SELL', 'HOLD')) NOT NULL,
    entry REAL,
    target REAL,
    stopLoss REAL,
    confidence REAL,
    reasoning TEXT,
    status TEXT CHECK(status IN ('ACTIVE', 'COMPLETED', 'EXPIRED', 'FAILED')) DEFAULT 'ACTIVE',
    result TEXT CHECK(result IN ('PROFIT', 'LOSS', 'NEUTRAL')),
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- 8. Strategies & Settings
  CREATE TABLE IF NOT EXISTS backtest_strategies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    symbol TEXT NOT NULL,
    timeframe TEXT,
    params TEXT, -- JSON string
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

export default db;
