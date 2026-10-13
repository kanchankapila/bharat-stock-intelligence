-- Same identity-merge rule as 0011 for the next-session engine. A symbol rename updates
-- session_pick.instrument_id; its resolved session_outcome must follow the composite key.
-- Live 2026-10-13: fixing prediction/outcome exposed this second missing cascade on a later
-- renamed instrument, so both parent/grade pairs now have identical referential semantics.
ALTER TABLE alpha.session_outcome
    DROP CONSTRAINT session_outcome_strategy_trade_date_instrument_id_fkey;

ALTER TABLE alpha.session_outcome
    ADD CONSTRAINT session_outcome_strategy_trade_date_instrument_id_fkey
    FOREIGN KEY (strategy, trade_date, instrument_id)
    REFERENCES alpha.session_pick(strategy, trade_date, instrument_id)
    ON UPDATE CASCADE;
