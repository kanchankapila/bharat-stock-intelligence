-- Frozen, horizon-specific research predictions; not read by live scoring.
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS calibration_shadow (
    symbol TEXT NOT NULL,
    date DATE NOT NULL,
    horizon_days INTEGER NOT NULL,
    prob DOUBLE PRECISION NOT NULL,
    fit_max TEXT NOT NULL,
    fitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (symbol, date, horizon_days)
);
CREATE INDEX IF NOT EXISTS idx_calibration_shadow_fitted_at ON calibration_shadow(fitted_at);
