-- Facts imported from the legacy platform's tables through the ontology-generated map
-- (config/legacy_feature_map.yaml). Long format, point-in-time, change-only — same contract as
-- alpha.fundamental, kept separate so provenance ('legacy:<table>') is never confused with a
-- first-party connector.
CREATE TABLE alpha.external_fact (
    source          TEXT NOT NULL,              -- 'legacy:<table>'
    instrument_id   INT NOT NULL REFERENCES alpha.instrument(instrument_id),
    field           TEXT NOT NULL,              -- '<column>'
    value           DOUBLE PRECISION,
    observed_date   DATE NOT NULL,              -- the row's own date in the legacy table
    knowable_at     TIMESTAMPTZ NOT NULL,       -- when the value could first have been used
    PRIMARY KEY (source, instrument_id, field, knowable_at)
);
CREATE INDEX external_fact_field ON alpha.external_fact(source, field);

-- Per-field admission verdicts from the evidence screen (computed on data before a cutoff).
CREATE TABLE alpha.external_screen (
    source          TEXT NOT NULL,
    field           TEXT NOT NULL,
    cutoff          DATE NOT NULL,
    horizon         INT NOT NULL,
    n_dates         INT,
    eff_dates       DOUBLE PRECISION,
    coverage        DOUBLE PRECISION,
    mean_ic         DOUBLE PRECISION,
    t_nw            DOUBLE PRECISION,
    admitted        BOOLEAN NOT NULL,
    reason          TEXT NOT NULL,
    screened_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (source, field, cutoff, horizon)
);
