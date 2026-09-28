-- NSE participant-wise F&O open interest (contracts), one row per (date, participant, instrument).
CREATE TABLE IF NOT EXISTS alpha.participant_oi (
    trade_date      DATE NOT NULL,
    participant     TEXT NOT NULL,              -- 'CLIENT' | 'DII' | 'FII' | 'PRO'
    instrument      TEXT NOT NULL,              -- 'fut_idx' | 'fut_stk' | 'opt_idx_call' | 'opt_idx_put' | 'opt_stk_call' | 'opt_stk_put'
    long_oi         DOUBLE PRECISION,
    short_oi        DOUBLE PRECISION,
    source          TEXT NOT NULL,
    knowable_at     TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (trade_date, participant, instrument)
);
