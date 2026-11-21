exports.up = pgm => {
  pgm.noTransaction();
  pgm.sql(`
    CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS screener_appearances_source_pk_idx
      ON public.screener_appearances (source, screener_id, symbol, appeared_date)
  `);
  pgm.sql("SET lock_timeout = '10s'");
  pgm.sql("SET statement_timeout = '15min'");
  pgm.sql(`
    DO $$
    DECLARE
      current_pk text[];
    BEGIN
      SELECT array_agg(a.attname::text ORDER BY key_column.ordinality)
        INTO current_pk
        FROM pg_constraint c
        CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_attribute a
          ON a.attrelid = c.conrelid
         AND a.attnum = key_column.attnum
       WHERE c.conrelid = 'public.screener_appearances'::regclass
         AND c.contype = 'p';

      IF current_pk = ARRAY['source', 'screener_id', 'symbol', 'appeared_date']::text[] THEN
        DROP INDEX IF EXISTS public.screener_appearances_source_pk_idx;
      ELSIF current_pk = ARRAY['screener_id', 'symbol', 'appeared_date']::text[] THEN
        ALTER TABLE public.screener_appearances
          DROP CONSTRAINT screener_appearances_pkey,
          ADD CONSTRAINT screener_appearances_pkey
            PRIMARY KEY USING INDEX screener_appearances_source_pk_idx;
      ELSE
        RAISE EXCEPTION 'Unexpected screener_appearances primary key: %', current_pk;
      END IF;
    END
    $$
  `);
  pgm.sql('RESET statement_timeout');
  pgm.sql('RESET lock_timeout');
};

exports.down = false;
