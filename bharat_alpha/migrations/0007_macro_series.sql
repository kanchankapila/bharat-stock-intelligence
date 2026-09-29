-- Global daily series (FRED): one row per (series, observation date on the source's calendar).
CREATE TABLE IF NOT EXISTS alpha.macro_series (
    series          TEXT NOT NULL,
    obs_date        DATE NOT NULL,
    value           DOUBLE PRECISION NOT NULL,
    source          TEXT NOT NULL,
    knowable_at     TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (series, obs_date)
);
