import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JOB_REGISTRY } from '../jobRegistry';
import { MONITOR_SCRIPTS } from '../monitorScripts';

/**
 * JOB_REGISTRY.everyMs coverage-completeness audit (2026-08-03).
 *
 * The other mirror-consistency tests in this directory all check "does field X accurately
 * reflect ground truth Y" for an EXISTING entry. This one answers a different question: for
 * each of JOB_REGISTRY's three everyMs-driven jobs (news-sentiment, trendlyne-intraday,
 * confluence-compute), SHOULD there also be an independent MONITOR_SCRIPTS DB-freshness entry
 * -- not just the job_heartbeat "did the BullMQ processor return without throwing" signal
 * jobRegistryCronMirror.test.ts already covers?
 *
 * That question matters because job_heartbeat can be structurally blind to a real problem:
 * confluence-compute's processor (confluence.jobs.ts) returns `{ computed: 0, ... }` -- a
 * successful, non-throwing return, not a failure -- on every tick where isMarketOpen() is true
 * (a deliberate skip: this is a positional signal that intentionally doesn't run during market
 * hours). BullMQ's Worker fires 'completed' (and recordHeartbeat(..., 'success')) identically
 * whether real computation happened or the run was a no-op skip, so job_heartbeat reports
 * "success" every 30 minutes forever even if confluence_signals silently stopped getting real
 * updates entirely. Only a DB-freshness check on the actual output table can catch that.
 *
 * Investigating all three found genuinely different answers, not a uniform "add one for each":
 *   - confluence-compute: YES, and for the strongest reason (the job_heartbeat blind spot
 *     above). Writes confluence_signals.computed_at, refreshing the whole universe every real
 *     cycle -- a clean, reliable freshness signal.
 *   - news-sentiment: YES, for a different but still real reason -- its processor has no
 *     deliberate skip, but a silent partial failure (e.g. every RSS source returning empty due
 *     to a parsing bug) would report "success" with news_sentiment_items.fetched_at never
 *     advancing, matching this codebase's own repeated "job succeeded but wrote nothing new"
 *     incident history (see CLAUDE.md).
 *   - trendlyne-intraday: NO, deliberately. runIntradayScreenerScan() (trendlyneScreener.ts)
 *     only calls upsertUnifiedSignal('screener', ...) when it finds a genuinely new
 *     high-scoring intraday breakout with no existing active signal -- legitimately zero new
 *     rows on a quiet trading day is completely normal, so a naive MAX(created_at) freshness
 *     check would false-alarm on quiet days. Worse, its write target (unified_signals,
 *     signal_source='screener') is SHARED with several unrelated writers (signals.ts,
 *     queues.ts, signals.router.ts, per this codebase's own documented history), so even when
 *     fresh, a "the table has recent rows" check would be misleadingly reassuring about
 *     trendlyne-intraday specifically -- it could report "fresh" purely off a DIFFERENT job's
 *     writes while trendlyne-intraday itself has been silently broken for weeks. A real check
 *     here would need a scan-attempt log distinct from a signal-output freshness check, which
 *     is out of scope for this mechanical audit.
 *
 * This test encodes both the coverage (confluence-compute/news-sentiment exist and are wired
 * end-to-end) and the deliberate non-coverage (trendlyne-intraday's exemption reasoning is
 * re-verified against the actual source, not just asserted), so a future session either finds
 * this test still passing (nothing to re-derive) or finds it failing with an explanation of
 * exactly what changed.
 */

function readServerSource(...relPaths: string[]): string {
  return relPaths.map(p => readFileSync(join(__dirname, '..', p), 'utf8')).join('\n');
}

const everyMsJobs = JOB_REGISTRY.filter(j => j.everyMs);
const monitorIds = new Set((MONITOR_SCRIPTS as readonly any[]).map(s => s.id));

describe('JOB_REGISTRY.everyMs jobs: MONITOR_SCRIPTS coverage completeness', () => {
  it('sanity: JOB_REGISTRY has exactly the three everyMs jobs this audit covers', () => {
    // Fails loud if a new everyMs job is added -- it needs the same "should this have an
    // independent DB-freshness check" investigation this test file exists to record, not a
    // silent pass-through.
    expect(everyMsJobs.map(j => j.jobName).sort()).toEqual(
      ['confluence-compute', 'news-sentiment', 'trendlyne-intraday'].sort(),
    );
  });

  it('confluence-compute: has a MONITOR_SCRIPTS entry, wired to a real getLastRunAt case', () => {
    expect(monitorIds.has('confluence-compute')).toBe(true);
    const routerSrc = readServerSource('routers/monitor.router.ts');
    // Confirms getLastRunAt's switch actually has a case for this id -- without one, the
    // switch's `default: return null;` silently makes the entry permanently show 'never run'
    // no matter how fresh confluence_signals actually is (the entry would exist but be inert).
    expect(routerSrc).toMatch(/case 'confluence-compute':\s*\n\s*row = await dbGet\("SELECT MAX\(computed_at\) as t FROM confluence_signals"\)/);
  });

  it('news-sentiment: has a MONITOR_SCRIPTS entry, wired to a real getLastRunAt case', () => {
    expect(monitorIds.has('news-sentiment')).toBe(true);
    const routerSrc = readServerSource('routers/monitor.router.ts');
    expect(routerSrc).toMatch(/case 'news-sentiment':\s*\n\s*row = await dbGet\("SELECT MAX\(fetched_at\) as t FROM news_sentiment_items"\)/);
  });

  it('trendlyne-intraday: deliberately has NO MONITOR_SCRIPTS entry', () => {
    expect(monitorIds.has('trendlyne-intraday')).toBe(false);
  });

  it("trendlyne-intraday's exemption reasoning still holds: its writes are conditional, not unconditional", () => {
    // Re-verifies (not just asserts) that runIntradayScreenerScan() only writes on a genuine
    // new-signal condition, gated behind a score threshold and an existing-active-signal
    // dedupe check -- if a future refactor made it write unconditionally every cycle (e.g. a
    // heartbeat row regardless of findings), a naive freshness check would become viable again
    // and this exemption would need re-deriving, not silently continuing to apply.
    const screenerSrc = readServerSource('trendlyneScreener.ts');
    // Anchored on the function's actual closing return statement, not a lazy `\n}` (which
    // matches the FIRST closing brace it finds -- the return-TYPE interface's own closing
    // brace, several lines before the real function body even starts).
    const fnMatch = /export async function runIntradayScreenerScan[\s\S]*?return \{ screenersScanned, highScoringStocksFound, newSignalsGenerated \};\s*\n\}/.exec(screenerSrc);
    expect(fnMatch, 'runIntradayScreenerScan not found -- source shape may have changed').not.toBeNull();
    const fnBody = fnMatch![0];

    // The write only happens after both gates: a high score AND no existing active signal.
    expect(fnBody).toMatch(/score === null \|\| score < 80/);
    expect(fnBody).toMatch(/existingActive/);
    expect(fnBody).toMatch(/upsertUnifiedSignal\('screener'/);
  });

  it("trendlyne-intraday's write target is genuinely shared with other writers (not exclusively its own table)", () => {
    // Confirms unified_signals is written by more than just this one job -- if a future
    // refactor gave trendlyne-intraday's screener signals their own dedicated table/column
    // distinguishing them from other signal_source='screener' writers, a freshness check would
    // become meaningful again and this exemption would need re-deriving.
    const src = readServerSource('signals.ts', 'routers/signals.router.ts')
      + readFileSync(join(__dirname, '..', 'queues.ts'), 'utf8');
    const writerCount = (src.match(/upsertUnifiedSignal\(/g) || []).length;
    expect(writerCount).toBeGreaterThan(1);
  });
});
