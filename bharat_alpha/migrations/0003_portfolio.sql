-- Portfolio construction: sized targets derived from the canonical recommendation table.
-- Rankings stay in alpha.recommendation; this is how much of each to hold, and why.

CREATE TABLE alpha.portfolio_run (
    run_id          BIGSERIAL PRIMARY KEY,
    as_of_date      DATE NOT NULL,
    horizon         INT NOT NULL,
    capital_inr     DOUBLE PRECISION NOT NULL,
    edge_status     TEXT NOT NULL,
    n_positions     INT NOT NULL,
    gross_exposure  DOUBLE PRECISION NOT NULL,   -- sum of weights (rest is cash)
    ex_ante_vol     DOUBLE PRECISION,            -- annualised, of the invested book
    ex_ante_beta    DOUBLE PRECISION,
    turnover        DOUBLE PRECISION,            -- one-way, vs the previous target
    est_cost_inr    DOUBLE PRECISION,
    binding         JSONB NOT NULL,              -- which constraints bound, for audit
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (as_of_date, horizon)
);

CREATE TABLE alpha.portfolio_target (
    run_id          BIGINT NOT NULL REFERENCES alpha.portfolio_run(run_id) ON DELETE CASCADE,
    instrument_id   INT NOT NULL REFERENCES alpha.instrument(instrument_id),
    weight          DOUBLE PRECISION NOT NULL CHECK (weight >= 0),
    value_inr       DOUBLE PRECISION NOT NULL,
    shares          DOUBLE PRECISION NOT NULL,   -- at the decision-date close; a sizing guide, not an order
    cap_reason      TEXT,                        -- the constraint that limited this name, if any
    PRIMARY KEY (run_id, instrument_id)
);
