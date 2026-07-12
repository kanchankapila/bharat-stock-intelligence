import Database from 'better-sqlite3';
import path from 'path';
import { usePostgres } from './pgConfig';

const DATABASE_URL = process.env.DATABASE_URL || 'database.sqlite';
const dbPath = DATABASE_URL === ':memory:' ? ':memory:' : path.resolve(process.cwd(), DATABASE_URL);
const db = new Database(dbPath, { timeout: 30000 });

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -65536');     // 64 MB page cache
db.pragma('mmap_size = 268435456');   // 256 MB memory-mapped I/O
db.pragma('temp_store = MEMORY');     // temp tables in RAM
db.pragma('busy_timeout = 30000');    // allow 30s wait during heavy concurrent writes
db.pragma('wal_autocheckpoint = 1000');

// Checkpoint the WAL every 5 min using TRUNCATE (resets the -wal file to zero bytes).
// PASSIVE could never advance past the always-present readers from the ~40 BullMQ
// workers, so the WAL grew unbounded (observed ~300 MB). TRUNCATE forces a full
// checkpoint + truncate when no writer holds the lock.
if (!usePostgres()) {
  setInterval(() => {
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
  }, 5 * 60 * 1000).unref();
}

db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
  name     TEXT PRIMARY KEY,
  applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

function runMigration(name: string, sql: string): void {
  if (db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(name)) return;
  db.exec(sql);
  db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(name);
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
    mcsymbol TEXT,
    tlid TEXT,
    tlname TEXT,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_nse_symbol ON nse_stocks(symbol);
  CREATE INDEX IF NOT EXISTS idx_nse_sector ON nse_stocks(sector);
  CREATE INDEX IF NOT EXISTS idx_nse_industry ON nse_stocks(industry);

  -- 3. Historical Data & Scans Cache
  CREATE TABLE IF NOT EXISTS company_profiles (
    symbol TEXT PRIMARY KEY,
    company_name TEXT,
    description TEXT,
    high_growth_scope INTEGER DEFAULT 0,
    in_news_for_growth INTEGER DEFAULT 0,
    growth_score REAL DEFAULT 0,
    ai_analysis TEXT,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- (historical_ohlc removed in migration 042 — dead duplicate of stock_ohlcv)

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

  -- 5a. MoneyControl Data-Gap Resolution tables
  CREATE TABLE IF NOT EXISTS insider_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    acquirerName TEXT NOT NULL,
    category TEXT NOT NULL,
    typeOfTransaction TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    valueInr REAL NOT NULL,
    date TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_insider_sym ON insider_trades(symbol, date DESC);

  CREATE TABLE IF NOT EXISTS bulk_deals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    symbol TEXT NOT NULL,
    clientName TEXT NOT NULL,
    dealType TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    price REAL NOT NULL,
    valueCr REAL NOT NULL,
    source TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_bulk_sym_date ON bulk_deals(symbol, date DESC);

  CREATE TABLE IF NOT EXISTS mc_analyst_ratings (
    symbol TEXT NOT NULL,
    final_rating TEXT,
    analyst_count INTEGER,
    buy_count INTEGER,
    outperform_count INTEGER,
    hold_count INTEGER,
    underperform_count INTEGER,
    sell_count INTEGER,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (symbol, fetched_at)
  );

  CREATE TABLE IF NOT EXISTS mc_price_forecast (
    symbol TEXT NOT NULL,
    high REAL,
    mean REAL,
    low REAL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (symbol, fetched_at)
  );

  CREATE TABLE IF NOT EXISTS mc_earnings_forecast (
    symbol TEXT NOT NULL,
    date TEXT NOT NULL,
    metric_type TEXT NOT NULL,
    high REAL,
    low REAL,
    avg REAL,
    actual REAL,
    PRIMARY KEY (symbol, date, metric_type)
  );

  CREATE TABLE IF NOT EXISTS mc_estimates_hits_misses (
    symbol TEXT NOT NULL,
    quarter TEXT NOT NULL,
    actual REAL,
    estimates REAL,
    surprise REAL,
    type TEXT,
    PRIMARY KEY (symbol, quarter)
  );

  CREATE TABLE IF NOT EXISTS mc_seasonality_best_stocks (
    tab_type TEXT NOT NULL,
    sc_id TEXT NOT NULL,
    sc_fullname TEXT,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    avg_pct REAL,
    max_pct REAL,
    min_pct REAL,
    total_yr REAL,
    tot_yr REAL,
    PRIMARY KEY (tab_type, sc_id, year, month)
  );

  CREATE TABLE IF NOT EXISTS mc_stock_vitals (
    symbol TEXT NOT NULL,
    metric_name TEXT NOT NULL,
    score TEXT,
    description TEXT,
    PRIMARY KEY (symbol, metric_name)
  );

  CREATE TABLE IF NOT EXISTS mc_stock_scans (
    symbol TEXT NOT NULL,
    scan_name TEXT NOT NULL,
    description TEXT,
    PRIMARY KEY (symbol, scan_name)
  );

  CREATE TABLE IF NOT EXISTS mc_general_metrics (
    symbol TEXT NOT NULL,
    source_api TEXT NOT NULL,
    metric_group TEXT NOT NULL,
    metric_name TEXT NOT NULL,
    metric_value_num REAL,
    metric_value_text TEXT,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (symbol, source_api, metric_group, metric_name, fetched_at)
  );

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
    is_suspect INTEGER DEFAULT 0,   -- bad-print flag (ohlcv_quality.flag_bad_prints)
    PRIMARY KEY (symbol, date)
  );

  -- Corporate-action ex-dates (yfinance) — the bad-print allowlist, NOT used to re-adjust
  -- prices (stock_ohlcv is already auto_adjusted by backfill_ohlcv).
  CREATE TABLE IF NOT EXISTS corporate_actions (
    symbol TEXT NOT NULL,
    ex_date TEXT NOT NULL,
    action_type TEXT NOT NULL,
    ratio REAL,
    amount REAL,
    source TEXT DEFAULT 'yfinance',
    ingested_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, ex_date, action_type)
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

  -- 12b. Point-in-time fundamentals snapshots (written daily by fundamentals_snapshot.py).
  -- stock_fundamentals is a *current* snapshot; joining it onto historical signal rows leaks
  -- future fundamentals into training. This table accumulates an as-of trail so ml_ensemble
  -- can join the fundamentals that were actually knowable on each signal_date.
  CREATE TABLE IF NOT EXISTS fundamentals_history (
    symbol              TEXT NOT NULL,
    as_of_date          TEXT NOT NULL,   -- date the snapshot was taken (YYYY-MM-DD)
    fifty_two_week_high REAL,
    piotroski_f_score   INTEGER,
    debt_to_equity      REAL,
    operating_margins   REAL,
    return_on_equity    REAL,
    revenue_growth      REAL,
    earnings_growth     REAL,
    earnings_yield      REAL,
    price_to_book       REAL,
    market_cap          REAL,
    captured_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, as_of_date)
  );

  CREATE INDEX IF NOT EXISTS idx_fh_sym_date ON fundamentals_history(symbol, as_of_date DESC);

  -- Analyst consensus + price targets — as-of trail for ML (no look-ahead bias)
  CREATE TABLE IF NOT EXISTS analyst_estimates_history (
    symbol           TEXT NOT NULL,
    as_of_date       TEXT NOT NULL,
    n_analysts       INTEGER,
    final_rating     TEXT,
    buy_count        INTEGER,
    hold_count       INTEGER,
    sell_count       INTEGER,
    target_high      REAL,
    target_mean      REAL,
    target_low       REAL,
    eps_est_next     REAL,
    revenue_est_next REAL,
    captured_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, as_of_date)
  );

  CREATE INDEX IF NOT EXISTS idx_aeh_sym_date ON analyst_estimates_history(symbol, as_of_date DESC);

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

  -- 15b. Signal Excursions — path-based exit labels (computed by exit_labeler.py from
  -- stock_ohlcv). signal_outcomes answers "was it a win at the horizon?"; this answers
  -- "how should we have EXITED?" — the targets an exit-policy model needs to learn from.
  CREATE TABLE IF NOT EXISTS signal_excursions (
    symbol          TEXT NOT NULL,
    signal_date     TEXT NOT NULL,
    horizon_days    INTEGER NOT NULL,
    entry_price     REAL NOT NULL,
    mfe_pct         REAL,    -- max favorable excursion: best unrealised gain in the window (%)
    mae_pct         REAL,    -- max adverse excursion: worst unrealised drawdown in the window (%)
    days_to_mfe     INTEGER, -- trading days from entry to the MFE peak
    days_to_mae     INTEGER, -- trading days from entry to the MAE trough
    mfe_before_mae  INTEGER, -- 1 if the favorable peak occurred before the adverse trough
    trail_exit_pct  REAL,    -- return of a chandelier-trailed exit (highest-high − 3×ATR)
    trail_exit_day  INTEGER, -- trading day the trailing stop fired (NULL = held to horizon)
    horizon_close_pct REAL,  -- return if simply held to the horizon close (baseline)
    computed_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, signal_date, horizon_days)
  );

  CREATE INDEX IF NOT EXISTS idx_sexc_date ON signal_excursions(signal_date DESC);
  CREATE INDEX IF NOT EXISTS idx_sexc_sym  ON signal_excursions(symbol);

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
    UNIQUE(symbol, signal_source, signal_type, signal_date)
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
  CREATE TABLE IF NOT EXISTS macro_asset_prices (
    date        TEXT NOT NULL,
    symbol      TEXT NOT NULL,
    close       REAL,
    ret_1d      REAL,
    ret_5d      REAL,
    fetched_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (date, symbol)
  );

  -- Market breadth / internals computed from our own stock_ohlcv universe (market_breadth.py).
  CREATE TABLE IF NOT EXISTS market_breadth (
    date               TEXT PRIMARY KEY,
    pct_above_200dma   REAL,
    adv_decline_ratio  REAL,
    pct_at_20d_high    REAL,
    net_highs_lows     REAL,
    computed_at        TEXT
  );

  -- Intraday breadth nowcast (written every ~5 min during market hours by intradayBreadth.ts
  -- off the live whole-universe quote feed). Point-in-time by snapshot_at so history accumulates
  -- for a future intraday-aware regime model; the daily market_breadth above is EOD-only.
  CREATE TABLE IF NOT EXISTS intraday_breadth_snapshots (
    snapshot_at        TEXT PRIMARY KEY,
    date               TEXT,
    adv                INTEGER,
    dec                INTEGER,
    unch               INTEGER,
    total              INTEGER,
    adv_decline_ratio  REAL,
    pct_positive       REAL,
    avg_change_pct     REAL,
    breadth_score      REAL,
    risk_tilt          TEXT,
    computed_at        TEXT
  );

  -- Intraday regime nowcast history (written every ~15 min by intraday_regime.py). Fuses
  -- VIX/USDINR/basis/MMI/breadth into one RISK_ON|NEUTRAL|RISK_OFF label; latest also lands in
  -- app_settings.intraday_regime for the ranker to gate on.
  CREATE TABLE IF NOT EXISTS intraday_regime_history (
    computed_at        TEXT PRIMARY KEY,
    date               TEXT,
    regime             TEXT,
    composite          REAL,
    vix                REAL,
    mmi                REAL,
    usdinr_chg         REAL,
    basis              REAL,
    breadth_score      REAL
  );

  -- Intraday stock ranking (written every ~15 min during market hours by intraday_ranker.py).
  -- Fully separate from unified_recommendations (positional): intraday-classified screeners +
  -- breakout_probability, gated by the intraday regime. Latest-per-day (computed_at=date).
  CREATE TABLE IF NOT EXISTS intraday_recommendations (
    symbol             TEXT,
    computed_at        TEXT,
    intraday_regime    TEXT,
    intraday_score     REAL,
    conviction_level   TEXT,
    classification     TEXT,
    screener_score     REAL,
    breakout_score     REAL,
    news_sentiment     REAL,
    bullish_count      INTEGER,
    bearish_count      INTEGER,
    cmp                REAL,
    entry_price        REAL,
    stop_loss          REAL,
    target_1           REAL,
    risk_reward        REAL,
    position_size_pct  REAL,
    reasoning          TEXT,
    computed_ts        TIMESTAMP,
    PRIMARY KEY (symbol, computed_at)
  );

  -- Intraday paper-trade outcomes: entry/target/stop simulated against the day's OHLC by
  -- intraday_outcome_resolver.py (post-close). Feeds accuracy metrics + the strategy learner.
  CREATE TABLE IF NOT EXISTS intraday_recommendation_outcomes (
    symbol             TEXT,
    computed_at        TEXT,
    entry_price        REAL,
    target_1           REAL,
    stop_loss          REAL,
    day_high           REAL,
    day_low            REAL,
    day_close          REAL,
    exit_price         REAL,
    exit_reason        TEXT,
    pnl_pct            REAL,
    outcome            TEXT,
    resolved_at        TIMESTAMP,
    PRIMARY KEY (symbol, computed_at)
  );

  -- Reverse-engineered signal lifts (intraday_strategy_learner.py): per signal bucket, the
  -- paper-trade win rate and its lift over the base rate — which setups actually precede winners.
  CREATE TABLE IF NOT EXISTS intraday_strategy_lifts (
    as_of              TEXT,
    dimension          TEXT,
    bucket             TEXT,
    n                  INTEGER,
    wins               INTEGER,
    win_rate           REAL,
    lift               REAL,
    avg_pnl            REAL,
    PRIMARY KEY (as_of, dimension, bucket)
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

// --- Confluence Intelligence Tables ---
db.exec(`
  -- Confluence Signals — ranked multi-screener stock opportunities (refreshed every 30 min)
  CREATE TABLE IF NOT EXISTS confluence_signals (
    symbol                 TEXT NOT NULL,
    computed_at            DATETIME NOT NULL,
    confluence_score       REAL NOT NULL,
    conviction_level       TEXT NOT NULL CHECK(conviction_level IN ('ELITE','STRONG','MODERATE','WEAK')),
    active_screener_count  INTEGER NOT NULL DEFAULT 0,
    bullish_screener_count INTEGER NOT NULL DEFAULT 0,
    bearish_screener_count INTEGER NOT NULL DEFAULT 0,
    screener_ids_json      TEXT NOT NULL DEFAULT '[]',
    screener_names_json    TEXT NOT NULL DEFAULT '[]',
    screener_weights_json  TEXT NOT NULL DEFAULT '{}',
    trend_alignment_score  REAL DEFAULT 0,
    volume_score           REAL DEFAULT 0,
    sector_strength_score  REAL DEFAULT 0,
    fundamental_score      REAL DEFAULT 0,
    ml_breakout_probability REAL,
    ml_trend_probability   REAL,
    suggested_timeframe    TEXT DEFAULT 'POSITIONAL',
    entry_zone_low         REAL,
    entry_zone_high        REAL,
    stop_loss              REAL,
    target_1               REAL,
    target_2               REAL,
    target_3               REAL,
    risk_reward            REAL,
    ai_conclusion          TEXT,
    trade_reasoning        TEXT,
    sector                 TEXT,
    market_cap             REAL,
    current_price          REAL,
    current_volume         INTEGER,
    rsi                    REAL,
    atr                    REAL,
    expires_at             DATETIME,
    PRIMARY KEY (symbol, computed_at)
  );
  CREATE INDEX IF NOT EXISTS idx_csi_score   ON confluence_signals(confluence_score DESC);
  CREATE INDEX IF NOT EXISTS idx_csi_symbol  ON confluence_signals(symbol);
  CREATE INDEX IF NOT EXISTS idx_csi_computed ON confluence_signals(computed_at DESC);
  CREATE INDEX IF NOT EXISTS idx_csi_level   ON confluence_signals(conviction_level);
  CREATE INDEX IF NOT EXISTS idx_csi_sector  ON confluence_signals(sector);

  -- Screener Reliability — per-screener historical win rates (updated by confluence_outcome_tracker.py)
  CREATE TABLE IF NOT EXISTS screener_reliability (
    scan_id           TEXT PRIMARY KEY,
    screener_name     TEXT NOT NULL,
    source            TEXT NOT NULL,
    total_signals     INTEGER DEFAULT 0,
    wins_1d           INTEGER DEFAULT 0,
    wins_3d           INTEGER DEFAULT 0,
    wins_7d           INTEGER DEFAULT 0,
    wins_14d          INTEGER DEFAULT 0,
    wins_30d          INTEGER DEFAULT 0,
    win_rate_1d       REAL DEFAULT 0,
    win_rate_7d       REAL DEFAULT 0,
    win_rate_30d      REAL DEFAULT 0,
    avg_return_7d     REAL DEFAULT 0,
    avg_return_30d    REAL DEFAULT 0,
    max_drawdown      REAL DEFAULT 0,
    avg_holding_days  REAL DEFAULT 0,
    reliability_score REAL DEFAULT 50,
    last_updated      DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_sr_source   ON screener_reliability(source);

  -- (confluence_alerts_log removed in migration 042 — never written/read by any code)
`);

// --- Migrations & Upgrades ---

// Cache of existing columns per table — checked once via PRAGMA, never throws.
const _tableColumns = new Map<string, Set<string>>();

function hasColumn(table: string, col: string): boolean {
  if (!_tableColumns.has(table)) {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    _tableColumns.set(table, new Set(rows.map(r => r.name)));
  }
  return _tableColumns.get(table)!.has(col);
}

const migrateColumn = (table: string, col: string, def: string) => {
  if (hasColumn(table, col)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  _tableColumns.get(table)?.add(col);
};

// watchlist extras
migrateColumn('watchlist', 'price', 'REAL');
migrateColumn('watchlist', 'name', 'TEXT');
migrateColumn('watchlist', 'source', 'TEXT');

// technical_signals — new accuracy context columns
migrateColumn('stock_ohlcv', 'is_suspect', 'INTEGER DEFAULT 0');
migrateColumn('technical_signals', 'adx',            'REAL');
migrateColumn('technical_signals', 'calibrated_win_probability', 'REAL');
migrateColumn('technical_signals', 'nifty_regime',   'TEXT');
migrateColumn('technical_signals', 'delivery_pct',   'REAL');
migrateColumn('technical_signals', 'fii_3d_net',     'REAL');
migrateColumn('technical_signals', 'win_probability', 'REAL');
migrateColumn('technical_signals', 'news_sentiment_score', 'REAL');

// screener_master — signal type tag for dedup (prevents momentum/technical cross-bleed)
migrateColumn('screener_master', 'signal_type_tag', "TEXT DEFAULT 'OTHER'");

// signal_outcomes — max intraday high return over horizon for accurate WIN detection
migrateColumn('signal_outcomes', 'max_return_pct', 'REAL');

// signal_excursions — triple-barrier label (vol-scaled, asymmetric) + the ATR%% scale
// it was computed against, written by exit_labeler.py. Consumed by ml_ensemble --label.
migrateColumn('signal_excursions', 'atr_pct',  'REAL');
migrateColumn('signal_excursions', 'tb_label', 'INTEGER');

// PHASE 3.5: Schema Normalization — Ensure consistency across all tables
// Standardize timestamp column naming: created_at, updated_at
migrateColumn('users', 'created_at', 'DATETIME');
migrateColumn('users', 'updated_at', 'DATETIME');

migrateColumn('watchlist', 'created_at', 'DATETIME');
migrateColumn('watchlist', 'updated_at', 'DATETIME');

migrateColumn('technical_signals', 'created_at', 'DATETIME');
migrateColumn('technical_signals', 'updated_at', 'DATETIME');
migrateColumn('technical_signals', 'fii_10d_net',    'REAL');
migrateColumn('technical_signals', 'dii_3d_net',     'REAL');
migrateColumn('technical_signals', 'pcr_oi',         'REAL');
migrateColumn('technical_signals', 'pcr_vol',        'REAL');
migrateColumn('technical_signals', 'sector_ret_5d',  'REAL');
migrateColumn('technical_signals', 'sector_ret_21d', 'REAL');
// Options-implied vol features (computed by iv_features.py from stock_options_oi)
migrateColumn('technical_signals', 'iv_rank',         'REAL');
migrateColumn('technical_signals', 'iv_skew',         'REAL');
// Cross-sectional relative-strength ranks (computed by relative_strength.py from stock_ohlcv)
migrateColumn('technical_signals', 'rs_rank_21d',     'REAL');
migrateColumn('technical_signals', 'rs_rank_63d',     'REAL');
// Insider activity (computed by insider_features.py from insider_trades rolling 90d)
migrateColumn('technical_signals', 'insider_buy_pct_90d', 'REAL');
// Intraday microstructure features (computed by intraday_features.py from intraday_ohlcv)
migrateColumn('technical_signals', 'opening_range_break',  'REAL');
migrateColumn('technical_signals', 'vwap_deviation_pct',   'REAL');
migrateColumn('technical_signals', 'first_hour_vol_share', 'REAL');
// breakout classifier (Lever #4) — cross-sectional P(>=6% move in next 10 trading days)
migrateColumn('technical_signals', 'breakout_probability', 'REAL');
// MoneyControl technical scanners + rating (forward-capture alt-data features)
migrateColumn('technical_signals', 'mc_bullish_scan_count', 'INTEGER');
migrateColumn('technical_signals', 'mc_scan_52w_high', 'INTEGER');
migrateColumn('technical_signals', 'mc_scan_squeeze_bo', 'INTEGER');
migrateColumn('technical_signals', 'mc_tech_rating', 'INTEGER');

// ATM implied vol + skew snapshot (captured by pcr_fetcher.py from the NSE option chain)
migrateColumn('stock_options_oi', 'atm_iv',   'REAL');
migrateColumn('stock_options_oi', 'iv_skew',  'REAL');

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
// idx_technical_signals_symbol intentionally NOT (re)created — duplicate of idx_tsig_sym
// (same table/column); dropped from live Postgres via scripts/migrate_add_indexes.sql.
tryIndex(`CREATE INDEX IF NOT EXISTS idx_stock_scores_symbol ON stock_scores(symbol)`);
tryIndex(`CREATE INDEX IF NOT EXISTS idx_stock_ohlcv_date ON stock_ohlcv(date DESC)`);
tryIndex(`CREATE INDEX IF NOT EXISTS idx_stock_ohlcv_sym_date ON stock_ohlcv(symbol, date DESC)`);
tryIndex(`CREATE INDEX IF NOT EXISTS idx_unified_signals_date ON unified_signals(signal_date DESC)`);

// ── Early migrations (moved after db.exec so ALTER TABLE runs after table creation) ─
runMigration(
  '001_signal_source_weights_composite_pk',
  'DROP TABLE IF EXISTS signal_source_weights'
);

runMigration(
  '002_add_mapping_columns_to_nse_stocks',
  // Columns are in base schema; this migration is a no-op for new DBs.
  // Existing DBs that ran this migration have it tracked and skip it.
  'SELECT 1'
);

// ── Screener Intelligence Foundation (Sub-project A) ─────────────────────────
runMigration('030_screener_appearances', `
  CREATE TABLE IF NOT EXISTS screener_appearances (
    screener_id   TEXT NOT NULL,
    source        TEXT NOT NULL,
    symbol        TEXT NOT NULL,
    appeared_date DATE NOT NULL,
    exited_date   DATE,
    return_5d     REAL,
    return_10d    REAL,
    return_20d    REAL,
    return_60d    REAL,
    return_120d   REAL,
    nifty_ret_20d REAL,
    outcome_20d   TEXT,
    PRIMARY KEY (screener_id, symbol, appeared_date)
  );
  CREATE INDEX IF NOT EXISTS idx_sa_symbol   ON screener_appearances(symbol);
  CREATE INDEX IF NOT EXISTS idx_sa_date     ON screener_appearances(appeared_date);
  CREATE INDEX IF NOT EXISTS idx_sa_screener ON screener_appearances(screener_id);
`);

runMigration('031_screener_performance_v2', `
  CREATE TABLE IF NOT EXISTS screener_performance_v2 (
    screener_id        TEXT PRIMARY KEY,
    source             TEXT NOT NULL,
    total_appearances  INTEGER DEFAULT 0,
    resolved_count     INTEGER DEFAULT 0,
    wr_5d     REAL, wr_10d    REAL, wr_20d    REAL, wr_60d    REAL, wr_120d   REAL,
    avg_ret_5d  REAL, avg_ret_10d  REAL, avg_ret_20d  REAL,
    avg_ret_60d REAL, avg_ret_120d REAL,
    alpha_20d    REAL,
    alpha_60d    REAL,
    sharpe_20d   REAL,
    max_drawdown REAL,
    median_ret_20d REAL,
    bayesian_score REAL,
    tier           TEXT,
    data_source    TEXT,
    last_computed  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

migrateColumn('screener_master', 'subcategory',         'TEXT');
migrateColumn('screener_master', 'tier',                'TEXT');
migrateColumn('screener_master', 'category_confidence', 'REAL');
migrateColumn('screener_master', 'classified_by',       'TEXT');

migrateColumn('screener_reliability', 'win_rate_5d',   'REAL');
migrateColumn('screener_reliability', 'win_rate_10d',  'REAL');
migrateColumn('screener_reliability', 'win_rate_20d',  'REAL');
migrateColumn('screener_reliability', 'win_rate_60d',  'REAL');
migrateColumn('screener_reliability', 'win_rate_120d', 'REAL');

runMigration('032_screener_catalog', `
  CREATE TABLE IF NOT EXISTS screener_catalog (
    screener_id        TEXT NOT NULL,
    source             TEXT NOT NULL,
    screener_name      TEXT NOT NULL,
    category           TEXT NOT NULL,
    subcategory        TEXT,
    signal_bias        TEXT NOT NULL,
    investment_horizon TEXT,
    confidence         REAL NOT NULL,
    score_0_100        REAL,
    tier               TEXT,
    sub_mod            REAL,
    horiz_mult         REAL,
    PRIMARY KEY (screener_id, source)
  );
`);

runMigration('033_unified_recommendations', `
  CREATE TABLE IF NOT EXISTS unified_recommendations (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol                  TEXT NOT NULL,
    computed_at             TEXT NOT NULL,
    regime                  TEXT NOT NULL,
    unified_score           REAL NOT NULL,
    conviction_level        TEXT NOT NULL,
    classification          TEXT,
    screener_stock_score    REAL,
    ml_score                REAL,
    confluence_score        REAL,
    technical_score         REAL,
    dl_score                REAL,
    avg_engine_track_record REAL,
    bullish_screener_count  INTEGER,
    bearish_screener_count  INTEGER,
    screener_names_json     TEXT,
    fundamental_score       REAL,
    entry_zone_low          REAL,
    entry_zone_high         REAL,
    stop_loss               REAL,
    target_1                REAL,
    target_2                REAL,
    target_3                REAL,
    risk_reward             REAL,
    timeframe               TEXT,
    sector                  TEXT,
    trade_reasoning         TEXT,
    UNIQUE(symbol, computed_at)
  );
  CREATE INDEX IF NOT EXISTS idx_ur_date_score ON unified_recommendations(computed_at, unified_score DESC);
  CREATE INDEX IF NOT EXISTS idx_ur_conviction  ON unified_recommendations(computed_at, conviction_level);
`);

// ── recommendation_log unique constraint (prevent duplicate daily logs) ──────
runMigration('034a_rec_log_unique', `
  DELETE FROM recommendation_log
  WHERE id NOT IN (
    SELECT MAX(id) FROM recommendation_log
    GROUP BY symbol, signal_date, timeframe, source
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_rec_log_uniq
    ON recommendation_log(symbol, signal_date, timeframe, source);
`);

// ── stock_factor_breakdown unique constraint ──────────────────────────────────
runMigration('034b_sfb_unique', `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_sfb_uniq
    ON stock_factor_breakdown(symbol, timeframe);
`);

// ── Screener stock freshness tracking ────────────────────────────────────────
runMigration('034_screener_stock_timestamps', `
  ALTER TABLE trendlyne_screener_stocks    ADD COLUMN first_seen TEXT;
  ALTER TABLE trendlyne_screener_stocks    ADD COLUMN last_seen  TEXT;
  ALTER TABLE moneycontrol_screener_stocks ADD COLUMN first_seen TEXT;
  ALTER TABLE moneycontrol_screener_stocks ADD COLUMN last_seen  TEXT;
  ALTER TABLE etnow_screener_stocks        ADD COLUMN first_seen TEXT;
  ALTER TABLE etnow_screener_stocks        ADD COLUMN last_seen  TEXT;
  ALTER TABLE screener_master              ADD COLUMN stocks_synced_at TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tl_stock_uniq  ON trendlyne_screener_stocks(screener_id, stock_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_mc_stock_uniq  ON moneycontrol_screener_stocks(scan_id, mcsymbol);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_et_stock_uniq  ON etnow_screener_stocks(screener_id, symbol);
`);

// ── Timeframe scores (screener-aware ranking for backtest + UI) ───────────────
runMigration('035_timeframe_scores', `
  CREATE TABLE IF NOT EXISTS timeframe_scores (
    symbol                TEXT NOT NULL,
    timeframe             TEXT NOT NULL,
    run_id                TEXT,
    score                 REAL DEFAULT 0,
    confidence            REAL DEFAULT 0,
    domains_json          TEXT DEFAULT '{}',
    reasons_json          TEXT DEFAULT '[]',
    suggested_holding_days INTEGER DEFAULT 7,
    updated_at            TEXT,
    PRIMARY KEY (symbol, timeframe)
  );
  CREATE INDEX IF NOT EXISTS idx_ts_score ON timeframe_scores(timeframe, score DESC);
`);

// ── Technical composite scores (written by technicalIntelligenceService) ─────
runMigration('036_technical_composite_scores', `
  CREATE TABLE IF NOT EXISTS technical_composite_scores (
    symbol                    TEXT PRIMARY KEY,
    trend_score               REAL DEFAULT 0,
    momentum_score            REAL DEFAULT 0,
    oscillator_score          REAL DEFAULT 0,
    volume_score              REAL DEFAULT 0,
    trend_strength_score      REAL DEFAULT 0,
    candlestick_score         REAL DEFAULT 0,
    support_resistance_score  REAL DEFAULT 0,
    risk_score                REAL DEFAULT 0,
    composite_score           REAL DEFAULT 0,
    bullish_flags             TEXT DEFAULT '[]',
    bearish_flags             TEXT DEFAULT '[]',
    ai_insight                TEXT,
    last_updated              TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tcs_composite ON technical_composite_scores(composite_score DESC);
`);

// ── Screener runs (created when a screener snapshot is taken for backtest) ───
runMigration('037_screener_runs', `
  CREATE TABLE IF NOT EXISTS screener_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      TEXT NOT NULL UNIQUE,
    screener_id TEXT NOT NULL,
    run_ts      TEXT NOT NULL DEFAULT (datetime('now')),
    records_json TEXT DEFAULT '[]',
    symbol_count INTEGER DEFAULT 0,
    triggered_by TEXT DEFAULT 'manual'
  );
  CREATE INDEX IF NOT EXISTS idx_sr_screener ON screener_runs(screener_id, run_ts DESC);
  CREATE INDEX IF NOT EXISTS idx_sr_run_id   ON screener_runs(run_id);
`);

// ── Agent pipeline output tables ─────────────────────────────────────────────
runMigration('038_agent_tables', `
  CREATE TABLE IF NOT EXISTS agent_data_scientist_reports (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    run_date                TEXT NOT NULL,
    ohlcv_coverage_pct      REAL DEFAULT 0,
    stale_symbols_count     INTEGER DEFAULT 0,
    fundamentals_fresh_count INTEGER DEFAULT 0,
    model_auc               REAL DEFAULT 0,
    model_drift_detected    INTEGER DEFAULT 0,
    signal_resolution_rate  REAL DEFAULT 0,
    data_quality_score      REAL DEFAULT 0,
    quality_grade           TEXT DEFAULT 'C',
    issues_json             TEXT DEFAULT '[]',
    narrative               TEXT,
    created_at              TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ads_run_date ON agent_data_scientist_reports(run_date DESC);

  CREATE TABLE IF NOT EXISTS agent_strategy_picks (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    run_date                 TEXT NOT NULL,
    timeframe                TEXT NOT NULL,
    symbol                   TEXT NOT NULL,
    rank                     INTEGER DEFAULT 1,
    conviction               TEXT DEFAULT 'MEDIUM',
    entry_zone_low           REAL,
    entry_zone_high          REAL,
    stop_loss                REAL,
    target_1                 REAL,
    target_2                 REAL,
    target_3                 REAL,
    composite_score          REAL DEFAULT 0,
    quant_rank               INTEGER DEFAULT 0,
    confluence_score         REAL DEFAULT 0,
    regime_alignment         TEXT DEFAULT 'NEUTRAL',
    supporting_signals_json  TEXT DEFAULT '[]',
    narrative                TEXT,
    created_at               TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_asp_run_date  ON agent_strategy_picks(run_date DESC);
  CREATE INDEX IF NOT EXISTS idx_asp_timeframe ON agent_strategy_picks(timeframe, rank);

  CREATE TABLE IF NOT EXISTS agent_audit_reports (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    run_date                 TEXT NOT NULL,
    audit_for_date           TEXT NOT NULL,
    timeframe                TEXT NOT NULL,
    total_picks              INTEGER DEFAULT 0,
    hits                     INTEGER DEFAULT 0,
    misses                   INTEGER DEFAULT 0,
    open_positions           INTEGER DEFAULT 0,
    hit_rate                 REAL DEFAULT 0,
    avg_return_pct           REAL DEFAULT 0,
    profit_factor            REAL DEFAULT 0,
    nifty_return_pct         REAL DEFAULT 0,
    alpha_pct                REAL DEFAULT 0,
    best_pick                TEXT,
    worst_pick               TEXT,
    signal_attribution_json  TEXT DEFAULT '{}',
    narrative                TEXT,
    created_at               TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_aar_run_date  ON agent_audit_reports(run_date DESC);
  CREATE INDEX IF NOT EXISTS idx_aar_timeframe ON agent_audit_reports(timeframe);

  CREATE TABLE IF NOT EXISTS agent_optimizer_reports (
    id                             INTEGER PRIMARY KEY AUTOINCREMENT,
    run_date                       TEXT NOT NULL,
    trigger                        TEXT DEFAULT 'scheduled',
    baseline_win_rate              REAL DEFAULT 0,
    new_win_rate                   REAL DEFAULT 0,
    improvement_pct                REAL DEFAULT 0,
    weights_changed                INTEGER DEFAULT 0,
    full_optimizer_triggered       INTEGER DEFAULT 0,
    changes_json                   TEXT DEFAULT '[]',
    underperforming_segments_json  TEXT DEFAULT '[]',
    narrative                      TEXT,
    created_at                     TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_aor_run_date ON agent_optimizer_reports(run_date DESC);
`);


runMigration('039_feature_store_index', `
  CREATE INDEX IF NOT EXISTS idx_fs_sym_tf_date ON feature_store(symbol, timeframe, date);
`);

// ── Backfill sector from nse_stocks into recommendation_log where sector is NULL ─
runMigration('040_rec_log_sector_backfill', `
  UPDATE recommendation_log
  SET sector = (
    SELECT ns.sector FROM nse_stocks ns WHERE ns.symbol = recommendation_log.symbol LIMIT 1
  )
  WHERE sector IS NULL OR sector = 'Unknown';
`);

// Date-leading index for cross-symbol date-range scans (the composite idx_fs_sym_tf_date
// leads with symbol, so a "all symbols for date range" scan could not use it).
runMigration('041_feature_store_date_index', `
  CREATE INDEX IF NOT EXISTS idx_fs_date ON feature_store(date);
`);

// Phase 2 schema consolidation: drop confirmed-dead tables (0 rows AND 0 read/write
// references anywhere in TS/Python — only their now-removed CREATE statements existed).
//  - historical_ohlc       : dead duplicate of stock_ohlcv
//  - confluence_alerts_log  : never written or read
//  - watchlist_alerts       : orphan (no CREATE in code; left over from an old build)
runMigration('042_drop_dead_phantom_tables', `
  DROP TABLE IF EXISTS historical_ohlc;
  DROP TABLE IF EXISTS confluence_alerts_log;
  DROP TABLE IF EXISTS watchlist_alerts;
`);

// ── Widen unified_signals uniqueness key to include signal_type ───────────────
// First pass (043): Added an explicit 4-col named index. But the old 3-col
// autoindex from UNIQUE(symbol, signal_date, signal_source) still blocks inserts
// — SQLite auto-indexes cannot be dropped independently. Migration 044 does the
// full table-recreation to remove the old constraint entirely.
runMigration('043_unified_signals_4col_key', `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_us_unique_key
    ON unified_signals(symbol, signal_source, signal_type, signal_date);
`);

// ── Rebuild unified_signals to remove the old 3-col UNIQUE constraint ─────────
// The old inline UNIQUE(symbol, signal_date, signal_source) created
// sqlite_autoindex_unified_signals_1 which cannot be dropped without recreating
// the table. This migration does the standard SQLite rename→recreate→copy→drop
// procedure so that only the 4-col UNIQUE survives. FK enforcement is off by
// default in SQLite; child tables reference unified_signals(id) which is a stable
// AUTOINCREMENT PK preserved through the copy so no FK rows are invalidated.
runMigration('044_unified_signals_rebuild_4col_unique', `
  PRAGMA foreign_keys=OFF;

  ALTER TABLE unified_signals RENAME TO unified_signals_old;

  CREATE TABLE unified_signals (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol             TEXT NOT NULL,
    signal_date        DATETIME DEFAULT CURRENT_TIMESTAMP,
    signal_source      TEXT NOT NULL,
    signal_type        TEXT NOT NULL,
    entry_price        REAL,
    target_price       REAL,
    stop_loss          REAL,
    confidence_score   REAL,
    reasoning          TEXT,
    technical_score    REAL,
    quant_score        REAL,
    ai_reasoning       TEXT,
    status             TEXT DEFAULT 'ACTIVE',
    signal_generated_at DATETIME NOT NULL,
    created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(symbol, signal_source, signal_type, signal_date)
  );

  INSERT INTO unified_signals SELECT * FROM unified_signals_old;

  DROP TABLE unified_signals_old;

  CREATE INDEX IF NOT EXISTS idx_us_symbol_date ON unified_signals(symbol, signal_date DESC);
  CREATE INDEX IF NOT EXISTS idx_us_source ON unified_signals(signal_source);
  CREATE INDEX IF NOT EXISTS idx_us_confidence ON unified_signals(confidence_score DESC);
  CREATE INDEX IF NOT EXISTS idx_us_status ON unified_signals(status);
  CREATE INDEX IF NOT EXISTS idx_unified_signals_date ON unified_signals(signal_date DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_us_unique_key
    ON unified_signals(symbol, signal_source, signal_type, signal_date);

  PRAGMA foreign_keys=ON;
`);

runMigration('045_drop_legacy_signals', `
  DROP TABLE IF EXISTS signals;
`);

// Directional Buy/Sell label for the Top Rated UI reroute (unified_ranker._classify).
migrateColumn('unified_recommendations', 'classification', 'TEXT');
migrateColumn('unified_recommendations', 'position_size_pct', 'REAL');

// ── Quant Data Persistence (Historical Data for ML/RL Models) ─────────────────
runMigration('046_quant_data_persistence', `
  CREATE TABLE IF NOT EXISTS historical_fundamentals (
    symbol            TEXT NOT NULL,
    date              TEXT NOT NULL,
    trailing_pe       REAL,
    forward_pe        REAL,
    price_to_book     REAL,
    book_value        REAL,
    earnings_yield    REAL,
    eps_ttm           REAL,
    eps_forward       REAL,
    revenue_growth    REAL,
    debt_to_equity    REAL,
    roe               REAL,
    roce              REAL,
    operating_margin  REAL,
    net_margin        REAL,
    piotroski_score   INTEGER,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, date)
  );

  CREATE TABLE IF NOT EXISTS stock_delivery_data (
    symbol            TEXT NOT NULL,
    date              TEXT NOT NULL,
    delivery_pct      REAL,
    delivery_qty      INTEGER,
    traded_qty        INTEGER,
    trades            INTEGER,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, date)
  );

  CREATE TABLE IF NOT EXISTS historical_fno_sentiment (
    symbol            TEXT NOT NULL,
    date              TEXT NOT NULL,
    pcr_oi            REAL,
    pcr_vol           REAL,
    max_pain          REAL,
    atm_iv            REAL,
    iv_skew           REAL,
    total_ce_oi       INTEGER,
    total_pe_oi       INTEGER,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, date)
  );

  CREATE TABLE IF NOT EXISTS screener_history_log (
    symbol            TEXT NOT NULL,
    screener_id       TEXT NOT NULL,
    entry_date        TEXT NOT NULL,
    exit_date         TEXT,
    source            TEXT NOT NULL, -- e.g., 'trendlyne', 'moneycontrol', 'niftytrader'
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, screener_id, entry_date)
  );

  CREATE TABLE IF NOT EXISTS proprietary_scores_history (
    symbol            TEXT NOT NULL,
    date              TEXT NOT NULL,
    source            TEXT NOT NULL, -- e.g., 'niftytrader', 'moneycontrol'
    score_type        TEXT NOT NULL, -- e.g., 'technical_rating', 'financial_score', 'community_sentiment'
    score_value       REAL,
    score_label       TEXT,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, date, source, score_type)
  );
`);

runMigration('047_live_screener_optimization', `
  CREATE TABLE IF NOT EXISTS live_screener_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    filters_completed INTEGER NOT NULL,
    total_filters INTEGER NOT NULL,
    status TEXT NOT NULL,
    error_log TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS live_screener_appearances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    filter_key TEXT NOT NULL,
    price REAL NOT NULL,
    change_per REAL,
    volume INTEGER,
    FOREIGN KEY(run_id) REFERENCES live_screener_runs(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_lsa_run ON live_screener_appearances(run_id);
  CREATE INDEX IF NOT EXISTS idx_lsa_symbol_filter ON live_screener_appearances(symbol, filter_key);

  CREATE TABLE IF NOT EXISTS live_screener_outcomes (
    appearance_id INTEGER PRIMARY KEY,
    symbol TEXT NOT NULL,
    filter_key TEXT NOT NULL,
    appeared_at TEXT NOT NULL,
    entry_price REAL NOT NULL,
    return_1d REAL,
    return_3d REAL,
    return_5d REAL,
    FOREIGN KEY(appearance_id) REFERENCES live_screener_appearances(id) ON DELETE CASCADE
  );
`);

runMigration('048_cs_score_column', `
  ALTER TABLE technical_signals ADD COLUMN cs_score REAL;
  CREATE INDEX IF NOT EXISTS idx_ts_cs_score
    ON technical_signals(cs_score) WHERE cs_score IS NOT NULL;
`);

// 049 — two new ML features written by feature scripts and consumed by build_features():
//   avwap_deviation_pct : (close − 20-day anchored VWAP) / avwap * 100
//                         Anchored VWAP from rolling 20-day window using stock_ohlcv.
//   oi_net_change_pct   : (today_total_oi − prev_total_oi) / prev_total_oi * 100
//                         Day-over-day net OI change from stock_options_oi.
runMigration('049_avwap_oi_features', `
  ALTER TABLE technical_signals ADD COLUMN avwap_deviation_pct REAL;
  ALTER TABLE technical_signals ADD COLUMN oi_net_change_pct   REAL;
`);

// 050 — earnings beat/miss history + features (#47)
//   stock_earnings_beats : per-symbol quarterly EPS beat/miss from MoneyControl
//   eps_beat_last_q      : most recent quarter beat score (+1/0/-1)
//   eps_beat_streak_4q   : consecutive beats in last 4 quarters
//   eps_miss_streak_4q   : consecutive misses in last 4 quarters
runMigration('050_earnings_beats', `
  CREATE TABLE IF NOT EXISTS stock_earnings_beats (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol       TEXT NOT NULL,
    quarter_date TEXT NOT NULL,
    period_type  TEXT NOT NULL DEFAULT 'quarterly',
    beat_type    TEXT NOT NULL,
    beat_score   INTEGER NOT NULL DEFAULT 0,
    eps_actual   REAL,
    eps_avg      REAL,
    eps_high     REAL,
    eps_low      REAL,
    surprise_pct REAL,
    fetched_at   TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(symbol, quarter_date)
  );
  CREATE INDEX IF NOT EXISTS idx_seb_symbol ON stock_earnings_beats(symbol);
  CREATE INDEX IF NOT EXISTS idx_seb_quarter ON stock_earnings_beats(quarter_date);
  ALTER TABLE technical_signals ADD COLUMN eps_beat_last_q    INTEGER;
  ALTER TABLE technical_signals ADD COLUMN eps_beat_streak_4q INTEGER;
  ALTER TABLE technical_signals ADD COLUMN eps_miss_streak_4q INTEGER;
  ALTER TABLE technical_signals ADD COLUMN eps_surprise_last_yr REAL;
  ALTER TABLE technical_signals ADD COLUMN eps_estimate_dispersion REAL;
`);

// 051 — G6 12-1 momentum feature: 12-month return minus last month (academia-validated factor)
runMigration('051_feature_store_momentum', `
  ALTER TABLE feature_store ADD COLUMN ret_12m_ex1m REAL;
`);

runMigration('053_fno_rollover', `
  ALTER TABLE technical_signals ADD COLUMN rollover_pct      REAL;
  ALTER TABLE technical_signals ADD COLUMN cost_of_carry_ann REAL;
`);

runMigration('052_mf_holdings_signals', `
  ALTER TABLE nse_stocks ADD COLUMN is_asm INTEGER DEFAULT 0;
  ALTER TABLE nse_stocks ADD COLUMN gsm_stage INTEGER DEFAULT 0;
  ALTER TABLE nse_stocks ADD COLUMN surveillance_updated_at TEXT;
  ALTER TABLE technical_signals ADD COLUMN mf_holding_pct REAL;
  ALTER TABLE technical_signals ADD COLUMN mf_fund_count INTEGER;
  ALTER TABLE technical_signals ADD COLUMN mf_chg_vs_prev REAL;
  ALTER TABLE technical_signals ADD COLUMN sector_global_corr_21d REAL;
  ALTER TABLE technical_signals ADD COLUMN sector_benchmark TEXT;
`);

runMigration('054_delivery_block_deals', `
  ALTER TABLE technical_signals ADD COLUMN block_deal_net_qty BIGINT;
  ALTER TABLE technical_signals ADD COLUMN block_deal_value_cr REAL;
`);

runMigration('055_trendlyne_fundamentals', `
  ALTER TABLE technical_signals ADD COLUMN eps_ttm          REAL;
  ALTER TABLE technical_signals ADD COLUMN eps_growth_yoy   REAL;
  ALTER TABLE technical_signals ADD COLUMN eps_growth_qoq   REAL;
  ALTER TABLE technical_signals ADD COLUMN eps_acceleration  REAL;
  ALTER TABLE technical_signals ADD COLUMN pe_ttm            REAL;
  ALTER TABLE technical_signals ADD COLUMN dvm_durability    INTEGER;
  ALTER TABLE technical_signals ADD COLUMN dvm_valuation     INTEGER;
  ALTER TABLE technical_signals ADD COLUMN dvm_momentum      INTEGER;
`);

runMigration('056_trendlyne_adv_tech_and_overview', `
  ALTER TABLE technical_signals ADD COLUMN pe_pct_rank_252d   REAL;
  ALTER TABLE technical_signals ADD COLUMN pe_vs_median_1yr   REAL;
  ALTER TABLE technical_signals ADD COLUMN pb_pct_rank_252d   REAL;
  ALTER TABLE technical_signals ADD COLUMN div_yield_ttm      REAL;
  ALTER TABLE technical_signals ADD COLUMN ma_bull_frac        REAL;
  ALTER TABLE technical_signals ADD COLUMN osc_bull_frac       REAL;
  ALTER TABLE technical_signals ADD COLUMN adx_tl              REAL;
  ALTER TABLE technical_signals ADD COLUMN atr_pct_tl          REAL;
  ALTER TABLE technical_signals ADD COLUMN mfi_tl              REAL;
  ALTER TABLE technical_signals ADD COLUMN pivot_dist_pct_tl   REAL;
  ALTER TABLE technical_signals ADD COLUMN delivery_avg_1m_tl  REAL;
  ALTER TABLE technical_signals ADD COLUMN beta_1y_tl          REAL;
  ALTER TABLE technical_signals ADD COLUMN ret_1m_tl           REAL;
  ALTER TABLE technical_signals ADD COLUMN ret_3m_tl           REAL;
  ALTER TABLE technical_signals ADD COLUMN ret_6m_tl           REAL;
  ALTER TABLE technical_signals ADD COLUMN ret_1y_tl           REAL;
  ALTER TABLE technical_signals ADD COLUMN analyst_upside_pct  REAL;
  ALTER TABLE technical_signals ADD COLUMN analyst_count       INTEGER;
  ALTER TABLE technical_signals ADD COLUMN analyst_buy_pct     REAL;
  ALTER TABLE technical_signals ADD COLUMN roe_annual          REAL;
  ALTER TABLE technical_signals ADD COLUMN roce_annual         REAL;
  ALTER TABLE technical_signals ADD COLUMN ebitda_margin       REAL;
  ALTER TABLE technical_signals ADD COLUMN np_margin           REAL;
  ALTER TABLE technical_signals ADD COLUMN promoter_pct        REAL;
  ALTER TABLE technical_signals ADD COLUMN fii_pct             REAL;
  ALTER TABLE technical_signals ADD COLUMN pledge_pct          REAL;
  ALTER TABLE technical_signals ADD COLUMN rev_growth_yoy_q    REAL;
  ALTER TABLE technical_signals ADD COLUMN np_growth_yoy_q     REAL;
  ALTER TABLE technical_signals ADD COLUMN days_since_dividend INTEGER;
  ALTER TABLE technical_signals ADD COLUMN last_dividend_amt   REAL;
`);

runMigration('057_mc_pricefeed_and_patterns', `
  ALTER TABLE technical_signals ADD COLUMN mc_52w_high_dist_pct REAL;
  ALTER TABLE technical_signals ADD COLUMN mc_52w_low_dist_pct  REAL;
  ALTER TABLE technical_signals ADD COLUMN mc_days_from_52wh    INTEGER;
  ALTER TABLE technical_signals ADD COLUMN mc_cagr_3y           REAL;
  ALTER TABLE technical_signals ADD COLUMN mc_cagr_5y           REAL;
  ALTER TABLE technical_signals ADD COLUMN mc_ind_pe            REAL;
  ALTER TABLE technical_signals ADD COLUMN mc_pe_vs_ind         REAL;
  ALTER TABLE technical_signals ADD COLUMN mc_consensus_pe      REAL;
  ALTER TABLE technical_signals ADD COLUMN mc_ma50_dist_pct     REAL;
  ALTER TABLE technical_signals ADD COLUMN mc_ma200_dist_pct    REAL;
  ALTER TABLE technical_signals ADD COLUMN mc_del_pct_20d       REAL;
  ALTER TABLE technical_signals ADD COLUMN mc_vol_ratio         REAL;
  ALTER TABLE technical_signals ADD COLUMN mc_circuit_dist_pct  REAL;
  ALTER TABLE technical_signals ADD COLUMN mc_cp_bull_count     INTEGER;
  ALTER TABLE technical_signals ADD COLUMN mc_cp_bear_count     INTEGER;
  ALTER TABLE technical_signals ADD COLUMN mc_cp_net_score      INTEGER;
  ALTER TABLE technical_signals ADD COLUMN mc_cp_avg_target_pct REAL;
  ALTER TABLE technical_signals ADD COLUMN tl_vs_nifty_1m       REAL;
  ALTER TABLE technical_signals ADD COLUMN tl_vs_nifty_3m       REAL;
  ALTER TABLE technical_signals ADD COLUMN tl_vs_nifty_6m       REAL;
  ALTER TABLE technical_signals ADD COLUMN tl_vs_ind_1m         REAL;
  ALTER TABLE technical_signals ADD COLUMN tl_vs_ind_3m         REAL;
  ALTER TABLE technical_signals ADD COLUMN tl_seasonal_month_5y REAL;
  ALTER TABLE technical_signals ADD COLUMN tl_dist_3m_high_pct  REAL;
  ALTER TABLE technical_signals ADD COLUMN tl_dist_3m_low_pct   REAL;
`);

runMigration('058_mc_unique_fields', `
  ALTER TABLE technical_signals ADD COLUMN mc_cagr_10y          REAL;
  ALTER TABLE technical_signals ADD COLUMN mc_consensus_pb      REAL;
  ALTER TABLE technical_signals ADD COLUMN mc_ma30_dist_pct     REAL;
  ALTER TABLE technical_signals ADD COLUMN mc_ma150_dist_pct    REAL;
  ALTER TABLE technical_signals ADD COLUMN mc_del_pct_3d        REAL;
  ALTER TABLE technical_signals ADD COLUMN mc_del_pct_5d        REAL;
  ALTER TABLE technical_signals ADD COLUMN mc_del_acceleration  REAL;
  ALTER TABLE technical_signals ADD COLUMN mc_fno_eligible      INTEGER;
  ALTER TABLE technical_signals ADD COLUMN mc_3d_return         REAL;
  ALTER TABLE technical_signals ADD COLUMN mc_ytd_return        REAL;
  ALTER TABLE technical_signals ADD COLUMN mc_price_cash        REAL;
  ALTER TABLE technical_signals ADD COLUMN mc_consensus_eps     REAL;
  ALTER TABLE technical_signals ADD COLUMN mc_eps_vs_cons       REAL;
  ALTER TABLE technical_signals ADD COLUMN mc_pe_fwd_discount   REAL;
`);

runMigration('059_nt_fno_dashboard', `
  ALTER TABLE technical_signals ADD COLUMN nt_max_pain_dist_pct REAL;
  ALTER TABLE technical_signals ADD COLUMN nt_oi_direction       REAL;
  ALTER TABLE technical_signals ADD COLUMN nt_pcr                REAL;
  ALTER TABLE technical_signals ADD COLUMN nt_option_volume_log  REAL;
`);

runMigration('060_nt_fno_eligibility', `
  ALTER TABLE nse_stocks ADD COLUMN fno_eligible  INTEGER DEFAULT 0;
  ALTER TABLE nse_stocks ADD COLUMN lot_size      REAL;
  ALTER TABLE nse_stocks ADD COLUMN fno_lot_updated_at TEXT;
`);

runMigration('062_mc_earnings_data', `
  CREATE TABLE IF NOT EXISTS stock_earnings_dates (
    scid        TEXT NOT NULL,
    result_date TEXT NOT NULL,
    stock_name  TEXT,
    result_type TEXT,
    result_time TEXT,
    market_cap  REAL,
    exchange    TEXT,
    fetched_at  TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (scid, result_date)
  );
  CREATE TABLE IF NOT EXISTS mc_earnings_rapid (
    scid           TEXT NOT NULL,
    sub_type       TEXT NOT NULL,
    category       TEXT NOT NULL,
    result_date    TEXT,
    stock_name     TEXT,
    ltp            REAL,
    change_pct     REAL,
    revenue_curr   REAL,
    revenue_prev   REAL,
    revenue_growth REAL,
    np_curr        REAL,
    np_prev        REAL,
    np_growth      REAL,
    category_score INTEGER,
    fetched_at     TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (scid, sub_type, category)
  );
  CREATE TABLE IF NOT EXISTS mc_price_shockers (
    scid              TEXT PRIMARY KEY,
    stock_name        TEXT,
    result_date       TEXT,
    gain_since_result REAL,
    ltp               REAL,
    change_pct        REAL,
    fetched_at        TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS mc_sector_earnings (
    sector_name    TEXT PRIMARY KEY,
    market_cap     REAL,
    rev_growth_yoy REAL,
    rev_growth_qoq REAL,
    np_growth_yoy  REAL,
    np_growth_qoq  REAL,
    gp_growth_yoy  REAL,
    gp_growth_qoq  REAL,
    fetched_at     TEXT DEFAULT CURRENT_TIMESTAMP
  );
  ALTER TABLE technical_signals ADD COLUMN days_to_next_results  INTEGER;
  ALTER TABLE technical_signals ADD COLUMN earnings_category_yoy INTEGER;
  ALTER TABLE technical_signals ADD COLUMN earnings_category_qoq INTEGER;
  ALTER TABLE technical_signals ADD COLUMN earnings_np_growth_yoy REAL;
  ALTER TABLE technical_signals ADD COLUMN earnings_np_growth_qoq REAL;
  ALTER TABLE technical_signals ADD COLUMN earnings_shocker_flag  INTEGER;
  ALTER TABLE technical_signals ADD COLUMN earnings_shocker_gain  REAL;
`);

runMigration('061_mc_premarket_sources', `
  CREATE TABLE IF NOT EXISTS eco_calendar (
    calendar_id  TEXT PRIMARY KEY,
    event_date   TEXT,
    event_time   TEXT,
    country      TEXT,
    country_name TEXT,
    event_name   TEXT,
    category     TEXT,
    impact       INTEGER,
    actual       TEXT,
    previous     TEXT,
    consensus    TEXT,
    reference    TEXT,
    symbol       TEXT,
    fetched_at   TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS mc_broker_reco (
    scid              TEXT NOT NULL,
    stock_name        TEXT,
    organization      TEXT NOT NULL,
    recommend_flag    TEXT,
    recommended_price REAL,
    target            REAL,
    entry_date        TEXT,
    recommend_date    TEXT,
    fetched_at        TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (scid, organization, entry_date)
  );
  CREATE TABLE IF NOT EXISTS preopen_snapshot (
    snapshot_date     TEXT PRIMARY KEY,
    snapshot_time     TEXT,
    gift_nifty        REAL,
    gift_nifty_chg    REAL,
    gift_nifty_pct    REAL,
    dj_futures        REAL,
    dj_futures_pct    REAL,
    hang_seng_pct     REAL,
    nikkei_pct        REAL,
    nasdaq_pct        REAL,
    asia_sentiment    REAL,
    global_risk_score REAL,
    fetched_at        TEXT DEFAULT CURRENT_TIMESTAMP
  );
  ALTER TABLE technical_signals ADD COLUMN mc_broker_buy_7d  INTEGER;
  ALTER TABLE technical_signals ADD COLUMN mc_broker_sell_7d INTEGER;
  ALTER TABLE technical_signals ADD COLUMN mc_broker_upside  REAL;
`);

runMigration('060_computed_ml_features', `
  ALTER TABLE technical_signals ADD COLUMN hv_10d                REAL;
  ALTER TABLE technical_signals ADD COLUMN hv_20d                REAL;
  ALTER TABLE technical_signals ADD COLUMN hv_30d                REAL;
  ALTER TABLE technical_signals ADD COLUMN hv_60d                REAL;
  ALTER TABLE technical_signals ADD COLUMN iv_hv_ratio           REAL;
  ALTER TABLE technical_signals ADD COLUMN eps_revision_3m_pct   REAL;
  ALTER TABLE technical_signals ADD COLUMN target_revision_3m_pct REAL;
  ALTER TABLE technical_signals ADD COLUMN analyst_count_chg     INTEGER;
  ALTER TABLE technical_signals ADD COLUMN rs_vs_sector_21d      REAL;
  ALTER TABLE technical_signals ADD COLUMN rs_vs_sector_63d      REAL;
  ALTER TABLE technical_signals ADD COLUMN asm_flag              INTEGER DEFAULT 0;
  ALTER TABLE technical_signals ADD COLUMN gsm_stage             INTEGER DEFAULT 0;
  ALTER TABLE technical_signals ADD COLUMN crude_corr_90d        REAL;
  ALTER TABLE technical_signals ADD COLUMN gold_corr_90d         REAL;
  ALTER TABLE technical_signals ADD COLUMN dxy_corr_90d          REAL;
  ALTER TABLE technical_signals ADD COLUMN sp500_corr_90d        REAL;
`);

runMigration('064_earnings_quality_insider_macro', `
  CREATE TABLE IF NOT EXISTS eps_surprise_history (
    scid          TEXT NOT NULL,
    symbol        TEXT,
    quarter       TEXT NOT NULL,
    np_actual     REAL,
    np_estimate   REAL,
    np_surprise   REAL,
    rev_actual    REAL,
    rev_estimate  REAL,
    rev_surprise  REAL,
    eps_actual    REAL,
    eps_estimate  REAL,
    eps_surprise  REAL,
    fetched_at    TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (scid, quarter)
  );
  CREATE TABLE IF NOT EXISTS tl_financial_quality (
    symbol               TEXT NOT NULL,
    as_of_date           TEXT NOT NULL,
    cfo_ttm              REAL,
    cfi_ttm              REAL,
    fcf_ttm_approx       REAL,
    interest_coverage    REAL,
    market_cap           REAL,
    fcf_yield_approx     REAL,
    fetched_at           TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, as_of_date)
  );
  CREATE TABLE IF NOT EXISTS working_capital_history (
    symbol           TEXT NOT NULL,
    fiscal_year      TEXT NOT NULL,
    receivables_days REAL,
    inventory_days   REAL,
    payables_days    REAL,
    ccc              REAL,
    revenue_fy       REAL,
    cogs_proxy_fy    REAL,
    fetched_at       TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, fiscal_year)
  );
  CREATE TABLE IF NOT EXISTS insider_transactions (
    symbol           TEXT NOT NULL,
    person_name      TEXT NOT NULL,
    person_category  TEXT,
    transaction_mode TEXT NOT NULL,
    quantity         REAL,
    value_cr         REAL,
    before_pct       REAL,
    after_pct        REAL,
    transaction_date TEXT NOT NULL,
    fetched_at       TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, person_name, transaction_date, transaction_mode)
  );
  CREATE TABLE IF NOT EXISTS bulk_block_deals (
    symbol      TEXT NOT NULL,
    deal_date   TEXT NOT NULL,
    deal_type   TEXT NOT NULL,
    client_name TEXT NOT NULL,
    buy_sell    TEXT,
    quantity    REAL,
    price       REAL,
    value_cr    REAL,
    fetched_at  TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, deal_date, client_name, deal_type)
  );
  CREATE TABLE IF NOT EXISTS credit_rating_events (
    bse_code          TEXT NOT NULL,
    symbol            TEXT,
    isin              TEXT,
    announcement_date TEXT NOT NULL,
    rating_agency     TEXT NOT NULL,
    action            TEXT,
    instrument_type   TEXT,
    headline          TEXT,
    fetched_at        TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (bse_code, announcement_date, rating_agency)
  );
  CREATE TABLE IF NOT EXISTS mf_sector_allocation (
    month   TEXT NOT NULL,
    sector  TEXT NOT NULL,
    aum_cr  REAL,
    aum_pct REAL,
    PRIMARY KEY (month, sector)
  );
  ALTER TABLE technical_signals ADD COLUMN eps_surprise_q1       REAL;
  ALTER TABLE technical_signals ADD COLUMN eps_surprise_q2       REAL;
  ALTER TABLE technical_signals ADD COLUMN eps_beat_streak       INTEGER;
  ALTER TABLE technical_signals ADD COLUMN eps_miss_after_streak INTEGER DEFAULT 0;
  ALTER TABLE technical_signals ADD COLUMN rev_surprise_q1       REAL;
  ALTER TABLE technical_signals ADD COLUMN fcf_yield             REAL;
  ALTER TABLE technical_signals ADD COLUMN fcf_yield_approx      REAL;
  ALTER TABLE technical_signals ADD COLUMN interest_coverage     REAL;
  ALTER TABLE technical_signals ADD COLUMN fcf_positive          INTEGER DEFAULT 0;
  ALTER TABLE technical_signals ADD COLUMN debt_coverage_risk    INTEGER DEFAULT 0;
  ALTER TABLE technical_signals ADD COLUMN delivery_trend_30d    REAL;
  ALTER TABLE technical_signals ADD COLUMN block_deal_flag       INTEGER DEFAULT 0;
  ALTER TABLE technical_signals ADD COLUMN block_deal_direction  INTEGER DEFAULT 0;
  ALTER TABLE technical_signals ADD COLUMN short_interest_proxy  REAL;
  ALTER TABLE technical_signals ADD COLUMN promoter_buy_90d_cr   REAL;
  ALTER TABLE technical_signals ADD COLUMN promoter_sell_90d_cr  REAL;
  ALTER TABLE technical_signals ADD COLUMN promoter_net_90d      REAL;
  ALTER TABLE technical_signals ADD COLUMN insider_buy_flag      INTEGER DEFAULT 0;
  ALTER TABLE technical_signals ADD COLUMN insider_sell_flag     INTEGER DEFAULT 0;
  ALTER TABLE technical_signals ADD COLUMN rating_upgrade_180d   INTEGER DEFAULT 0;
  ALTER TABLE technical_signals ADD COLUMN rating_downgrade_180d INTEGER DEFAULT 0;
  ALTER TABLE technical_signals ADD COLUMN days_since_upgrade    INTEGER;
  ALTER TABLE technical_signals ADD COLUMN mf_sector_flow_pct   REAL;
  ALTER TABLE technical_signals ADD COLUMN receivables_days_ttm  REAL;
  ALTER TABLE technical_signals ADD COLUMN ccc_ttm               REAL;
  ALTER TABLE technical_signals ADD COLUMN ccc_trend             REAL;
  ALTER TABLE technical_signals ADD COLUMN wc_deteriorating      INTEGER DEFAULT 0;
  ALTER TABLE technical_signals ADD COLUMN wc_improving          INTEGER DEFAULT 0;
`);

runMigration('063_index_membership_pledge_preopen_options', `
  -- Index membership flags on nse_stocks
  ALTER TABLE nse_stocks ADD COLUMN is_nifty50         INTEGER DEFAULT 0;
  ALTER TABLE nse_stocks ADD COLUMN is_nifty100        INTEGER DEFAULT 0;
  ALTER TABLE nse_stocks ADD COLUMN is_nifty200        INTEGER DEFAULT 0;
  ALTER TABLE nse_stocks ADD COLUMN is_midcap150       INTEGER DEFAULT 0;
  ALTER TABLE nse_stocks ADD COLUMN is_smallcap250     INTEGER DEFAULT 0;
  ALTER TABLE nse_stocks ADD COLUMN index_flags_updated_at TEXT;

  -- pledge_pct snapshot in fundamentals_history
  ALTER TABLE fundamentals_history ADD COLUMN pledge_pct REAL;

  -- Per-stock pre-open IEP snapshot
  CREATE TABLE IF NOT EXISTS preopen_stock_snapshot (
    symbol            TEXT NOT NULL,
    snapshot_date     TEXT NOT NULL,
    iep               REAL,
    prev_close        REAL,
    iep_gap_pct       REAL,
    total_buy_qty     REAL,
    total_sell_qty    REAL,
    preopen_imbalance REAL,
    last_price        REAL,
    fetched_at        TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, snapshot_date)
  );

  -- Per-stock option chain features
  CREATE TABLE IF NOT EXISTS stock_option_features (
    symbol              TEXT NOT NULL,
    date                TEXT NOT NULL,
    expiry              TEXT,
    spot                REAL,
    atm_strike          REAL,
    atm_call_ltp        REAL,
    atm_put_ltp         REAL,
    expected_move_pct   REAL,
    total_call_oi       REAL,
    total_put_oi        REAL,
    gex_proxy           REAL,
    fetched_at          TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, date)
  );

  -- technical_signals: new ML feature columns
  ALTER TABLE technical_signals ADD COLUMN is_nifty50         INTEGER DEFAULT 0;
  ALTER TABLE technical_signals ADD COLUMN is_nifty100        INTEGER DEFAULT 0;
  ALTER TABLE technical_signals ADD COLUMN is_nifty200        INTEGER DEFAULT 0;
  ALTER TABLE technical_signals ADD COLUMN is_midcap150       INTEGER DEFAULT 0;
  ALTER TABLE technical_signals ADD COLUMN is_smallcap250     INTEGER DEFAULT 0;
  ALTER TABLE technical_signals ADD COLUMN nifty_tier         INTEGER DEFAULT 0;
  ALTER TABLE technical_signals ADD COLUMN pledge_chg_90d     REAL;
  ALTER TABLE technical_signals ADD COLUMN iep_gap_pct        REAL;
  ALTER TABLE technical_signals ADD COLUMN preopen_imbalance  REAL;
  ALTER TABLE technical_signals ADD COLUMN expected_move_pct  REAL;
  ALTER TABLE technical_signals ADD COLUMN stock_gex_proxy    REAL;
`);

runMigration('067_ownership_flow_features', `
  ALTER TABLE technical_signals ADD COLUMN mf_funds_adding      INTEGER;
  ALTER TABLE technical_signals ADD COLUMN mf_funds_trimming    INTEGER;
  ALTER TABLE technical_signals ADD COLUMN mf_add_trim_ratio    REAL;
  ALTER TABLE technical_signals ADD COLUMN mf_pct               REAL;
  ALTER TABLE technical_signals ADD COLUMN promoter_chg_qoq     REAL;
  ALTER TABLE technical_signals ADD COLUMN fii_chg_qoq          REAL;
  ALTER TABLE technical_signals ADD COLUMN mf_chg_qoq           REAL;
  ALTER TABLE technical_signals ADD COLUMN pledge_chg_qoq       REAL;
`);

runMigration('068_mf_conviction_ownership_relative', `
  ALTER TABLE technical_signals ADD COLUMN mf_avg_pct_assets    REAL;
  ALTER TABLE technical_signals ADD COLUMN mf_big_fund_flow     REAL;
  ALTER TABLE technical_signals ADD COLUMN mf_flow_vs_sector    REAL;
  ALTER TABLE technical_signals ADD COLUMN mf_flow_rank         REAL;
`);

// ── Retention: confluence_signals is an append-only firehose (~700k rows, the single
// largest contributor to DB bloat). expires_at exists but nothing pruned it. Delete
// expired rows on boot and every 6h. Keeps the table bounded without losing live signals.
const _pruneConfluenceBatch = db.prepare(
  `DELETE FROM confluence_signals WHERE rowid IN (
     SELECT rowid FROM confluence_signals
     WHERE (expires_at IS NOT NULL AND expires_at < datetime('now'))
        OR (expires_at IS NULL AND computed_at < datetime('now', '-90 days'))
     LIMIT 20000
   )`
);
function pruneConfluenceSignals(): void {
  // Delete in bounded batches so a large first prune (the table can be >90% expired)
  // never stalls the event loop in a single multi-hundred-thousand-row transaction.
  try {
    let total = 0, changes = 0;
    do {
      changes = _pruneConfluenceBatch.run().changes;
      total += changes;
    } while (changes >= 20000);
    if (total > 0) console.error(`[DB] Pruned ${total} expired confluence_signals rows`);
  } catch (err) {
    console.error('[DB] confluence_signals prune failed:', (err as Error).message);
  }
}
if (!usePostgres()) {
  setTimeout(pruneConfluenceSignals, 30_000).unref();
  setInterval(pruneConfluenceSignals, 6 * 60 * 60 * 1000).unref();
}

db.exec(`
  -- Strike-wise index option OI (Nifty / BankNifty per expiry from MoneyControl)
  CREATE TABLE IF NOT EXISTS index_option_oi (
    index_name    TEXT NOT NULL,
    date          TEXT NOT NULL,
    expiry        TEXT NOT NULL,
    strike        REAL NOT NULL,
    ce_oi         INTEGER,
    pe_oi         INTEGER,
    ce_oi_change  INTEGER,
    pe_oi_change  INTEGER,
    ce_ltp        REAL,
    pe_ltp        REAL,
    fetched_at    TEXT NOT NULL,
    PRIMARY KEY (index_name, date, expiry, strike)
  );
  CREATE TABLE IF NOT EXISTS index_max_pain (
    index_name   TEXT NOT NULL,
    date         TEXT NOT NULL,
    expiry       TEXT NOT NULL,
    max_pain     REAL,
    pcr_oi       REAL,
    total_ce_oi  INTEGER,
    total_pe_oi  INTEGER,
    fetched_at   TEXT NOT NULL,
    PRIMARY KEY (index_name, date, expiry)
  );
  -- MoneyControl NSE/BSE advance-decline daily counts
  CREATE TABLE IF NOT EXISTS mc_advance_decline (
    date          TEXT NOT NULL,
    exchange      TEXT NOT NULL DEFAULT 'NSE',
    advances      INTEGER,
    declines      INTEGER,
    unchanged     INTEGER,
    adv_dec_ratio REAL,
    fetched_at    TEXT NOT NULL,
    PRIMARY KEY (date, exchange)
  );
`);

db.exec(`
  -- Nifty index valuation time-series: PE, PB, Dividend Yield, EPS
  CREATE TABLE IF NOT EXISTS index_valuation (
    index_name  TEXT NOT NULL,
    date        TEXT NOT NULL,
    pe          REAL,
    pb          REAL,
    div_yield   REAL,
    fetched_at  TEXT NOT NULL,
    PRIMARY KEY (index_name, date)
  );
  CREATE INDEX IF NOT EXISTS idx_iv_name_date ON index_valuation(index_name, date DESC);
`);

db.exec(`
  -- NSE market holiday calendar (populated by scripts/seed_market_holidays.py or migrations)
  CREATE TABLE IF NOT EXISTS market_holidays (
    date        TEXT NOT NULL,
    exchange    TEXT NOT NULL DEFAULT 'NSE',
    description TEXT,
    PRIMARY KEY (date, exchange)
  );
`);

db.exec(`
  -- Provider-specific index identifiers (mc_ohlc, mc_pe, mc_oi, yahoo, trendlyne, nt_index)
  CREATE TABLE IF NOT EXISTS index_provider_map (
    index_name  TEXT NOT NULL,
    provider    TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    PRIMARY KEY (index_name, provider)
  );
`);

db.exec(`
  -- NiftyTrader intraday PCR time-series for indices (minute-level)
  CREATE TABLE IF NOT EXISTS nt_index_pcr_ts (
    index_name    TEXT NOT NULL,
    ts            TEXT NOT NULL,  -- ISO datetime "2026-06-28T09:15:00"
    expiry        TEXT NOT NULL,  -- "2026-06-30"
    pcr           REAL,
    volume_pcr    REAL,
    change_oi_pcr REAL,
    index_close   REAL,
    fetched_at    TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (index_name, ts, expiry)
  );
  CREATE INDEX IF NOT EXISTS idx_nt_pcr_ts ON nt_index_pcr_ts(index_name, ts DESC);

  -- NiftyTrader EOD strike-wise OI snapshot for indices
  CREATE TABLE IF NOT EXISTS nt_index_oi_eod (
    index_name      TEXT NOT NULL,
    date            TEXT NOT NULL,
    expiry          TEXT NOT NULL,
    strike          REAL NOT NULL,
    snap_time       TEXT NOT NULL,
    index_close     REAL,
    calls_oi        REAL,
    puts_oi         REAL,
    calls_change_oi REAL,
    puts_change_oi  REAL,
    calls_volume    REAL,
    puts_volume     REAL,
    calls_oi_value  REAL,
    puts_oi_value   REAL,
    fetched_at      TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (index_name, date, expiry, strike)
  );
  CREATE INDEX IF NOT EXISTS idx_nt_oi_eod ON nt_index_oi_eod(index_name, date DESC);
`);

db.exec(`
  -- SmartOptions (Trendlyne) Greek-enriched option chain per stock per expiry
  CREATE TABLE IF NOT EXISTS so_option_chain (
    symbol        TEXT NOT NULL,
    date          TEXT NOT NULL,
    expiry        TEXT NOT NULL,
    strike        REAL NOT NULL,
    ce_price      REAL, ce_volume REAL, ce_oi REAL, ce_oi_chg_pct REAL,
    ce_iv         REAL, ce_iv_chg REAL,
    ce_delta      REAL, ce_gamma REAL, ce_theta REAL, ce_vega REAL, ce_rho REAL,
    ce_buildup    TEXT,
    pe_price      REAL, pe_volume REAL, pe_oi REAL, pe_oi_chg_pct REAL,
    pe_iv         REAL, pe_iv_chg REAL,
    pe_delta      REAL, pe_gamma REAL, pe_theta REAL, pe_vega REAL, pe_rho REAL,
    pe_buildup    TEXT,
    fetched_at    TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, date, expiry, strike)
  );
  CREATE INDEX IF NOT EXISTS idx_soc_sym_date ON so_option_chain(symbol, date DESC);

  -- SmartOptions stock-level OI summary (maxPain, ATM, MWPL, IV, PCR, futures)
  CREATE TABLE IF NOT EXISTS so_stock_oi_summary (
    symbol        TEXT NOT NULL,
    date          TEXT NOT NULL,
    expiry        TEXT NOT NULL,
    max_pain      REAL,
    atm           REAL,
    mwpl          REAL,
    iv_call       REAL,
    iv_put        REAL,
    pcr           REAL,
    fut_price     REAL,
    fut_oi        REAL,
    fut_oi_chg    REAL,
    fetched_at    TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, date, expiry)
  );

  -- NiftyTrader per-strike OI change (buildup/unwinding) for index options
  CREATE TABLE IF NOT EXISTS nt_index_change_oi (
    index_name           TEXT NOT NULL,
    date                 TEXT NOT NULL,
    expiry               TEXT NOT NULL,
    strike               REAL NOT NULL,
    snap_time            TEXT NOT NULL,
    index_close          REAL,
    calls_change_oi      REAL,
    calls_change_oi_val  REAL,
    puts_change_oi       REAL,
    puts_change_oi_val   REAL,
    fetched_at           TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (index_name, date, expiry, strike)
  );
  CREATE INDEX IF NOT EXISTS idx_nt_chg_oi ON nt_index_change_oi(index_name, date DESC);

  -- F&O expiry calendar per symbol (from NT symbol-expiry-all)
  CREATE TABLE IF NOT EXISTS nt_fno_expiry (
    symbol      TEXT NOT NULL,
    exchange    TEXT NOT NULL DEFAULT 'NSE',
    expiry      TEXT NOT NULL,
    lot_size    INTEGER,
    PRIMARY KEY (symbol, exchange, expiry)
  );
`);

db.exec(`
  -- Early Hours Prediction candidates flagged at market open / pre-open
  CREATE TABLE IF NOT EXISTS early_hours_predictions (
    symbol                 TEXT NOT NULL,
    date                   TEXT NOT NULL,
    score                  REAL NOT NULL,
    iep_gap_pct            REAL,
    preopen_imbalance      REAL,
    delivery_spike_pct     REAL,
    has_corporate_action   INTEGER DEFAULT 0,
    corporate_action_title TEXT,
    breakout_signals       TEXT, -- comma-separated tags e.g. "SMA20 Breakout,Bullish Trend"
    reasons_json           TEXT, -- details of triggers for UI tooltip
    computed_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, date)
  );
  CREATE INDEX IF NOT EXISTS idx_ehp_date ON early_hours_predictions(date DESC);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS trendlyne_checklist (
    symbol         TEXT PRIMARY KEY,
    score          REAL,
    total          INTEGER,
    yes_count      INTEGER,
    insight        TEXT,
    checklist_data TEXT,
    fetched_at     DATETIME
  );
`);

// This file is the SQLite dev-fallback schema-of-record — adding a column/table here
// does NOT reach live Postgres. USE_POSTGRES=true reads db/schema.postgres.sql for fresh
// installs, but existing Postgres databases only pick up new columns via pgClient.ts's
// pgEnsureColumns() ALTER list. Missing that step is exactly how technical_signals /
// tl_financial_quality went 24h+ without fcf_yield_approx on 2026-07-05 (ml_ensemble.py
// --score threw UndefinedColumn) while db.ts + schema.postgres.sql already had it.
// Whenever you add a column/table here that Postgres-backed code will read, add the
// matching entry to pgClient.ts's pgEnsureColumns() too.

// ── Migration: risk_metrics_engine + multi_factor_scorer columns ──────────────
// Adds Beta (1Y+6M), Sortino, VaR95, and 5 multi-factor component score columns
// to quant_scores. All computed by Python engines; TypeScript reads from same table.
// Note: SQLite does not support ADD COLUMN IF NOT EXISTS — runMigration guards
// idempotency by checking the _migrations table before executing.
runMigration('053_qs_beta_1y',            `ALTER TABLE quant_scores ADD COLUMN beta_1y            REAL`);
runMigration('053_qs_beta_6m',            `ALTER TABLE quant_scores ADD COLUMN beta_6m            REAL`);
runMigration('053_qs_sortino_ratio',      `ALTER TABLE quant_scores ADD COLUMN sortino_ratio      REAL`);
runMigration('053_qs_var_95',             `ALTER TABLE quant_scores ADD COLUMN var_95             REAL`);
runMigration('053_qs_mf_quality_score',   `ALTER TABLE quant_scores ADD COLUMN mf_quality_score   REAL`);
runMigration('053_qs_mf_momentum_score',  `ALTER TABLE quant_scores ADD COLUMN mf_momentum_score  REAL`);
runMigration('053_qs_mf_value_score',     `ALTER TABLE quant_scores ADD COLUMN mf_value_score     REAL`);
runMigration('053_qs_mf_risk_adj_score',  `ALTER TABLE quant_scores ADD COLUMN mf_risk_adj_score  REAL`);
runMigration('053_qs_mf_macro_score',     `ALTER TABLE quant_scores ADD COLUMN mf_macro_score     REAL`);
runMigration('053_qs_mf_composite_score', `ALTER TABLE quant_scores ADD COLUMN mf_composite_score REAL`);

// Keep startup diagnostics off stdout so stdio-based clients can parse JSON-RPC.
console.error('[DB] Schema normalization complete (Phase 3.5)');

export default db;

