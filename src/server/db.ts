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

  -- 11. Implementation Ideas & TODOs
  CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT CHECK(status IN ('PENDING', 'IN_PROGRESS', 'COMPLETED')) DEFAULT 'PENDING',
    category TEXT DEFAULT 'IDEAS',
    priority TEXT CHECK(priority IN ('LOW', 'MEDIUM', 'HIGH')) DEFAULT 'MEDIUM',
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- 12. Stock Fundamentals (bulk synced from Yahoo Finance)
  CREATE TABLE IF NOT EXISTS stock_fundamentals (
    symbol TEXT PRIMARY KEY,
    -- Valuation
    trailing_pe REAL,
    forward_pe REAL,
    price_to_book REAL,
    book_value REAL,
    earnings_yield REAL,           -- 1 / trailing_pe
    -- Earnings
    eps_ttm REAL,
    eps_forward REAL,
    -- Size & Market
    market_cap REAL,               -- in INR
    shares_outstanding INTEGER,
    -- Price reference
    fifty_two_week_high REAL,
    fifty_two_week_low REAL,
    fifty_two_week_change_pct REAL,
    sma200 REAL,                   -- Yahoo's 200-day avg
    price_vs_sma200_pct REAL,      -- (price - sma200) / sma200 * 100
    avg_volume_3m INTEGER,
    -- Income
    dividend_yield REAL,
    -- Analyst
    analyst_rating TEXT,           -- e.g. "1.3 - Strong Buy"
    -- Deep fields (Phase 2 — Yahoo quoteSummary, per-symbol)
    debt_to_equity REAL,
    return_on_equity REAL,
    revenue_growth REAL,
    earnings_growth REAL,
    operating_margins REAL,
    current_ratio REAL,
    -- Piotroski components (computed after Phase 2)
    piotroski_f_score INTEGER,
    -- Sync tracking
    phase1_synced_at DATETIME,
    phase2_synced_at DATETIME,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_sf_pe ON stock_fundamentals(trailing_pe);
  CREATE INDEX IF NOT EXISTS idx_sf_mktcap ON stock_fundamentals(market_cap);
  CREATE INDEX IF NOT EXISTS idx_sf_roe ON stock_fundamentals(return_on_equity);

  -- 13. Quantitative Strategy Scores (computed nightly from OHLCV + fundamentals + screeners)
  CREATE TABLE IF NOT EXISTS quant_scores (
    symbol TEXT PRIMARY KEY,

    -- ── Momentum ──────────────────────────────────────────────────────────────
    return_1w  REAL,    -- 5-day price return (%)
    return_1m  REAL,    -- 21-day price return (%)
    return_3m  REAL,    -- 63-day price return (%)
    return_6m  REAL,    -- 126-day price return (%)
    return_12m REAL,    -- 252-day price return (%)
    above_sma200       INTEGER,   -- 1 = price > 200-day SMA
    sma200_distance_pct REAL,     -- (price − SMA200) / SMA200 × 100
    momentum_score     REAL,      -- percentile rank 0–100

    -- ── Risk / Volatility ──────────────────────────────────────────────────
    annualized_vol     REAL,      -- σ(daily_returns) × √252 × 100  (%)
    sharpe_ratio       REAL,      -- (annualised_return − 0.04) / vol
    max_drawdown_1y    REAL,      -- peak-to-trough (%) over last 252 days
    vol_rank           REAL,      -- percentile rank (lower vol = higher rank)
    sharpe_rank        REAL,      -- percentile rank

    -- ── Valuation / Fundamentals ───────────────────────────────────────────
    trailing_pe        REAL,
    forward_pe         REAL,
    debt_to_equity     REAL,
    return_on_equity   REAL,      -- stored as decimal (0.15 = 15%)
    operating_margins  REAL,
    revenue_growth     REAL,
    piotroski_f_score  INTEGER,
    valuation_score    REAL,      -- percentile rank (low PE + high ROE + low D/E)

    -- ── Screener Confluence ────────────────────────────────────────────────
    bullish_screener_count   INTEGER,
    bearish_screener_count   INTEGER,
    screener_category_breadth INTEGER,
    screener_net_score       REAL,    -- bullish_weighted − bearish_weighted
    confluence_rank          REAL,    -- percentile rank

    -- ── Composite Strategy Ranks (0–100 percentile) ────────────────────────
    rank_momentum    REAL,   -- pure momentum strategy
    rank_quality     REAL,   -- momentum × (low vol) × (high Sharpe)
    rank_value       REAL,   -- valuation screen (PE + D/E + ROE + growth)
    rank_composite   REAL,   -- all four pillars combined

    -- ── Classification ────────────────────────────────────────────────────
    composite_class  TEXT,   -- 'Strong Buy'|'Buy'|'Hold'|'Avoid'|'Sell'
    ohlcv_days       INTEGER,

    last_computed DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_qs_composite  ON quant_scores(rank_composite DESC);
  CREATE INDEX IF NOT EXISTS idx_qs_momentum   ON quant_scores(rank_momentum DESC);
  CREATE INDEX IF NOT EXISTS idx_qs_quality    ON quant_scores(rank_quality DESC);
  CREATE INDEX IF NOT EXISTS idx_qs_value      ON quant_scores(rank_value DESC);
  CREATE INDEX IF NOT EXISTS idx_qs_class      ON quant_scores(composite_class);

  -- 14. Daily Technical Signals (computed from OHLCV — 7 pattern types)
  CREATE TABLE IF NOT EXISTS technical_signals (
    symbol        TEXT NOT NULL,
    date          TEXT NOT NULL,   -- scan date YYYY-MM-DD
    -- Detected signals (serialised)
    signals_json  TEXT,            -- JSON: [{type,strength,detail}]
    signal_score  INTEGER DEFAULT 0, -- 0-10 composite score
    -- Key indicator snapshot
    rsi           REAL,
    sma50         REAL,
    sma200        REAL,
    macd          REAL,
    macd_signal   REAL,
    bb_width      REAL,
    volume_ratio  REAL,
    above_sma200  INTEGER DEFAULT 0,
    -- Price
    cmp           REAL,
    change_pct    REAL,
    -- AI-generated setup (Anthropic, top-N stocks only)
    ai_insight    TEXT,
    entry_zone    TEXT,
    stop_loss     TEXT,
    targets       TEXT,
    setup_quality TEXT,
    time_horizon  TEXT,
    computed_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, date)
  );

  CREATE INDEX IF NOT EXISTS idx_tsig_date  ON technical_signals(date DESC);
  CREATE INDEX IF NOT EXISTS idx_tsig_score ON technical_signals(signal_score DESC);
  CREATE INDEX IF NOT EXISTS idx_tsig_sym   ON technical_signals(symbol);

  -- 15. Signal Outcomes — win rate tracking (entry vs exit N days later)
  CREATE TABLE IF NOT EXISTS signal_outcomes (
    symbol        TEXT NOT NULL,
    signal_date   TEXT NOT NULL,
    horizon_days  INTEGER NOT NULL,   -- 5 or 15
    entry_price   REAL NOT NULL,
    check_date    TEXT,               -- date we found exit price
    exit_price    REAL,
    return_pct    REAL,
    outcome       TEXT,               -- 'WIN' | 'LOSS' | 'NEUTRAL' | 'PENDING'
    signal_score  INTEGER,
    signals_json  TEXT,
    computed_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, signal_date, horizon_days)
  );

  CREATE INDEX IF NOT EXISTS idx_sout_date    ON signal_outcomes(signal_date DESC);
  CREATE INDEX IF NOT EXISTS idx_sout_outcome ON signal_outcomes(outcome);
  CREATE INDEX IF NOT EXISTS idx_sout_sym     ON signal_outcomes(symbol);

  -- 16. News Sentiment Items — enriched news from multiple sources (replaces basic news_articles)
  CREATE TABLE IF NOT EXISTS news_sentiment_items (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    summary       TEXT,
    source        TEXT NOT NULL,
    source_type   TEXT DEFAULT 'INDIAN',  -- 'INDIAN' | 'GLOBAL'
    url           TEXT,
    published_at  DATETIME,
    fetched_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    sentiment     TEXT DEFAULT 'NEUTRAL', -- 'BULLISH' | 'BEARISH' | 'NEUTRAL'
    sentiment_score REAL DEFAULT 0,       -- -1.0 to +1.0
    impact        TEXT DEFAULT 'LOW',     -- 'HIGH' | 'MEDIUM' | 'LOW'
    category      TEXT DEFAULT 'GENERAL', -- 'EARNINGS' | 'ORDER_WIN' | 'BUYBACK' | 'POLICY' | 'IPO' | 'GLOBAL' | 'SECTOR' | 'GENERAL'
    symbols_json  TEXT,                   -- JSON array of NSE symbols mentioned
    sector        TEXT,
    ai_scored     INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_nsi_published ON news_sentiment_items(published_at DESC);
  CREATE INDEX IF NOT EXISTS idx_nsi_sentiment ON news_sentiment_items(sentiment);
  CREATE INDEX IF NOT EXISTS idx_nsi_category  ON news_sentiment_items(category);
  CREATE INDEX IF NOT EXISTS idx_nsi_fetched   ON news_sentiment_items(fetched_at DESC);

  -- 17. Market Sentiment Snapshots — aggregate sentiment every 15 minutes
  CREATE TABLE IF NOT EXISTS market_sentiment_snapshots (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    overall_score      REAL DEFAULT 0,        -- -100 to +100
    overall_label      TEXT DEFAULT 'Neutral', -- 'Extreme Fear'|'Fear'|'Neutral'|'Greed'|'Extreme Greed'
    bullish_count      INTEGER DEFAULT 0,
    bearish_count      INTEGER DEFAULT 0,
    neutral_count      INTEGER DEFAULT 0,
    high_impact_count  INTEGER DEFAULT 0,
    nifty_bias         TEXT DEFAULT 'Neutral', -- 'Bullish' | 'Bearish' | 'Neutral'
    nifty_support      REAL,
    nifty_resistance   REAL,
    nifty_last_close   REAL,
    global_cue         TEXT DEFAULT 'Mixed',   -- 'Positive' | 'Negative' | 'Mixed'
    global_score       REAL DEFAULT 0,
    key_themes_json    TEXT,                   -- JSON array of top themes
    source_count       INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_mss_at ON market_sentiment_snapshots(snapshot_at DESC);
`);


export default db;
