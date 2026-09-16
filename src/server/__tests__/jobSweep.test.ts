import { describe, it, expect } from 'vitest';
import { rollupChunks, diffSnapshots, hasCounterReset, classifyStderr, totalRowDelta, sweepStatus } from '../jobSweep';

/**
 * The sweep decides "did this job actually write anything" by diffing pg_stat_user_tables
 * either side of a run, rather than consulting a hand-maintained job->table map (which would
 * only ever guard what someone remembered to list -- recurring-bugs.md). Two things have to be
 * right for that diff to mean anything, and both are pure functions so both are tested here.
 *
 * 1. Hypertable writes land on CHUNK relations (_hyper_5_3283_chunk), never on the parent name.
 *    Live-checked 2026-09-05: the two largest write targets in this database are chunks, not
 *    tables. Without rollup, a job that writes 3M rows into stock_ohlcv reports as having
 *    touched some opaque chunk, and a reader looking for "stock_ohlcv" concludes it wrote
 *    nothing -- the exact false-negative the sweep exists to detect.
 *
 * 2. pg_stat counters are CUMULATIVE since the last reset. A negative delta therefore does not
 *    mean "rows were removed"; it means the counters were reset mid-run and the whole
 *    measurement is void. Silently clamping that to zero would report a real write as no-write.
 */
describe('rollupChunks', () => {
  const chunkParent = {
    _hyper_5_3283_chunk: 'stock_ohlcv',
    _hyper_5_3786_chunk: 'stock_ohlcv',
    _hyper_3_4_chunk: 'feature_store',
  };

  it('sums every chunk of a hypertable onto the parent name', () => {
    const out = rollupChunks(
      [
        { relname: '_hyper_5_3283_chunk', n_tup_ins: 10, n_tup_upd: 5, n_tup_del: 0 },
        { relname: '_hyper_5_3786_chunk', n_tup_ins: 7, n_tup_upd: 3, n_tup_del: 1 },
      ],
      chunkParent,
    );
    expect(out).toEqual({ stock_ohlcv: { ins: 17, upd: 8, del: 1 } });
  });

  it('leaves an ordinary table untouched', () => {
    const out = rollupChunks(
      [{ relname: 'technical_signals', n_tup_ins: 4, n_tup_upd: 9, n_tup_del: 2 }],
      chunkParent,
    );
    expect(out).toEqual({ technical_signals: { ins: 4, upd: 9, del: 2 } });
  });

  it('keeps an unmapped chunk under its own name rather than dropping it', () => {
    // A chunk created after the parent-map was read must still be visible as *something*,
    // otherwise a write silently disappears from the sweep's evidence.
    const out = rollupChunks(
      [{ relname: '_hyper_9_99_chunk', n_tup_ins: 1, n_tup_upd: 0, n_tup_del: 0 }],
      chunkParent,
    );
    expect(out).toEqual({ _hyper_9_99_chunk: { ins: 1, upd: 0, del: 0 } });
  });

  it('merges a chunk into a parent that also received direct writes', () => {
    const out = rollupChunks(
      [
        { relname: 'stock_ohlcv', n_tup_ins: 2, n_tup_upd: 0, n_tup_del: 0 },
        { relname: '_hyper_5_3283_chunk', n_tup_ins: 3, n_tup_upd: 1, n_tup_del: 0 },
      ],
      chunkParent,
    );
    expect(out).toEqual({ stock_ohlcv: { ins: 5, upd: 1, del: 0 } });
  });
});

describe('diffSnapshots', () => {
  it('reports only the tables whose counters actually moved', () => {
    const before = { a: { ins: 10, upd: 0, del: 0 }, b: { ins: 5, upd: 5, del: 0 } };
    const after = { a: { ins: 10, upd: 0, del: 0 }, b: { ins: 8, upd: 5, del: 1 } };
    expect(diffSnapshots(before, after)).toEqual({ b: { ins: 3, upd: 0, del: 1 } });
  });

  it('treats a table absent from the before-snapshot as having written all of its rows', () => {
    // A table with zero lifetime writes does not appear in pg_stat_user_tables' filtered read
    // at all, so its first-ever write must not be mistaken for "no change".
    const diff = diffSnapshots({}, { fresh_table: { ins: 4, upd: 0, del: 0 } });
    expect(diff).toEqual({ fresh_table: { ins: 4, upd: 0, del: 0 } });
  });

  it('returns an empty object when nothing was written', () => {
    const same = { a: { ins: 1, upd: 2, del: 3 } };
    expect(diffSnapshots(same, same)).toEqual({});
  });

  it('preserves a negative delta instead of clamping it, so a counter reset stays visible', () => {
    const diff = diffSnapshots({ a: { ins: 100, upd: 0, del: 0 } }, { a: { ins: 3, upd: 0, del: 0 } });
    expect(diff.a.ins).toBe(-97);
  });
});

describe('hasCounterReset', () => {
  it('flags a diff containing any negative component', () => {
    expect(hasCounterReset({ a: { ins: -97, upd: 0, del: 0 } })).toBe(true);
  });

  it('does not flag an ordinary forward-only diff', () => {
    expect(hasCounterReset({ a: { ins: 5, upd: 1, del: 0 } })).toBe(false);
  });
});

/**
 * classifyStderr exists because pythonRunner.ts labels ANY non-empty stderr as "finished
 * successfully with warnings". Measured against the live pm2 log on 2026-09-05, 40 of the 154
 * warning lines were a transformers GPU hint or scrapy's own INFO output -- the script had
 * succeeded outright.
 *
 * The load-bearing case is the LAST test: benign chatter and a real traceback routinely arrive
 * on the same stream, and a classifier that returns on first match would report a crashed job
 * as a warning. That is the same defect shape as pythonRunner.ts's `const reason = stderr ||
 * stdout`, where one non-empty stream discarded the actual failure reason.
 */
describe('classifyStderr', () => {
  it('classifies empty stderr as clean', () => {
    expect(classifyStderr('')).toBe('clean');
    expect(classifyStderr(null)).toBe('clean');
  });

  it('classifies the transformers GPU hint as benign', () => {
    expect(classifyStderr('[transformers] You seem to be using the pipelines sequentially on GPU.')).toBe('benign_warning');
  });

  it("classifies scrapy's own INFO progress lines as benign", () => {
    expect(classifyStderr('[2026-09-04 21:50:10] INFO: Fetched (200) <GET https://trendlyne.com/x>')).toBe('benign_warning');
  });

  it('classifies the HighFlyer skip notice as benign, not a real error', () => {
    // Live 2026-09-09 04:05 IST: that single line was the entire stderr of a successful
    // high_flyer_retrospective.py run (it completed and wrote its recall stats), yet it
    // fell through to the real_error default and logged at warn level.
    expect(classifyStderr('[HighFlyer] skipped 1/6 stat day(s) with no precursor_counts_json when computing lifts')).toBe('benign_warning');
    // A traceback underneath the skip notice must still win — the real-error-anywhere rule.
    expect(classifyStderr('[HighFlyer] skipped 1/6 stat day(s) with no precursor_counts_json when computing lifts\nTraceback (most recent call last):')).toBe('real_error');
  });

  it('classifies a traceback as a real error', () => {
    expect(classifyStderr('Traceback (most recent call last):\n  File "x.py", line 1')).toBe('real_error');
  });

  // AF-20260912-02. The BENIGN log-record pattern required `INFO:` WITH A COLON directly
  // after the timestamp, but Python's default logging format ("%(asctime)s %(levelname)s
  // %(message)s") emits `INFO panel: 27608 rows` with no colon after the level, and any
  // logger configured with a name field emits `[finstack] INFO:`. Neither matched, so both
  // fell through to the `real_error` default. Measured over logs/pm2-out.log 2026-09-10..12:
  // 8 scripts were reported as real_error whose entire stderr was ordinary INFO progress
  // output. Every string below is verbatim from that log.
  it('classifies python default-format INFO records as benign (no colon after the level)', () => {
    const twoLines = [
      '2026-09-10 11:04:08,573 INFO panel: 27608 rows, 6 dates',
      '2026-09-10 11:04:16,398 INFO wrote 6932 composite rows (4 dates)',
    ].join(String.fromCharCode(10));
    expect(classifyStderr(twoLines)).toBe('benign_warning');
    expect(classifyStderr('2026-09-10 20:06:43,564 INFO progress 100/2340, 9 rows so far')).toBe('benign_warning');
  });

  it('classifies a log record carrying a logger-name field as benign', () => {
    expect(classifyStderr('2026-09-10 07:10:42 [finstack] INFO: Starting FinStack MCP server v0.10.0')).toBe('benign_warning');
  });

  it('classifies a WARNING-level record as benign, not a real error', () => {
    expect(classifyStderr("2026-09-11 20:43:48,933 WARNING NIFTY50 expiry=2026-09-15: MC's freshest OI block is 2026-09-10 (< requested 2026-09-11); skipping rather than backdating")).toBe('benign_warning');
  });

  it('still flags a real error sitting under ordinary INFO records', () => {
    const mixedLog = [
      '2026-09-10 11:04:08,573 INFO panel: 27608 rows',
      'Traceback (most recent call last):',
    ].join(String.fromCharCode(10));
    expect(classifyStderr(mixedLog)).toBe('real_error');
    // A vendor HTTP failure reported inside a log record is a real error, not progress.
    expect(classifyStderr('2026-09-10 20:06:43,564 ERROR fetch failed: HTTP Error 503')).toBe('real_error');
  });

  it("classifies a script's own not-a-failure notice as benign, but keeps its real errors real", () => {
    expect(classifyStderr('[UnifiedRanker] universe filter: kept 2362, dropped 2396 non-tradeable/unpriced symbols')).toBe('benign_warning');
    expect(classifyStderr('[UnifiedRanker] RL gate excluded HAPPSTMNDS: avg_return=-0.96% over 33 resolved outcomes (90d), t=-2.40')).toBe('benign_warning');
    expect(classifyStderr('[StockOptionChain] 2/214 symbol(s) have no chain in ANY surviving source and are NOT counted as fetch failures.')).toBe('benign_warning');
    // The narrowness is the point: a sibling line from the SAME scripts that reports an
    // actual fetch failure must still classify as a real error.
    expect(classifyStderr('[DeliveryTrend] Fetch error https://www.nseindia.com/api/bulk-deals after retries: 503 Server Error')).toBe('real_error');
  });

  it('reports a real error even when benign warnings appear FIRST on the same stream', () => {
    const mixed = [
      'UserWarning: expandable_segments not supported on this platform',
      '[transformers] You seem to be using the pipelines sequentially on GPU.',
      'Traceback (most recent call last):',
      '  File "dl_trainer.py", line 42, in <module>',
    ].join('\n');
    expect(classifyStderr(mixed)).toBe('real_error');
  });
});

describe('totalRowDelta', () => {
  it('sums every component across every table', () => {
    expect(totalRowDelta({ a: { ins: 2, upd: 3, del: 1 }, b: { ins: 4, upd: 0, del: 0 } })).toBe(10);
  });

  it('is zero for an empty diff, which is how a no-write run is detected', () => {
    expect(totalRowDelta({})).toBe(0);
  });
});

describe('sweepStatus', () => {
  const base = {
    state: 'completed',
    everActive: true,
    counterReset: false,
    skipped: false,
    selfReportedFailure: false,
  };

  it('reports never_started when the job never left waiting', () => {
    // A job enqueued onto a queue name that has no Worker sits in `waiting` forever and then
    // trips the sweep timeout -- indistinguishable from a slow job unless the transition into
    // `active` is observed. Live 2026-09-05: ohlcv-gap-fill-daily was enqueued onto 'backfill'
    // instead of 'ohlcv-backfill' and was reported as a 30-minute `timeout` that had written
    // 282,823 rows -- rows that belonged to a concurrently-running ml-daily-ops.
    expect(sweepStatus({ ...base, state: 'timeout(waiting)', everActive: false })).toBe('never_started');
  });

  it('still reports timeout when the job did start and then ran long', () => {
    expect(sweepStatus({ ...base, state: 'timeout(active)', everActive: true })).toBe('timeout');
  });

  it('prefers never_started over a counter reset, because the delta is not the job\'s either way', () => {
    expect(sweepStatus({ ...base, state: 'timeout(waiting)', everActive: false, counterReset: true }))
      .toBe('never_started');
  });

  it('reports unmeasured_counter_reset for a job that did run', () => {
    expect(sweepStatus({ ...base, counterReset: true })).toBe('unmeasured_counter_reset');
  });

  it('reports a self-reported failure as failed even though BullMQ completed the job', () => {
    expect(sweepStatus({ ...base, selfReportedFailure: true })).toBe('failed');
  });

  it('reports a gated no-op as skipped, not success', () => {
    expect(sweepStatus({ ...base, skipped: true })).toBe('skipped');
  });

  it('reports an evicted completed job distinctly from a failure', () => {
    expect(sweepStatus({ ...base, state: 'gone' })).toBe('completed_evicted');
  });

  it('reports success for a plain completed run', () => {
    expect(sweepStatus(base)).toBe('success');
  });

  it('reports failed for a thrown failure', () => {
    expect(sweepStatus({ ...base, state: 'failed' })).toBe('failed');
  });
});
