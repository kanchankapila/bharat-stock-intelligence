// Stage 3 Class Q transfer: READ-ONLY queries against the existing live
// database. Every function here opens its own short-lived pg.Pool against
// `connectionString` and closes it before returning -- never touches
// greenfield's own pool, never writes. "Only db issues SQL" applies here
// too, which is why these live in @greenfield/db rather than inline in an
// ingestion script (raw `pg` imports are eslint-banned outside this package).
import pg from 'pg';

// `params` is optional (every function here predates it, and fetches
// unconditionally with no WHERE input) -- added for
// queryLegacyUnifiedRecommendationsForSession's `computed_at` filter, which
// must be parameterized, not string-interpolated, the same discipline this
// package already applies to greenfield's own pool everywhere else.
async function queryOldDb<T extends pg.QueryResultRow>(connectionString: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const pool = new pg.Pool({ connectionString });
  try {
    const { rows } = await pool.query<T>(sql, params);
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

export interface LegacyUnifiedRecommendationRow {
  symbol: string;
  unified_score: number | null;
  classification: string | null;
  conviction_level: string | null;
}

/** Task 5.3 (BUILD_STAGE_5_SPEC.md): the old system's live ranker, read-only,
 * for one `computed_at` trading date -- column names confirmed against the
 * real live-Postgres migrations (`migrations/1786800000000_unified-
 * recommendations-generated-at.sql`: `generated_at TIMESTAMPTZ`, joined with
 * `computed_at`), not guessed from the SQLite schema-of-record alone
 * (`db.ts` is dev-fallback only, per this repo's own `recurring-bugs.md`).
 *
 * Restricted to `generated_at < (computed_at date + '03:45:00')` -- the same
 * pre-market cutoff `measurement.md`'s own grading methodology uses -- so a
 * same-day POST-close re-run (which silently overwrote the earlier pre-market
 * ranking under the old system's bare-DATE key before
 * `unified_recommendations_history` existed) can never be compared against as
 * if it were the old system's morning call. `unified_recommendations` itself
 * is NOT append-only (unlike the new `recommendation` table), so this is a
 * best-effort filter on whatever the live row's `generated_at` currently
 * says, not a guarantee -- Task 5.3's comparison is explicitly descriptive
 * only, never a promotion criterion, precisely because of gaps like this one
 * in the old system's own provenance. */
// --- Phase 2 legacy sources ---

export interface LegacyMcAnalystRatingRow {
  symbol: string;
  final_rating: string | null;
  analyst_count: number | null;
  buy_count: number | null;
  outperform_count: number | null;
  hold_count: number | null;
  underperform_count: number | null;
  sell_count: number | null;
  fetched_at: string;
}

export async function queryLegacyMcAnalystRatings(connectionString: string): Promise<LegacyMcAnalystRatingRow[]> {
  return queryOldDb<LegacyMcAnalystRatingRow>(
    connectionString,
    `SELECT symbol, final_rating, analyst_count, buy_count, outperform_count, hold_count,
            underperform_count, sell_count, fetched_at
     FROM mc_analyst_ratings ORDER BY fetched_at`,
  );
}

export interface LegacyMcPriceForecastRow {
  symbol: string;
  high: number | null;
  mean: number | null;
  low: number | null;
  fetched_at: string;
}

export async function queryLegacyMcPriceForecast(connectionString: string): Promise<LegacyMcPriceForecastRow[]> {
  return queryOldDb<LegacyMcPriceForecastRow>(
    connectionString,
    `SELECT symbol, high, mean, low, fetched_at FROM mc_price_forecast ORDER BY fetched_at`,
  );
}

export interface LegacyInsiderTradeRow {
  id: number;
  symbol: string;
  acquirer_name: string;
  category: string;
  type_of_transaction: string;
  quantity: number;
  value_inr: number;
  date_iso: string;
}

/** Only rows with a valid date_iso (the 2026-07-30 fix backfilled most; a
 * small residual without a parseable date is deliberately excluded rather
 * than guessed from the raw `date` text column). */
export async function queryLegacyInsiderTrades(connectionString: string): Promise<LegacyInsiderTradeRow[]> {
  return queryOldDb<LegacyInsiderTradeRow>(
    connectionString,
    `SELECT id, symbol, "acquirerName" AS acquirer_name, category,
            "typeOfTransaction" AS type_of_transaction, quantity, "valueInr" AS value_inr, date_iso
     FROM insider_trades
     WHERE date_iso IS NOT NULL AND date_iso ~ '^\\d{4}-\\d{2}-\\d{2}'
     ORDER BY date_iso`,
  );
}

export async function queryLegacyUnifiedRecommendationsForSession(
  connectionString: string, computedAt: string,
): Promise<LegacyUnifiedRecommendationRow[]> {
  return queryOldDb<LegacyUnifiedRecommendationRow>(
    connectionString,
    `SELECT symbol, unified_score, classification, conviction_level
     FROM unified_recommendations
     WHERE computed_at = $1
       AND (generated_at IS NULL OR generated_at < ($1::date + interval '3 hours 45 minutes'))`,
    [computedAt],
  );
}
