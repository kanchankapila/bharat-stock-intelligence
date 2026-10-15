-- AF-20261014-11: use the decision ontology's canonical terminal status `invalid` for an
-- outcome that cannot be graded (for example, a suspect OHLCV bar). `excluded` was an
-- unregistered synonym and made downstream status handling incomplete.
--
-- market_decision_outcome is a plain Postgres table, not a TimescaleDB hypertable. Normalize
-- legacy rows before installing the closed status vocabulary. The constraint operations are
-- named/idempotent so a database whose schema was regenerated or repaired manually converges.

UPDATE market_decision_outcome
SET outcome_status = 'invalid'
WHERE outcome_status = 'excluded';

ALTER TABLE market_decision_outcome
  DROP CONSTRAINT IF EXISTS market_decision_outcome_outcome_status_check;

ALTER TABLE market_decision_outcome
  ADD CONSTRAINT market_decision_outcome_outcome_status_check
  CHECK (outcome_status IN ('pending', 'resolved', 'invalid'));
