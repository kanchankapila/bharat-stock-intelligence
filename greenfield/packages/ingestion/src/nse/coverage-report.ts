// Task 2.5. "This script must issue real queries. A script that formats
// numbers without connecting to the database is prohibited" -- every field
// below comes from a real query in @greenfield/db (per "only db issues SQL"),
// never a literal. This module only shapes and formats what the repo returns.
import type pg from 'pg';
import { queryPerSymbolSessionSpan, queryPerYearCoverage, queryRejectedByReason, querySecurityStatusCounts } from '@greenfield/db';

export interface YearlyStat {
  year: number;
  distinctSessions: number;
  distinctSymbols: number;
}

export interface PerSymbolSessionCounts {
  min: number;
  median: number;
  max: number;
}

export interface CoverageReport {
  perYear: YearlyStat[];
  /** OVERALL (not per-year) per-symbol distinct-session span -- this is the
   * "dense span, not min(date)/max(date)" measurement measurement.md warns
   * about: a table can report years of calendar span while holding four
   * rows per symbol, and this stat is the one that catches that. */
  perSymbolSessionCounts: PerSymbolSessionCounts;
  rejectedByReason: Record<string, number>;
  delistedSymbolCount: number;
  listedSymbolCount: number;
}

export async function buildCoverageReport(
  pool: pg.Pool,
  scope: { source?: string; jobId?: string } = {},
): Promise<CoverageReport> {
  const source = scope.source ?? 'nse';
  const jobId = scope.jobId ?? 'nse.bhavcopy';
  const [perYear, perSymbolSessionCounts, rejectedByReason, statusCounts] = await Promise.all([
    queryPerYearCoverage(pool, source),
    queryPerSymbolSessionSpan(pool, source),
    queryRejectedByReason(pool, jobId),
    querySecurityStatusCounts(pool, source),
  ]);

  return {
    perYear,
    perSymbolSessionCounts,
    rejectedByReason,
    delistedSymbolCount: statusCounts.delisted,
    listedSymbolCount: statusCounts.listed,
  };
}

export function formatCoverageReport(report: CoverageReport): string {
  const lines: string[] = [];
  lines.push('=== NSE Bhavcopy Coverage Report ===');
  lines.push('');
  lines.push('Per-year:');
  for (const y of report.perYear) {
    lines.push(`  ${y.year}: ${y.distinctSessions} sessions, ${y.distinctSymbols} distinct symbols`);
  }
  lines.push('');
  lines.push(`Per-symbol session span (dense, not min/max date): min=${report.perSymbolSessionCounts.min} median=${report.perSymbolSessionCounts.median} max=${report.perSymbolSessionCounts.max}`);
  lines.push('');
  lines.push('Rejected rows by reason:');
  const reasons = Object.entries(report.rejectedByReason).sort((a, b) => b[1] - a[1]);
  if (reasons.length === 0) lines.push('  (none)');
  for (const [reason, n] of reasons) lines.push(`  ${reason}: ${n}`);
  lines.push('');
  lines.push(`Listed symbols: ${report.listedSymbolCount}`);
  lines.push(`Delisted symbols (survivorship-free evidence): ${report.delistedSymbolCount}`);
  return lines.join('\n');
}
