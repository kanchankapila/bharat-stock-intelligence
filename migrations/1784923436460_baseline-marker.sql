-- Up Migration
--
-- Intentional no-op. This marks the point node-pg-migrate was adopted (2026-07-24).
-- Schema before this point (~126 tables) is managed by src/server/pgClient.ts's
-- pgEnsureColumns() self-heal-on-boot mechanism and the hand-maintained db/schema.postgres.sql
-- (generated from src/server/db.ts, applied manually via `psql -f db/schema.postgres.sql` --
-- see scripts/generate_pg_schema.py). Reverse-engineering all existing tables into migration
-- files is a separate, larger effort and not required to start using real migrations going
-- forward. Every schema change from this point on should be a new node-pg-migrate migration
-- (`npm run migrate:create -- <name>`), not a new pgEnsureColumns() entry.
SELECT 1;

-- Down Migration
SELECT 1;