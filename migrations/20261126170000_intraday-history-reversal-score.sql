-- Record the intraday reversal component (0.40 of the blend) in history, so blend-weight changes can be
-- replayed on stored inputs. History only, never read by the blend. A nullable ADD COLUMN is catalog-only.
SET LOCAL lock_timeout = '5s';
ALTER TABLE intraday_recommendations_history ADD COLUMN IF NOT EXISTS reversal_score double precision;
