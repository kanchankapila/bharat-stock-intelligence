-- Per-stock option summary per (date, expiry), computed from the NSE F&O bhavcopy's STO rows.
CREATE TABLE IF NOT EXISTS alpha.option_daily (
    instrument_id   INT NOT NULL REFERENCES alpha.instrument(instrument_id),
    trade_date      DATE NOT NULL,
    expiry          DATE NOT NULL,
    forward         DOUBLE PRECISION NOT NULL,
    atm_iv          DOUBLE PRECISION,
    skew            DOUBLE PRECISION,
    call_oi         DOUBLE PRECISION,
    put_oi          DOUBLE PRECISION,
    call_vol        DOUBLE PRECISION,
    put_vol         DOUBLE PRECISION,
    n_traded        INT NOT NULL,
    source          TEXT NOT NULL,
    knowable_at     TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (instrument_id, trade_date, expiry)
);
CREATE INDEX IF NOT EXISTS option_daily_date ON alpha.option_daily (trade_date);
