import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.resolve(process.cwd(), 'database.sqlite');
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

  -- 7. Scoring & Analysis Signals
  CREATE TABLE IF NOT EXISTS stock_scores (
    symbol TEXT PRIMARY KEY,
    stock_id TEXT,
    score REAL DEFAULT 0,
    positive_count INTEGER DEFAULT 0,
    negative_count INTEGER DEFAULT 0,
    reasons TEXT, -- JSON string of screeners contributing
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_ss_score ON stock_scores(score);

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
