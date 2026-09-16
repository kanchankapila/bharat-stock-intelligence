-- Up Migration
-- Stage 5 (BUILD_STAGE_5_SPEC.md Task 5.1.2): the `recommendation` table,
-- DDL taken verbatim from GREENFIELD_BUILD_SPEC.md C6 rather than re-derived
-- here -- C6 is the canonical contract and this is its first materialisation.
--
-- Append-only is the whole point of the (symbol, generated_at, ranker_version)
-- key: the predecessor's `unified_recommendations` was keyed (symbol,
-- computed_at) on a bare DATE, so every re-run silently overwrote that day's
-- earlier ranking and left exactly ONE provably pre-market date on the entire
-- table (.claude/rules/measurement.md, "the canonical ranker is not gradeable
-- yet"). Keying on the full timestamptz means a re-run adds a row instead of
-- destroying the one that would have been graded.
--
-- CHECK (facts_cutoff <= generated_at) is the schema-level half of Task 5.1.2's
-- provenance discipline; the writer additionally pins facts_cutoff to the
-- source feature_snapshot row's own value, which this constraint cannot see.
CREATE TABLE recommendation (
  symbol          text NOT NULL REFERENCES security(symbol),
  as_of_session   date NOT NULL,
  ranker_version  text NOT NULL,
  generated_at    timestamptz NOT NULL,
  facts_cutoff    timestamptz NOT NULL,
  score           double precision,
  rank            integer,
  classification  text NOT NULL,
  conviction      text,
  engine_coverage integer NOT NULL,
  breakdown       jsonb NOT NULL DEFAULT '{}'::jsonb,
  veto_reasons    text[] NOT NULL DEFAULT '{}',
  is_publishable  boolean NOT NULL DEFAULT false,
  run_id          uuid NOT NULL REFERENCES ingestion_run(run_id),
  PRIMARY KEY (symbol, generated_at, ranker_version),
  CHECK (facts_cutoff <= generated_at)
);
CREATE INDEX recommendation_session_idx ON recommendation (as_of_session, ranker_version, rank);

-- Task 5.4's promotion gate and Task 5.6's `promotion-not-premature` check both
-- ask "does any publishable row exist yet". Without this the question is a
-- sequential scan over every shadow row ever appended, and it is asked on every
-- gate run -- same leftmost-prefix reasoning as migration 009.
CREATE INDEX recommendation_publishable_idx ON recommendation (as_of_session)
  WHERE is_publishable = true;

-- A NaN score sorts HIGHEST in Postgres (it defines NaN = NaN as TRUE for total
-- btree ordering), so a single NaN-poisoned score would silently take rank #1 in
-- any ORDER BY score DESC read -- a documented recurring bug class on the
-- predecessor (.claude/rules/recurring-bugs.md, "NaN & null"). The ranker
-- already skips non-finite values; this makes the invariant unfalsifiable at the
-- storage layer instead of relying on the writer alone. NULL stays legal: it
-- means "not scored", which is a real and different state from "scored NaN".
ALTER TABLE recommendation
  ADD CONSTRAINT recommendation_score_finite
  CHECK (score IS NULL OR (score > '-Infinity'::float8 AND score < 'Infinity'::float8));

-- Down Migration
DROP TABLE IF EXISTS recommendation;
