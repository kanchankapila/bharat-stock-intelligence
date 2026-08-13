import pg from 'pg';

export * from './run-ledger.js';
export * from './nse-bhavcopy-repo.js';
export * from './stage3-repo.js';
export * from './legacy-repo.js';

// node-postgres returns BIGINT (OID 20) and NUMERIC/DECIMAL (OID 1700) as raw
// JS strings by default, to avoid silent precision loss on values beyond
// Number.MAX_SAFE_INTEGER. That's the right default for money, but every
// count/id column in this schema (rows_written, symbols_covered, ...) is a
// plain count that safely fits a JS number, and a caller doing `row_id.n + 1`
// on an unconverted string is a documented recurring bug in the predecessor
// system (see docs/pg_numeric_string_bug in the old repo's memory) --
// fixed once here at the driver boundary rather than at each call site.
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => Number(value));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value: string) => Number(value));

export function createPool(connectionString = process.env.DATABASE_URL): pg.Pool {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  return new pg.Pool({ connectionString });
}
