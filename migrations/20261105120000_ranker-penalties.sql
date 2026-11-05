-- AF-20261008-25 / AF-20261030-05: what each penalty did to a row was not persisted, so the risk veto
-- could not be graded retroactively. Rows before this column stay NULL rather than being reconstructed.
SET LOCAL lock_timeout = '5s';
ALTER TABLE unified_recommendations_history ADD COLUMN IF NOT EXISTS penalties JSONB;
