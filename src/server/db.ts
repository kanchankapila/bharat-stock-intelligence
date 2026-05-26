import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.resolve(process.cwd(), process.env.DATABASE_URL || 'database.sqlite');
const db = new Database(dbPath, { timeout: 10000 });

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

/**
 * Initialize Database Schema
 * All tables required for all features are created here if they don't exist.
 */
try {
  const tableInfo = db.prepare("PRAGMA table_info(signal_source_weights)").all() as any[];
  const pkCount = tableInfo.filter(c => c.pk > 0).length;
  if (pkCount === 1) {
    console.log('[DB] Migrating signal_source_weights to composite primary key...');
    db.exec("DROP TABLE IF EXISTS signal_source_weights");
  }
} catch (e) {
  // Table might not exist yet
}

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
  CREATE INDEX IF NOT EXISTS idx_nse_industry ON nse_stocks(industry);

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
    news_sentiment_score REAL,
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

  -- MoneyControl Chart Patterns (technical picks)
  CREATE TABLE IF NOT EXISTS mc_chart_patterns (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    mcsymbol           TEXT NOT NULL,
    symbol             TEXT,                  -- NSE symbol (resolved from mcsymbol)
    pattern_id         INTEGER NOT NULL,
    pattern_name       TEXT NOT NULL,         -- e.g., 'Falling Trendline', 'Horizontal Trendline'
    comment            TEXT,                  -- e.g., 'Retesting the Resistance'
    time_frame         TEXT,                  -- e.g., '1 hour', '1 day', '30 mins'
    exchange           TEXT DEFAULT 'nse',
    p_status           TEXT,                  -- 'New', 'Updated'
    is_closed          TEXT DEFAULT 'N',
    entry_price        REAL,
    target_price       REAL,
    stoploss_price     REAL,
    target_return_pct  REAL,
    stoploss_pct       REAL,
    cmp                REAL,                  -- current market price from metadata
    metadata_json      TEXT,                  -- full meta_data from API (stringified)
    end_date           TEXT,
    analyst_name       TEXT,
    analyst_image      TEXT,
    fetched_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(mcsymbol, pattern_id)
  );
  CREATE INDEX IF NOT EXISTS idx_mcp_symbol ON mc_chart_patterns(mcsymbol);
  CREATE INDEX IF NOT EXISTS idx_mcp_nse_symbol ON mc_chart_patterns(symbol);
  CREATE INDEX IF NOT EXISTS idx_mcp_pattern_id ON mc_chart_patterns(pattern_id);
  CREATE INDEX IF NOT EXISTS idx_mcp_fetched ON mc_chart_patterns(fetched_at DESC);
`);

// --- New Tables (Phase 2 accuracy improvements) ---
db.exec(`
  -- Per-signal-type historical accuracy statistics (computed from signal_outcomes)
  CREATE TABLE IF NOT EXISTS signal_type_stats (
    signal_type     TEXT NOT NULL,
    horizon_days    INTEGER NOT NULL,      -- 5 or 15
    market_regime   TEXT NOT NULL DEFAULT 'ALL', -- 'BULL'|'BEAR'|'SIDEWAYS'|'ALL'
    total_occurrences INTEGER DEFAULT 0,
    win_count       INTEGER DEFAULT 0,
    avg_return_pct  REAL,
    median_return_pct REAL,
    win_rate        REAL,                  -- 0.0 – 1.0
    last_computed   DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (signal_type, horizon_days, market_regime)
  );

  -- Daily FII/DII institutional flow from NSE
  CREATE TABLE IF NOT EXISTS fii_dii_flow (
    date      TEXT PRIMARY KEY,
    fii_buy   REAL,
    fii_sell  REAL,
    fii_net   REAL,
    dii_buy   REAL,
    dii_sell  REAL,
    dii_net   REAL,
    source    TEXT DEFAULT 'NSE',
    fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_fii_date ON fii_dii_flow(date DESC);

  -- Intraday OHLCV for 15-minute bars (future: real-time signals)
  CREATE TABLE IF NOT EXISTS intraday_ohlcv (
    symbol   TEXT NOT NULL,
    datetime TEXT NOT NULL,
    open     REAL,
    high     REAL,
    low      REAL,
    close    REAL,
    volume   INTEGER,
    vwap     REAL,
    interval TEXT DEFAULT '15m',
    PRIMARY KEY (symbol, datetime, interval)
  );
  CREATE INDEX IF NOT EXISTS idx_intra_sym ON intraday_ohlcv(symbol, datetime DESC);

  -- Options OI for PCR computation (populated by pcr_fetcher.py)
  CREATE TABLE IF NOT EXISTS stock_options_oi (
    symbol      TEXT NOT NULL,
    date        TEXT NOT NULL,
    expiry      TEXT NOT NULL,
    call_oi     INTEGER DEFAULT 0,
    put_oi      INTEGER DEFAULT 0,
    pcr         REAL,
    total_call_oi INTEGER DEFAULT 0,
    total_put_oi  INTEGER DEFAULT 0,
    market_pcr  REAL,
    fetched_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, date, expiry)
  );
  CREATE INDEX IF NOT EXISTS idx_options_sym_date ON stock_options_oi(symbol, date DESC);
`);

// --- ML Feedback Framework Tables ---
db.exec(`
  -- Full audit trail of every recommendation generated by the platform
  CREATE TABLE IF NOT EXISTS recommendation_log (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol           TEXT NOT NULL,
    rec_type         TEXT NOT NULL,          -- 'BUY' | 'SELL' | 'HOLD' | 'AVOID'
    signal_date      TEXT NOT NULL,
    generated_at     DATETIME NOT NULL,
    timeframe        TEXT,                   -- 'INTRADAY' | 'SWING' | 'DELIVERY'
    entry_price      REAL,
    stop_loss        REAL,
    target_1         REAL,
    target_2         REAL,
    target_3         REAL,
    confidence_score REAL,
    signal_score     INTEGER,
    nifty_regime     TEXT,
    sector           TEXT,
    signals_json     TEXT,
    screener_score   REAL,
    quant_score      REAL,
    sentiment_score  REAL,
    win_probability  REAL,
    reasoning        TEXT,
    source           TEXT DEFAULT 'platform',
    status           TEXT DEFAULT 'ACTIVE',  -- 'ACTIVE' | 'RESOLVED' | 'EXPIRED'
    actual_exit_price REAL,
    actual_return_pct REAL,
    outcome          TEXT,                   -- 'WIN' | 'LOSS' | 'NEUTRAL' | 'PENDING'
    resolved_at      DATETIME,
    horizon_days     INTEGER DEFAULT 15
  );
  CREATE INDEX IF NOT EXISTS idx_rec_symbol ON recommendation_log(symbol, signal_date DESC);
  CREATE INDEX IF NOT EXISTS idx_rec_outcome ON recommendation_log(outcome, signal_date DESC);
  CREATE INDEX IF NOT EXISTS idx_rec_regime  ON recommendation_log(nifty_regime, signal_date DESC);

  -- Aggregated performance by strategy / signal type / regime / sector
  CREATE TABLE IF NOT EXISTS strategy_performance (
    perf_key         TEXT NOT NULL,          -- e.g. 'RSI_DIVERGENCE|BULL|15'
    strategy_name    TEXT NOT NULL,
    segment          TEXT NOT NULL,          -- 'signal_type' | 'sector' | 'regime' | 'screener_source'
    segment_value    TEXT NOT NULL,
    horizon_days     INTEGER NOT NULL,
    market_regime    TEXT NOT NULL DEFAULT 'ALL',
    total_signals    INTEGER DEFAULT 0,
    win_count        INTEGER DEFAULT 0,
    loss_count       INTEGER DEFAULT 0,
    neutral_count    INTEGER DEFAULT 0,
    win_rate         REAL,
    avg_return_pct   REAL,
    median_return_pct REAL,
    avg_win_pct      REAL,
    avg_loss_pct     REAL,
    profit_factor    REAL,
    sharpe_ratio     REAL,
    max_drawdown_pct REAL,
    alpha_vs_nifty   REAL,
    signal_decay_halflife_days REAL,
    false_positive_rate REAL,
    best_sector      TEXT,
    worst_sector     TEXT,
    last_computed    DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (perf_key, horizon_days, market_regime)
  );
  CREATE INDEX IF NOT EXISTS idx_perfkey ON strategy_performance(strategy_name, horizon_days);

  -- Historical snapshots of screener/category weights after each optimization run
  CREATE TABLE IF NOT EXISTS screener_weight_history (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
    optimization_method    TEXT DEFAULT 'differential_evolution',
    category_weights_json  TEXT,
    source_weights_json    TEXT,
    screener_overrides_json TEXT,
    baseline_win_rate      REAL,
    optimized_win_rate     REAL,
    improvement_pct        REAL,
    training_samples       INTEGER,
    notes                  TEXT
  );

  -- ML model versioning and performance tracking
  CREATE TABLE IF NOT EXISTS model_registry (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    model_name       TEXT NOT NULL,
    model_version    TEXT NOT NULL,
    model_type       TEXT NOT NULL,          -- 'GradientBoosting' | 'RandomForest' | 'Ensemble' | 'OnlineSGD'
    trained_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    training_samples INTEGER,
    cv_roc_auc       REAL,
    cv_accuracy      REAL,
    test_roc_auc     REAL,
    precision_score  REAL,
    recall_score     REAL,
    f1_score         REAL,
    feature_count    INTEGER,
    top_features_json TEXT,
    model_path       TEXT,
    is_active        INTEGER DEFAULT 0,
    horizon_days     INTEGER DEFAULT 15,
    notes            TEXT
  );

  -- Per-model feature importance snapshots
  CREATE TABLE IF NOT EXISTS feature_importance_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id      INTEGER,
    model_name    TEXT NOT NULL,
    computed_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    feature_name  TEXT NOT NULL,
    importance    REAL,
    rank_position INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_feat_model ON feature_importance_log(model_name, computed_at DESC);

  -- Stored backtest run results
  CREATE TABLE IF NOT EXISTS backtesting_runs (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    run_name              TEXT,
    strategy_config_json  TEXT,
    start_date            TEXT,
    end_date              TEXT,
    symbols_count         INTEGER,
    total_trades          INTEGER,
    win_rate              REAL,
    total_return_pct      REAL,
    cagr_pct              REAL,
    sharpe_ratio          REAL,
    calmar_ratio          REAL,
    sortino_ratio         REAL,
    max_drawdown_pct      REAL,
    nifty_return_pct      REAL,
    alpha_pct             REAL,
    avg_trade_return_pct  REAL,
    profit_factor         REAL,
    avg_holding_days      REAL,
    monthly_returns_json  TEXT,
    equity_curve_json     TEXT,
    trade_log_json        TEXT,
    run_at                DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// --- RL & Reward Loop Tables ---
db.exec(`
  -- Per-(signal_type, regime, sector) EMA-smoothed reward weights
  CREATE TABLE IF NOT EXISTS signal_type_weights (
    id           INTEGER PRIMARY KEY,
    signal_type  TEXT NOT NULL,
    regime       TEXT NOT NULL,
    sector       TEXT NOT NULL DEFAULT 'ALL',
    weight       REAL NOT NULL DEFAULT 1.0,
    sample_count INTEGER NOT NULL DEFAULT 0,
    last_updated TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
    UNIQUE(signal_type, regime, sector)
  );

  -- Q-learning table: Q(state, action) values
  CREATE TABLE IF NOT EXISTS rl_q_table (
    state_key    TEXT NOT NULL,
    action       TEXT NOT NULL,
    q_value      REAL NOT NULL DEFAULT 0.0,
    visit_count  INTEGER NOT NULL DEFAULT 0,
    last_updated TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
    PRIMARY KEY (state_key, action)
  );

  -- Audit trail of every RL episode (state chosen, action taken, reward assigned later)
  CREATE TABLE IF NOT EXISTS rl_episodes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    date         TEXT NOT NULL,
    state_key    TEXT NOT NULL,
    action_taken TEXT NOT NULL,
    reward       REAL,
    epsilon      REAL,
    notes        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_rlepi_date ON rl_episodes(date);
`);

// --- PHASE 1: Unified Signal & Outcome Tracking ---
db.exec(`
  -- Unified signal schema that consolidates AI, Technical, and Quant signals
  CREATE TABLE IF NOT EXISTS unified_signals (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol             TEXT NOT NULL,
    signal_date        DATETIME DEFAULT CURRENT_TIMESTAMP,
    signal_source      TEXT NOT NULL,  -- 'AI', 'TECHNICAL', 'QUANT', 'ENSEMBLE'
    signal_type        TEXT NOT NULL,  -- 'BUY', 'SELL', 'HOLD'
    entry_price        REAL,
    target_price       REAL,
    stop_loss          REAL,
    confidence_score   REAL,           -- 0-100, from any source
    reasoning          TEXT,
    technical_score    REAL,           -- Technical analysis component score
    quant_score        REAL,           -- Quantitative analysis component score
    ai_reasoning       TEXT,           -- AI model reasoning (Ollama/Gemini)
    status             TEXT DEFAULT 'ACTIVE',  -- 'ACTIVE', 'COMPLETED', 'EXPIRED', 'FAILED'
    signal_generated_at DATETIME NOT NULL,  -- Exact time signal was generated (critical for outcome matching)
    created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(symbol, signal_date, signal_source)
  );
  CREATE INDEX IF NOT EXISTS idx_us_symbol_date ON unified_signals(symbol, signal_date DESC);
  CREATE INDEX IF NOT EXISTS idx_us_source ON unified_signals(signal_source);
  CREATE INDEX IF NOT EXISTS idx_us_confidence ON unified_signals(confidence_score DESC);
  CREATE INDEX IF NOT EXISTS idx_us_status ON unified_signals(status);

  -- Unified signal outcome tracking (replaces per-source outcomes)
  CREATE TABLE IF NOT EXISTS unified_signal_outcomes (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    unified_signal_id  INTEGER NOT NULL,
    symbol             TEXT NOT NULL,
    signal_date        TEXT NOT NULL,
    signal_source      TEXT NOT NULL,
    horizon_days       INTEGER NOT NULL,
    entry_price        REAL NOT NULL,
    entry_time         DATETIME NOT NULL,
    check_date         TEXT,
    exit_price         REAL,
    exit_time          DATETIME,
    return_pct         REAL,
    intraday_max_return_pct REAL,  -- Highest return before outcome
    intraday_min_return_pct REAL,  -- Lowest return before outcome
    outcome            TEXT,  -- 'WIN', 'LOSS', 'NEUTRAL', 'STOP_LOSS', 'PENDING'
    exit_reason        TEXT,  -- 'TARGET_HIT', 'STOP_LOSS_HIT', 'HORIZON_EXPIRED', 'PENDING'
    signal_score       INTEGER,
    computed_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (unified_signal_id) REFERENCES unified_signals(id),
    UNIQUE(unified_signal_id, horizon_days)
  );
  CREATE INDEX IF NOT EXISTS idx_uso_symbol_date ON unified_signal_outcomes(symbol, signal_date);
  CREATE INDEX IF NOT EXISTS idx_uso_outcome ON unified_signal_outcomes(outcome);
  CREATE INDEX IF NOT EXISTS idx_uso_source ON unified_signal_outcomes(signal_source);

  -- Intraday tick-level data for real-time analysis and accurate entry/exit detection
  CREATE TABLE IF NOT EXISTS tick_data (
    symbol          TEXT NOT NULL,
    tick_time       DATETIME NOT NULL,  -- Must include time for intraday matching
    price           REAL NOT NULL,
    bid             REAL,
    ask             REAL,
    volume          INTEGER,
    volume_cum      INTEGER,  -- Cumulative volume for the day
    PRIMARY KEY (symbol, tick_time)
  );
  CREATE INDEX IF NOT EXISTS idx_tick_symbol ON tick_data(symbol, tick_time DESC);
  CREATE INDEX IF NOT EXISTS idx_tick_date ON tick_data(tick_time DESC);

  -- PHASE 3: Prepare database schema for new data sources (macro overlays & order book)
  CREATE TABLE IF NOT EXISTS macro_indicators (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    indicator_name TEXT NOT NULL,  -- e.g. 'US_10Y_YIELD', 'VIX', 'NIFTY_PE'
    date           TEXT NOT NULL,
    value          REAL,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(indicator_name, date)
  );
  CREATE INDEX IF NOT EXISTS idx_macro_date ON macro_indicators(date DESC);

  CREATE TABLE IF NOT EXISTS order_book_snapshots (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol         TEXT NOT NULL,
    timestamp      DATETIME NOT NULL,
    total_buy_qty  INTEGER,
    total_sell_qty INTEGER,
    bid_ask_spread REAL,
    vwap           REAL,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_ob_symbol_time ON order_book_snapshots(symbol, timestamp DESC);


  -- PHASE 3.3: Signal Actions — Track user actions taken on signals (executed vs recommended)
  CREATE TABLE IF NOT EXISTS signal_actions (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_id           INTEGER NOT NULL,
    signal_source       TEXT NOT NULL,  -- 'AI' | 'technical' | 'quant' | 'news'
    symbol              TEXT NOT NULL,
    user_id             TEXT,
    action_type         TEXT NOT NULL,  -- 'BUY' | 'SELL' | 'HOLD' | 'SKIP'
    executed_at         DATETIME NOT NULL,
    quantity            INTEGER,
    entry_price_rec     REAL,  -- Recommended entry price from signal
    entry_actual        REAL,  -- Actual entry price if executed
    target_price_rec    REAL,  -- Recommended target from signal
    exit_price_actual   REAL,  -- Actual exit price if executed
    exit_date           DATETIME,
    pnl                 REAL,  -- Profit/loss amount if executed
    pnl_pct             REAL,  -- Profit/loss percentage if executed
    notes               TEXT,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (signal_id) REFERENCES unified_signals(id) ON DELETE CASCADE,
    UNIQUE(signal_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_sa_user_id ON signal_actions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sa_symbol ON signal_actions(symbol);
  CREATE INDEX IF NOT EXISTS idx_sa_source ON signal_actions(signal_source);
  CREATE INDEX IF NOT EXISTS idx_sa_executed_at ON signal_actions(executed_at DESC);

  -- PHASE 3.4: Portfolio-Signal Correlation — Track alignment between signals and portfolio
  CREATE TABLE IF NOT EXISTS signal_portfolio_correlation (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_id           INTEGER NOT NULL,
    portfolio_symbol    TEXT NOT NULL,  -- Symbol in user's portfolio
    signal_symbol       TEXT NOT NULL,  -- Symbol from signal
    weight              REAL,  -- Portfolio weight (0-1) of the symbol
    correlation_score   REAL,  -- Pearson correlation: -1 to 1
    co_movement_pct     REAL,  -- % time both move in same direction
    hedge_potential     INTEGER,  -- 1 if negatively correlated (hedge), 0 otherwise
    momentum_alignment  INTEGER,  -- 1 if momentum aligned, 0 otherwise
    computed_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (signal_id) REFERENCES unified_signals(id) ON DELETE CASCADE,
    UNIQUE(signal_id, portfolio_symbol)
  );
  CREATE INDEX IF NOT EXISTS idx_spc_portfolio_symbol ON signal_portfolio_correlation(portfolio_symbol);
  CREATE INDEX IF NOT EXISTS idx_spc_correlation_score ON signal_portfolio_correlation(correlation_score DESC);
  CREATE INDEX IF NOT EXISTS idx_spc_hedge ON signal_portfolio_correlation(hedge_potential);

  -- PHASE 3.6: Multi-source reward tracking — Per-source signal performance
  CREATE TABLE IF NOT EXISTS signal_source_weights (
    signal_source       TEXT NOT NULL,  -- 'AI' | 'technical' | 'quant' | 'news'
    regime              TEXT NOT NULL,     -- 'UPTREND' | 'DOWNTREND' | 'SIDEWAYS'
    sector              TEXT DEFAULT 'OTHER',
    win_rate            REAL,              -- % of signals that were winners
    avg_return_pct      REAL,              -- Average return on winning trades
    total_signals       INTEGER DEFAULT 0, -- Total signals from this source
    total_wins          INTEGER DEFAULT 0,
    total_losses        INTEGER DEFAULT 0,
    avg_sharpe_ratio    REAL,              -- Risk-adjusted returns
    weight_multiplier   REAL DEFAULT 1.0,  -- EMA-smoothed performance multiplier
    last_updated        DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (signal_source, regime, sector)
  );
  CREATE INDEX IF NOT EXISTS idx_source_weights_win_rate ON signal_source_weights(win_rate DESC);
  CREATE INDEX IF NOT EXISTS idx_source_weights_sector ON signal_source_weights(sector);
`);

// --- Daily Research Reports ---
db.exec(`
  CREATE TABLE IF NOT EXISTS daily_research_reports (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    report_date     TEXT NOT NULL,
    report_type     TEXT NOT NULL CHECK(report_type IN ('PRE_MARKET','POST_CLOSE')),
    status          TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK(status IN ('PENDING','GENERATING','READY','FAILED')),
    generated_at    DATETIME,
    market_regime   TEXT,
    sentiment_score REAL,
    fii_net_5d      REAL,
    top_picks_json  TEXT,
    report_json     TEXT,
    ai_blurbs_json  TEXT,
    error_message   TEXT,
    UNIQUE(report_date, report_type)
  );
`);

// --- Deep Learning Engine Tables ---
db.exec(`
  CREATE TABLE IF NOT EXISTS macro_indicators (
    date        TEXT NOT NULL,
    symbol      TEXT NOT NULL,
    close       REAL,
    ret_1d      REAL,
    ret_5d      REAL,
    fetched_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (date, symbol)
  );

  CREATE TABLE IF NOT EXISTS feature_store (
    symbol          TEXT NOT NULL,
    date            TEXT NOT NULL,
    timeframe       TEXT NOT NULL DEFAULT 'D',
    ret_1d REAL, ret_5d REAL, ret_15d REAL, ret_21d REAL,
    ret_63d REAL, ret_126d REAL, ret_252d REAL,
    sma20 REAL, sma50 REAL, sma200 REAL, ema8 REAL, ema21 REAL,
    dist_sma20_pct REAL, dist_sma200_pct REAL, above_sma200 INTEGER,
    rsi_14 REAL, rsi_28 REAL,
    macd REAL, macd_signal REAL, macd_hist REAL,
    adx REAL, di_plus REAL, di_minus REAL,
    stoch_k REAL, stoch_d REAL, cci REAL, williams_r REAL,
    atr_14 REAL, atr_pct REAL,
    bb_upper REAL, bb_lower REAL, bb_width REAL, bb_pct REAL,
    hist_vol_21d REAL, hist_vol_63d REAL, vol_regime TEXT,
    volume_ratio_20d REAL, volume_ratio_5d REAL,
    obv REAL, obv_slope REAL, vwap REAL, vwap_dist_pct REAL,
    trend_1d TEXT, trend_1w TEXT, trend_1m TEXT, mtf_alignment_score REAL,
    pcr_oi REAL, pcr_vol REAL, iv_rank REAL, max_pain REAL,
    fii_3d_net REAL, fii_10d_net REAL, dii_3d_net REAL, delivery_pct REAL,
    trailing_pe REAL, pb REAL, roe REAL, debt_to_equity REAL,
    op_margins REAL, rev_growth REAL, eps_growth REAL,
    piotroski_f REAL, earnings_yield REAL,
    nifty_vix REAL, nifty_pe REAL, advance_decline_ratio REAL,
    nifty_ret_5d REAL, nifty_ret_21d REAL,
    us_10y_yield REAL, dxy REAL,
    crude_ret_5d REAL, gold_ret_5d REAL, sp500_ret_5d REAL,
    news_sentiment_score REAL, news_impact_count INTEGER,
    target_ret_1d REAL, target_ret_5d REAL, target_ret_15d REAL,
    target_dir_1d INTEGER, target_dir_5d INTEGER, target_dir_15d INTEGER,
    computed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, date, timeframe)
  );

  CREATE TABLE IF NOT EXISTS deep_learning_predictions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol          TEXT NOT NULL,
    prediction_date TEXT NOT NULL,
    model_name      TEXT NOT NULL,
    model_version   TEXT NOT NULL,
    prob_up_1d  REAL, prob_up_5d  REAL, prob_up_15d  REAL,
    prob_dn_1d  REAL, prob_dn_5d  REAL, prob_dn_15d  REAL,
    exp_ret_1d  REAL, exp_ret_5d  REAL, exp_ret_15d  REAL,
    confidence  REAL,
    uncertainty REAL,
    regime            TEXT,
    regime_confidence REAL,
    top_features_json TEXT,
    attention_json    TEXT,
    actual_ret_5d   REAL,
    actual_ret_15d  REAL,
    outcome_5d      TEXT,
    outcome_15d     TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(symbol, prediction_date, model_name)
  );

  CREATE TABLE IF NOT EXISTS dl_model_performance (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    model_name    TEXT NOT NULL,
    model_version TEXT NOT NULL,
    eval_date     TEXT NOT NULL,
    horizon_days  INTEGER NOT NULL,
    directional_accuracy REAL,
    roc_auc       REAL,
    precision_up  REAL,
    recall_up     REAL,
    f1_score      REAL,
    sharpe_ratio  REAL,
    profit_factor REAL,
    sample_count  INTEGER,
    drift_score   REAL,
    retrain_triggered INTEGER DEFAULT 0,
    UNIQUE(model_name, eval_date, horizon_days)
  );

  CREATE TABLE IF NOT EXISTS market_regimes (
    date            TEXT PRIMARY KEY,
    regime          TEXT NOT NULL,
    regime_prob     REAL,
    hmm_state       INTEGER,
    viterbi_path_json TEXT,
    features_json   TEXT,
    computed_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// --- Migrations & Upgrades ---
const migrateColumn = (table: string, col: string, def: string) => {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch (e: any) {
    if (!e?.message?.includes('duplicate column name')) {
      console.warn(`[DB] migrateColumn failed for ${table}.${col}: ${e?.message}`);
    }
  }
};

// watchlist extras
migrateColumn('watchlist', 'price', 'REAL');
migrateColumn('watchlist', 'name', 'TEXT');
migrateColumn('watchlist', 'source', 'TEXT');

// technical_signals — new accuracy context columns
migrateColumn('technical_signals', 'adx',            'REAL');
migrateColumn('technical_signals', 'nifty_regime',   'TEXT');
migrateColumn('technical_signals', 'delivery_pct',   'REAL');
migrateColumn('technical_signals', 'fii_3d_net',     'REAL');
migrateColumn('technical_signals', 'win_probability', 'REAL');
migrateColumn('technical_signals', 'news_sentiment_score', 'REAL');

// screener_master — signal type tag for dedup (prevents momentum/technical cross-bleed)
migrateColumn('screener_master', 'signal_type_tag', "TEXT DEFAULT 'OTHER'");

// signal_outcomes — max intraday high return over horizon for accurate WIN detection
migrateColumn('signal_outcomes', 'max_return_pct', 'REAL');

// PHASE 3.5: Schema Normalization — Ensure consistency across all tables
// Standardize timestamp column naming: created_at, updated_at
migrateColumn('users', 'created_at', 'DATETIME');
migrateColumn('users', 'updated_at', 'DATETIME');

migrateColumn('watchlist', 'created_at', 'DATETIME');
migrateColumn('watchlist', 'updated_at', 'DATETIME');

migrateColumn('stocks', 'created_at', 'DATETIME');
migrateColumn('stocks', 'updated_at', 'DATETIME');

migrateColumn('technical_signals', 'created_at', 'DATETIME');
migrateColumn('technical_signals', 'updated_at', 'DATETIME');

migrateColumn('signals', 'created_at', 'DATETIME');
migrateColumn('signals', 'updated_at', 'DATETIME');

migrateColumn('stock_fundamentals', 'created_at', 'DATETIME');
migrateColumn('stock_fundamentals', 'updated_at', 'DATETIME');

migrateColumn('stock_scores', 'created_at', 'DATETIME');
migrateColumn('stock_scores', 'updated_at', 'DATETIME');

migrateColumn('screener_master', 'created_at', 'DATETIME');
migrateColumn('screener_master', 'updated_at', 'DATETIME');

// Add indexes — each wrapped individually so one missing column doesn't abort the rest
const tryIndex = (sql: string) => { try { db.exec(sql); } catch { /* column/table not yet migrated */ } };

tryIndex(`CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at DESC)`);
tryIndex(`CREATE INDEX IF NOT EXISTS idx_watchlist_created_at ON watchlist(created_at DESC)`);
tryIndex(`CREATE INDEX IF NOT EXISTS idx_technical_signals_created_at ON technical_signals(created_at DESC)`);
tryIndex(`CREATE INDEX IF NOT EXISTS idx_stock_scores_created_at ON stock_scores(created_at DESC)`);
tryIndex(`CREATE INDEX IF NOT EXISTS idx_screener_master_created_at ON screener_master(created_at DESC)`);
tryIndex(`CREATE INDEX IF NOT EXISTS idx_watchlist_userId ON watchlist(userId)`);
tryIndex(`CREATE INDEX IF NOT EXISTS idx_technical_signals_symbol ON technical_signals(symbol)`);
tryIndex(`CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals(symbol)`);
tryIndex(`CREATE INDEX IF NOT EXISTS idx_stock_scores_symbol ON stock_scores(symbol)`);
tryIndex(`CREATE INDEX IF NOT EXISTS idx_stock_ohlcv_date ON stock_ohlcv(date DESC)`);
tryIndex(`CREATE INDEX IF NOT EXISTS idx_unified_signals_date ON unified_signals(signal_date DESC)`);

// Verify key constraints
console.log('[DB] Schema normalization complete (Phase 3.5)');

export default db;
