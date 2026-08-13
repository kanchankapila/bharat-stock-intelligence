// Stage 3 Class Q transfer: READ-ONLY queries against the existing live
// database. Every function here opens its own short-lived pg.Pool against
// `connectionString` and closes it before returning -- never touches
// greenfield's own pool, never writes. "Only db issues SQL" applies here
// too, which is why these live in @greenfield/db rather than inline in an
// ingestion script (raw `pg` imports are eslint-banned outside this package).
import pg from 'pg';

async function queryOldDb<T extends pg.QueryResultRow>(connectionString: string, sql: string): Promise<T[]> {
  const pool = new pg.Pool({ connectionString });
  try {
    const { rows } = await pool.query<T>(sql);
    return rows;
  } finally {
    await pool.end();
  }
}

export interface LegacyCorporateActionRow {
  symbol: string | null;
  ex_date: string | null;
  action_type: string | null;
  ratio: number | null;
  amount: number | null;
  source: string | null;
  ingested_at: string | null;
}

export async function queryLegacyCorporateActions(connectionString: string): Promise<LegacyCorporateActionRow[]> {
  return queryOldDb<LegacyCorporateActionRow>(
    connectionString,
    `SELECT symbol, ex_date, action_type, ratio, amount, source, ingested_at FROM corporate_actions`,
  );
}

export interface LegacyFiiDiiFlowRow {
  date: string | null;
  fii_net: number | null;
  dii_net: number | null;
  source: string | null;
}

export async function queryLegacyFiiDiiFlow(connectionString: string): Promise<LegacyFiiDiiFlowRow[]> {
  return queryOldDb<LegacyFiiDiiFlowRow>(
    connectionString,
    `SELECT date, fii_net, dii_net, source FROM fii_dii_flow`,
  );
}

export interface LegacyTrendlyneScreenerIdSummary {
  screener_id: string;
  row_count: number;
  sample_symbol: string | null;
}

/** Trendlyne rows only, AGGREGATED by screener_id -- `screener_id` here is a
 * human-readable slug (`'1h-adx-bearish-divergence'`), never the numeric
 * `screenpk` the new schema's identity model requires. See Task 3.3: there
 * is no reliable slug-to-screenpk mapping, so every row under a given slug
 * meets the identical fate (rejected, reason recorded). Aggregating by
 * distinct slug -- rather than pulling all ~450K individual rows into
 * memory and writing one transfer_reject row each -- keeps the accounting
 * exact (row_count sums to the true rejected total) without writing
 * hundreds of thousands of duplicate-reason rows for zero informational
 * gain. */
export async function queryLegacyTrendlyneScreenerIdSummary(connectionString: string): Promise<LegacyTrendlyneScreenerIdSummary[]> {
  return queryOldDb<LegacyTrendlyneScreenerIdSummary>(
    connectionString,
    `SELECT screener_id, count(*)::int AS row_count, min(symbol) AS sample_symbol
     FROM screener_appearances WHERE source = 'trendlyne' AND screener_id IS NOT NULL
     GROUP BY screener_id`,
  );
}

export interface LegacyScreenerMasterRow {
  scan_id: string | null;
  name: string | null;
  source: string | null;
}

/** MoneyControl + ETnow only -- their `scan_id` is a real opaque provider id
 * (unlike Trendlyne's slug), but the two providers issue overlapping integer
 * ranges (confirmed collisions -- data-sources.md composite-key rule), which
 * is exactly why screener_definition's PK is (provider, provider_id, version)
 * and never a bare scan_id. */
export async function queryLegacyScreenerMasterMcEtnow(connectionString: string): Promise<LegacyScreenerMasterRow[]> {
  return queryOldDb<LegacyScreenerMasterRow>(
    connectionString,
    `SELECT scan_id, name, source FROM screener_master WHERE source IN ('MoneyControl', 'ETnow')`,
  );
}
