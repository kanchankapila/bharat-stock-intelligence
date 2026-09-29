-- NSE F&O ban list (securities in the ban period: OI above 95% of market-wide position limit).
-- fo_ban_day records every processed day, so "no securities in ban" is data, not a missing file.
CREATE TABLE IF NOT EXISTS alpha.fo_ban_day (
    trade_date      DATE PRIMARY KEY,
    n_banned        INT NOT NULL,
    source          TEXT NOT NULL,
    knowable_at     TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS alpha.fo_ban (
    trade_date      DATE NOT NULL REFERENCES alpha.fo_ban_day(trade_date),
    instrument_id   INT NOT NULL REFERENCES alpha.instrument(instrument_id),
    PRIMARY KEY (trade_date, instrument_id)
);
