-- Promotion evidence must not mix candidates produced by incompatible learner versions.
SET lock_timeout = '10s';

ALTER TABLE high_flyer_candidates
  ADD COLUMN IF NOT EXISTS method_version TEXT NOT NULL DEFAULT 'legacy';
