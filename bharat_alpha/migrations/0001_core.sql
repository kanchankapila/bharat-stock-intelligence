-- bharat_alpha core schema. Everything lives in schema `alpha` and every query in the code
-- qualifies it, so this can share a Postgres instance with the legacy app without any
-- unqualified name resolving to the wrong table.
--
-- Conventions (each one closes a bug class the legacy codebase hit repeatedly):
--   * NULL means "unknown". No 0.0 sentinels for missing values.
--   * Every externally sourced fact carries `source` in its primary key when more than one
--     provider could produce a row for the same natural key.
--   * Every externally sourced fact carries `knowable_at` — the earliest instant the value
--     could have been used for a decision. Feature builders filter on it; nothing else.
--   * Generation timestamps are never in an ON CONFLICT DO UPDATE SET list.
--   * Predictions are append-only. Grading writes to a separate table.

CREATE SCHEMA IF NOT EXISTS alpha;

-- ─── reference ──────────────────────────────────────────────────────────────
CREATE TABLE alpha.instrument (
    instrument_id   SERIAL PRIMARY KEY,
    isin            TEXT UNIQUE,
    name            TEXT,
    first_seen      DATE NOT NULL,
    last_seen       DATE NOT NULL,
    sector          TEXT,
    industry        TEXT
);

-- A symbol is a *label* with a validity range, not an identity. NSE renames happen
-- (symbolchange.csv); an instrument keeps its history across them.
CREATE TABLE alpha.symbol_history (
    instrument_id   INT NOT NULL REFERENCES alpha.instrument(instrument_id),
    symbol          TEXT NOT NULL,
    valid_from      DATE NOT NULL,
    valid_to        DATE,                       -- NULL = current
    PRIMARY KEY (symbol, valid_from)
);
CREATE INDEX symbol_history_instr ON alpha.symbol_history(instrument_id);

-- Provider ids are resolved explicitly and stored, never constructed by convention.
CREATE TABLE alpha.provider_id (
    provider        TEXT NOT NULL,
    provider_key    TEXT NOT NULL,
    instrument_id   INT NOT NULL REFERENCES alpha.instrument(instrument_id),
    resolved_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolution      TEXT NOT NULL,              -- 'isin' | 'autocomplete' | 'manual'
    PRIMARY KEY (provider, provider_key)
);
CREATE UNIQUE INDEX provider_id_instr ON alpha.provider_id(provider, instrument_id);

-- The exchange's own record of which days traded (a day exists iff a bhavcopy exists).
CREATE TABLE alpha.trading_day (
    trade_date      DATE PRIMARY KEY,
    n_instruments   INT NOT NULL
);

-- ─── market data ────────────────────────────────────────────────────────────
-- Raw, UNADJUSTED exchange bars. prev_close is NSE's own adjusted previous close, which is
-- what lets corporate-action factors be derived from the exchange's data alone.
CREATE TABLE alpha.daily_bar (
    instrument_id   INT NOT NULL REFERENCES alpha.instrument(instrument_id),
    trade_date      DATE NOT NULL,
    series          TEXT NOT NULL,
    open            DOUBLE PRECISION,
    high            DOUBLE PRECISION,
    low             DOUBLE PRECISION,
    close           DOUBLE PRECISION,
    last            DOUBLE PRECISION,
    prev_close      DOUBLE PRECISION,
    vwap            DOUBLE PRECISION,
    volume          DOUBLE PRECISION,
    turnover_inr    DOUBLE PRECISION,
    trades          DOUBLE PRECISION,
    deliv_qty       DOUBLE PRECISION,
    deliv_pct       DOUBLE PRECISION,
    source          TEXT NOT NULL,
    knowable_at     TIMESTAMPTZ NOT NULL,
    is_suspect      BOOLEAN NOT NULL DEFAULT FALSE,
    suspect_reason  TEXT,
    PRIMARY KEY (instrument_id, trade_date)
);
CREATE INDEX daily_bar_date ON alpha.daily_bar(trade_date);

-- Derived from prev_close_d / close_{d-1}. factor < 1 means earlier prices must be
-- multiplied by it (e.g. a 1:2 split yields 0.5).
CREATE TABLE alpha.adjustment (
    instrument_id   INT NOT NULL REFERENCES alpha.instrument(instrument_id),
    ex_date         DATE NOT NULL,
    factor          DOUBLE PRECISION NOT NULL CHECK (factor > 0),
    source          TEXT NOT NULL,
    PRIMARY KEY (instrument_id, ex_date)
);

CREATE TABLE alpha.fo_daily (
    instrument_id   INT NOT NULL REFERENCES alpha.instrument(instrument_id),
    trade_date      DATE NOT NULL,
    expiry          DATE NOT NULL,
    close           DOUBLE PRECISION,
    settle          DOUBLE PRECISION,
    underlying      DOUBLE PRECISION,
    open_interest   DOUBLE PRECISION,
    chg_oi          DOUBLE PRECISION,
    volume          DOUBLE PRECISION,
    source          TEXT NOT NULL,
    knowable_at     TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (instrument_id, trade_date, expiry)
);

CREATE TABLE alpha.index_daily (
    index_name      TEXT NOT NULL,
    trade_date      DATE NOT NULL,
    open            DOUBLE PRECISION,
    high            DOUBLE PRECISION,
    low             DOUBLE PRECISION,
    close           DOUBLE PRECISION,
    pe              DOUBLE PRECISION,
    pb              DOUBLE PRECISION,
    div_yield       DOUBLE PRECISION,
    source          TEXT NOT NULL,
    knowable_at     TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (index_name, trade_date)
);

CREATE TABLE alpha.market_flow (
    source          TEXT NOT NULL,
    trade_date      DATE NOT NULL,
    category        TEXT NOT NULL,              -- 'FII' | 'DII'
    buy_cr          DOUBLE PRECISION,
    sell_cr         DOUBLE PRECISION,
    net_cr          DOUBLE PRECISION,
    knowable_at     TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (source, trade_date, category)
);

CREATE TABLE alpha.corporate_event (
    source          TEXT NOT NULL,
    instrument_id   INT NOT NULL REFERENCES alpha.instrument(instrument_id),
    event_type      TEXT NOT NULL,              -- 'results' | 'dividend' | 'split' | 'bonus' | ...
    event_date      DATE NOT NULL,
    knowable_at     TIMESTAMPTZ NOT NULL,
    detail          JSONB,
    PRIMARY KEY (source, instrument_id, event_type, event_date)
);

CREATE TABLE alpha.deal (
    source          TEXT NOT NULL,
    deal_id         TEXT NOT NULL,              -- sha1 of the vendor row; vendors issue no id
    trade_date      DATE NOT NULL,
    instrument_id   INT NOT NULL REFERENCES alpha.instrument(instrument_id),
    deal_type       TEXT NOT NULL,              -- 'bulk' | 'block' | 'insider'
    side            TEXT NOT NULL,              -- 'BUY' | 'SELL'
    quantity        DOUBLE PRECISION,
    price           DOUBLE PRECISION,
    party           TEXT,
    knowable_at     TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (source, deal_id)
);
CREATE INDEX deal_instr_date ON alpha.deal(instrument_id, trade_date);

-- Long format so per-FIELD fill rates are one GROUP BY away. (Legacy: a vendor stopped
-- sending ROE, coverage fell 86% -> 6% over 7 weeks while the table stayed "fresh".)
CREATE TABLE alpha.fundamental (
    source          TEXT NOT NULL,
    instrument_id   INT NOT NULL REFERENCES alpha.instrument(instrument_id),
    field           TEXT NOT NULL,
    period_end      DATE,
    value           DOUBLE PRECISION,
    knowable_at     TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (source, instrument_id, field, knowable_at)
);

-- ─── ops ────────────────────────────────────────────────────────────────────
-- 'empty' and 'partial' are first-class: "exit 0 and wrote nothing" is not success.
CREATE TABLE alpha.ingest_run (
    run_id          BIGSERIAL PRIMARY KEY,
    source          TEXT NOT NULL,
    target_date     DATE,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ,
    status          TEXT NOT NULL CHECK (status IN ('running','success','empty','partial','failed','not_published')),
    rows_written    INT,
    detail          TEXT
);
CREATE INDEX ingest_run_source ON alpha.ingest_run(source, target_date);

CREATE TABLE alpha.job_run (
    run_id          BIGSERIAL PRIMARY KEY,
    job             TEXT NOT NULL,
    as_of_date      DATE,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ,
    status          TEXT NOT NULL CHECK (status IN ('running','success','skipped','failed')),
    detail          JSONB
);
CREATE INDEX job_run_job ON alpha.job_run(job, as_of_date);

CREATE TABLE alpha.dq_result (
    check_id        TEXT NOT NULL,
    run_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    status          TEXT NOT NULL CHECK (status IN ('pass','warn','fail','error')),
    value           DOUBLE PRECISION,
    detail          TEXT,
    PRIMARY KEY (check_id, run_at)
);

CREATE TABLE alpha.system_status (
    key             TEXT PRIMARY KEY,
    value           JSONB NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── models & the learning loop ─────────────────────────────────────────────
CREATE TABLE alpha.model (
    model_id        TEXT PRIMARY KEY,
    horizon         INT NOT NULL,
    feature_set     TEXT NOT NULL,
    label           TEXT NOT NULL,
    params          JSONB NOT NULL,
    trained_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    train_start     DATE NOT NULL,
    train_end       DATE NOT NULL,
    cv_report       JSONB NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('candidate','champion','retired','rejected')),
    gate_report     JSONB,
    promoted_at     TIMESTAMPTZ,
    artifact_path   TEXT NOT NULL
);
CREATE UNIQUE INDEX one_champion_per_horizon ON alpha.model(horizon) WHERE status = 'champion';

-- Append-only. Written once at decision time; never updated.
CREATE TABLE alpha.prediction (
    model_id        TEXT NOT NULL REFERENCES alpha.model(model_id),
    as_of_date      DATE NOT NULL,
    instrument_id   INT NOT NULL REFERENCES alpha.instrument(instrument_id),
    horizon         INT NOT NULL,
    score           DOUBLE PRECISION NOT NULL,
    rank_pct        DOUBLE PRECISION NOT NULL,
    pred_excess     DOUBLE PRECISION,
    prob_outperform DOUBLE PRECISION,
    interval_lo     DOUBLE PRECISION,
    interval_hi     DOUBLE PRECISION,
    member_scores   JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (model_id, as_of_date, instrument_id)
);
CREATE INDEX prediction_date ON alpha.prediction(as_of_date);

CREATE TABLE alpha.outcome (
    model_id        TEXT NOT NULL,
    as_of_date      DATE NOT NULL,
    instrument_id   INT NOT NULL,
    horizon         INT NOT NULL,
    entry_date      DATE NOT NULL,
    exit_date       DATE NOT NULL,
    fwd_return      DOUBLE PRECISION NOT NULL,
    universe_mean   DOUBLE PRECISION NOT NULL,
    universe_median DOUBLE PRECISION NOT NULL,
    excess_mean     DOUBLE PRECISION NOT NULL,
    exit_reason     TEXT NOT NULL CHECK (exit_reason IN ('horizon','stopped_trading')),
    resolved_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (model_id, as_of_date, instrument_id),
    FOREIGN KEY (model_id, as_of_date, instrument_id)
        REFERENCES alpha.prediction(model_id, as_of_date, instrument_id)
);

-- Per decision-date realized grade of a model (one row per date once resolved).
CREATE TABLE alpha.realized_eval (
    model_id        TEXT NOT NULL,
    as_of_date      DATE NOT NULL,
    member          TEXT NOT NULL,              -- 'ensemble' or a member name
    n               INT NOT NULL,
    rank_ic         DOUBLE PRECISION,
    topk_excess     DOUBLE PRECISION,
    interval_cover  DOUBLE PRECISION,
    PRIMARY KEY (model_id, as_of_date, member)
);

CREATE TABLE alpha.ensemble_weight (
    model_id        TEXT NOT NULL,
    as_of_date      DATE NOT NULL,
    weights         JSONB NOT NULL,
    PRIMARY KEY (model_id, as_of_date)
);

CREATE TABLE alpha.conformal_state (
    model_id        TEXT NOT NULL,
    as_of_date      DATE NOT NULL,
    alpha_t         DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (model_id, as_of_date)
);

-- THE canonical output. One writer (pipeline.publish). Nothing else produces a "final" score.
CREATE TABLE alpha.recommendation (
    as_of_date      DATE NOT NULL,
    horizon         INT NOT NULL,
    instrument_id   INT NOT NULL REFERENCES alpha.instrument(instrument_id),
    model_id        TEXT NOT NULL,
    rank            INT NOT NULL,
    action          TEXT NOT NULL CHECK (action IN ('BUY','HOLD','AVOID')),
    score           DOUBLE PRECISION NOT NULL,
    pred_excess     DOUBLE PRECISION,
    prob_outperform DOUBLE PRECISION,
    interval_lo     DOUBLE PRECISION,
    interval_hi     DOUBLE PRECISION,
    edge_status     TEXT NOT NULL CHECK (edge_status IN ('validated','unvalidated','degraded')),
    PRIMARY KEY (as_of_date, horizon, instrument_id)
);
