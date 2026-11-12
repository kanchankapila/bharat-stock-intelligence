/**
 * runPython children cap OpenBLAS's thread pool (2026-11-06).
 *
 * numpy's bundled OpenBLAS reserves ~32MB of buffer per thread at import and defaults to one
 * thread per LOGICAL CPU. On this 8-core/16-thread host that is ~500MB of private commit in
 * every Python job that imports numpy (measured: numpy import 499MB at 16 threads, 242MB at 8,
 * 49MB at 2), while a 2000x2000 matmul runs 0.49s at 8 vs 0.47s at 16 -- hyperthreads add
 * nothing to BLAS. These spawn a real interpreter and read the count OpenBLAS resolved, not the
 * env var (an env var a library snapshots at import is only proven by the library's own value).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { PYTHON, runPython } from '../pythonRunner';

const FIXTURE = path.join('__tests__', 'fixtures', 'blas_threads.py');
const saved = process.env.OPENBLAS_NUM_THREADS;

afterEach(() => {
  if (saved === undefined) delete process.env.OPENBLAS_NUM_THREADS;
  else process.env.OPENBLAS_NUM_THREADS = saved;
});

function resolvedThreads(stdout: string): number {
  const m = stdout.match(/OPENBLAS_THREADS=(\d+)/);
  expect(m, `fixture printed no OpenBLAS count: ${stdout}`).not.toBeNull();
  return Number(m![1]);
}

// Needs the interpreter runPython spawns. CI's Node job has no backend-python venv, so every case
// failed there with `spawn ... ENOENT` (main, 2026-11-10) -- a missing runtime, not the cap.
describe.runIf(existsSync(PYTHON))('runPython OpenBLAS thread cap', () => {
  it('caps OpenBLAS at 8 threads by default', async () => {
    delete process.env.OPENBLAS_NUM_THREADS;
    const r = await runPython(FIXTURE, [], 120_000);
    expect(resolvedThreads(r.stdout)).toBe(Math.min(8, os.cpus().length));
  }, 150_000);

  it('lets an operator-set OPENBLAS_NUM_THREADS win', async () => {
    process.env.OPENBLAS_NUM_THREADS = '3';
    const r = await runPython(FIXTURE, [], 120_000);
    expect(resolvedThreads(r.stdout)).toBe(3);
  }, 150_000);
});
