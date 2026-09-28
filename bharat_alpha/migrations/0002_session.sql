-- Next-session (open -> close) module: pre-open snapshots, picks, and their grades.

-- NSE pre-open call auction (09:00-09:08 IST). Forward-collected only: NSE publishes no history.
CREATE TABLE alpha.preopen_snapshot (
    source          TEXT NOT NULL,
    instrument_id   INT NOT NULL REFERENCES alpha.instrument(instrument_id),
    trade_date      DATE NOT NULL,              -- the session whose open this auction sets
    iep             DOUBLE PRECISION,           -- indicative equilibrium price
    prev_close      DOUBLE PRECISION,
    iep_gap         DOUBLE PRECISION,           -- iep / prev_close - 1 (fraction, not %)
    buy_qty         DOUBLE PRECISION,
    sell_qty        DOUBLE PRECISION,
    imbalance       DOUBLE PRECISION,           -- (buy - sell) / (buy + sell)
    auction_qty     DOUBLE PRECISION,
    knowable_at     TIMESTAMPTZ NOT NULL,       -- when WE saw it (not the auction's own time)
    PRIMARY KEY (source, instrument_id, trade_date)
);
CREATE INDEX preopen_snapshot_date ON alpha.preopen_snapshot(trade_date);

-- Picks for session `trade_date`, decided at the close of `as_of_date` (the previous session).
-- Append-only like alpha.prediction.
CREATE TABLE alpha.session_pick (
    strategy        TEXT NOT NULL,              -- 'capitulation_rule' | model_id
    as_of_date      DATE NOT NULL,
    trade_date      DATE NOT NULL,
    instrument_id   INT NOT NULL REFERENCES alpha.instrument(instrument_id),
    score           DOUBLE PRECISION NOT NULL,
    rank            INT NOT NULL,
    capacity_inr    DOUBLE PRECISION,           -- max_participation x ADT: honest size ceiling
    edge_status     TEXT NOT NULL CHECK (edge_status IN ('validated','unvalidated','degraded')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (strategy, trade_date, instrument_id)
);

CREATE TABLE alpha.session_outcome (
    strategy        TEXT NOT NULL,
    trade_date      DATE NOT NULL,
    instrument_id   INT NOT NULL,
    oc_return       DOUBLE PRECISION,           -- NULL if it did not trade that session
    universe_oc     DOUBLE PRECISION NOT NULL,  -- equal-weight tradeable universe, same session
    net_excess      DOUBLE PRECISION,           -- oc_return - round-trip cost - universe_oc
    resolved_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (strategy, trade_date, instrument_id),
    FOREIGN KEY (strategy, trade_date, instrument_id)
        REFERENCES alpha.session_pick(strategy, trade_date, instrument_id)
);
