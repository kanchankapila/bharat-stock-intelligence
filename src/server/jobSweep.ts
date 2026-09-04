/**
 * Empirical "what did this job actually write" measurement for the controlled one-job-at-a-time
 * validation sweep.
 *
 * The sweep's central question is not "did the job exit 0" -- job_run_history already answers
 * that, and answers it misleadingly: a skipped step, a gated no-op and a genuinely successful
 * run all record 'success'. The question is "did rows move, and in which tables", and this
 * module answers it by diffing pg_stat_user_tables either side of the run rather than by
 * consulting a hand-maintained job->table map. That is deliberate: recurring-bugs.md's
 * "a guard built on a hand-enumerated allowlist only guards what someone remembered to list"
 * applies exactly here -- a static map cannot notice a job that newly stops writing a table,
 * which is the failure this sweep exists to find.
 *
 * Two caveats the caller must respect, both encoded below rather than left to discipline:
 *   - Hypertable writes land on chunk relations, never the parent name, so chunks are rolled up.
 *   - pg_stat counters are cumulative since the last reset, so a negative delta means the
 *     counters were reset mid-run and the measurement is void -- not that rows were deleted.
 */

export interface TableStat {
  ins: number;
  upd: number;
  del: number;
}

export type Snapshot = Record<string, TableStat>;

export interface RawStatRow {
  relname: string;
  // pg returns bigint columns as strings via node-postgres; accept both rather than trusting
  // every call site to coerce.
  n_tup_ins: number | string;
  n_tup_upd: number | string;
  n_tup_del: number | string;
}

const CHUNK_RE = /^_hyper_\d+_\d+_chunk$/;

function add(target: Snapshot, key: string, ins: number, upd: number, del: number): void {
  const cur = target[key] ?? { ins: 0, upd: 0, del: 0 };
  target[key] = { ins: cur.ins + ins, upd: cur.upd + upd, del: cur.del + del };
}

/**
 * Folds pg_stat_user_tables rows into a per-table snapshot, summing every TimescaleDB chunk
 * onto its parent hypertable. An unmapped chunk keeps its own name instead of being dropped --
 * a chunk created after the parent map was read is still evidence of a write, and silently
 * discarding it would understate what the job did.
 */
export function rollupChunks(rows: RawStatRow[], chunkParent: Record<string, string>): Snapshot {
  const out: Snapshot = {};
  for (const r of rows) {
    const name = CHUNK_RE.test(r.relname) ? (chunkParent[r.relname] ?? r.relname) : r.relname;
    add(out, name, Number(r.n_tup_ins), Number(r.n_tup_upd), Number(r.n_tup_del));
  }
  return out;
}

/**
 * Per-table delta between two snapshots, omitting tables that did not move. A table missing
 * from `before` is treated as having started at zero: pg_stat_user_tables is read with a
 * "> 0 lifetime writes" filter, so a table's first-ever write would otherwise look like no
 * change at all.
 */
export function diffSnapshots(before: Snapshot, after: Snapshot): Snapshot {
  const out: Snapshot = {};
  for (const [name, a] of Object.entries(after)) {
    const b = before[name] ?? { ins: 0, upd: 0, del: 0 };
    const d = { ins: a.ins - b.ins, upd: a.upd - b.upd, del: a.del - b.del };
    if (d.ins !== 0 || d.upd !== 0 || d.del !== 0) out[name] = d;
  }
  return out;
}

/**
 * True if any component of the diff is negative. Cumulative counters only ever advance, so this
 * means pg_stat_reset() ran during the window and the diff cannot be trusted -- the caller must
 * report the run as unmeasured rather than as having written nothing.
 */
export function hasCounterReset(diff: Snapshot): boolean {
  return Object.values(diff).some(d => d.ins < 0 || d.upd < 0 || d.del < 0);
}

/** Total rows moved across every table in a diff -- the sweep's one-number "did anything happen". */
export function totalRowDelta(diff: Snapshot): number {
  return Object.values(diff).reduce((n, d) => n + d.ins + d.upd + d.del, 0);
}

/**
 * Classifies a script's stderr. pythonRunner.ts currently treats ANY non-empty stderr as
 * "finished successfully with warnings", and measured against the live logs on 2026-09-05 the
 * dominant cases were a transformers GPU efficiency hint and scrapy's own INFO lines -- i.e.
 * most "warnings" were not warnings. Classifying them lets the sweep report a real noise floor
 * instead of 154 undifferentiated warning lines.
 */
export function classifyStderr(stderr: string | null | undefined): 'clean' | 'benign_warning' | 'real_error' {
  const s = (stderr ?? '').trim();
  if (!s) return 'clean';

  const BENIGN = [
    /You seem to be using the pipelines sequentially on GPU/i,
    /^\[?\d{4}-\d{2}-\d{2}[ T][\d:,.]+\]?\s*INFO:/im,
    /expandable_segments not supported/i,
    /PYTORCH_CUDA_ALLOC_CONF is deprecated/i,
    /UserWarning:/i,
    /FutureWarning:/i,
    /DeprecationWarning:/i,
    /InconsistentVersionWarning/i,
  ];
  const REAL = [
    /Traceback \(most recent call last\)/i,
    /\bError\b/,
    /\bException\b/,
    /\bFAILED\b/,
    /could not|cannot connect|connection refused/i,
  ];

  // A real error anywhere outranks any amount of benign chatter -- the two routinely co-occur,
  // and a torch warning must never mask a traceback sitting underneath it. This is the same
  // defect shape as pythonRunner.ts's `stderr || stdout`, where a warning being non-empty
  // discarded the actual failure reason.
  if (REAL.some(re => re.test(s))) return 'real_error';
  if (BENIGN.some(re => re.test(s))) return 'benign_warning';
  return 'real_error';
}
