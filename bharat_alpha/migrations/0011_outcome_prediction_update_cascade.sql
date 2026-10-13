-- Instrument identity merges update prediction.instrument_id from a duplicate rename id to
-- the surviving company id. Outcome is keyed by (model, date, instrument) and references that
-- prediction key, so it must follow the same identity update atomically. Without ON UPDATE
-- CASCADE, a legitimate NSE rename (ADANIGAS -> ATGL on the live 2026-10-13 ingest) aborts the
-- entire symbol-change connector as soon as the duplicate has a resolved outcome.
ALTER TABLE alpha.outcome
    DROP CONSTRAINT outcome_model_id_as_of_date_instrument_id_fkey;

ALTER TABLE alpha.outcome
    ADD CONSTRAINT outcome_model_id_as_of_date_instrument_id_fkey
    FOREIGN KEY (model_id, as_of_date, instrument_id)
    REFERENCES alpha.prediction(model_id, as_of_date, instrument_id)
    ON UPDATE CASCADE;
