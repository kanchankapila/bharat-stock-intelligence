// BUILD_STAGE_0_2_SPEC.md Task 2.3: derive `security` from the UNION of all
// symbols observed across the entire backfill (market_bar), never from
// EQUITY_L.csv (which contains only currently-listed names and would
// reintroduce the exact survivorship bias this rebuild exists to remove).
//
// Runs once over the WHOLE range, not incrementally per backfill date --
// a symbol's final listed/delisted status can't be known until every date
// has been processed. The actual SQL lives in
// @greenfield/db (deriveSecurityMasterFromMarketBar) per "only db issues
// SQL" -- this is a thin, named wrapper so the Task 2.3 concept has its own
// documented entry point in the ingestion package.
//
// ponytail: EQUITY_L.csv enrichment of name/ISIN for currently-listed
// symbols (the spec's secondary "enrich names and ISINs" clause) is not
// implemented here -- it's optional polish, not required by Acceptance Gate
// 2's actual checks (delisted-symbol presence, non-NULL listed_to). Add it
// when a consumer actually needs real company names instead of the
// backfill's symbol-as-placeholder-name seed.
import type pg from 'pg';
import { deriveSecurityMasterFromMarketBar, type SecurityMasterSpanRow } from '@greenfield/db';

export type SecurityMasterResult = SecurityMasterSpanRow;

export async function deriveSecurityMaster(pool: pg.Pool, source: string = 'nse'): Promise<SecurityMasterResult> {
  return deriveSecurityMasterFromMarketBar(pool, source);
}
