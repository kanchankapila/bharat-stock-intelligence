/**
 * runPython's per-job memory ceiling (src/server/pyboot/sitecustomize.py).
 *
 * dl_trainer.py runs as a runPython child of bharat-server, so pm2's max_memory_restart never
 * saw it reach 38-52.7GB of commit on a 24GB host and kill the WSL2 VM (and the database) three
 * times, 2026-09-06..09-11. These spawn a real interpreter: the ceiling is kernel behaviour.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runPython } from '../pythonRunner';

const FIXTURE = path.join('__tests__', 'fixtures', 'mem_hog.py');
const savedLimit = process.env.PY_CHILD_MEM_LIMIT_MB;
const savedPath = process.env.PYTHONPATH;

afterEach(() => {
  if (savedLimit === undefined) delete process.env.PY_CHILD_MEM_LIMIT_MB;
  else process.env.PY_CHILD_MEM_LIMIT_MB = savedLimit;
  if (savedPath === undefined) delete process.env.PYTHONPATH;
  else process.env.PYTHONPATH = savedPath;
});

describe.runIf(process.platform === 'win32')('runPython memory ceiling', () => {
  it('fails a runaway job with a MEMORY CEILING reason instead of letting it grow', async () => {
    process.env.PY_CHILD_MEM_LIMIT_MB = '300';
    await expect(runPython(FIXTURE, ['800'], 60_000)).rejects.toThrow(/MEMORY CEILING/);
  }, 90_000);

  it('blames the ceiling for one oversized allocation it refused', async () => {
    // Windows counts a refused commit charge in the job's peak (measured: 3,011MB recorded for a
    // 3,000MB block refused by a 1,000MB ceiling) -- and the ceiling really is the cause here.
    process.env.PY_CHILD_MEM_LIMIT_MB = '1000';
    await expect(runPython(FIXTURE, ['3000', '__one_block__'], 60_000)).rejects.toThrow(/MEMORY CEILING/);
  }, 90_000);

  it('does not blame the ceiling for a MemoryError it did not cause', async () => {
    process.env.PY_CHILD_MEM_LIMIT_MB = '1000';
    const err = await runPython(FIXTURE, ['0', '__raise__'], 60_000).then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/MemoryError \(peak \d+MB of a 1000MB ceiling\)/);
    expect(err?.message).not.toMatch(/MEMORY CEILING/);
  }, 90_000);

  it('reports the peak memory of a job that stayed under the ceiling', async () => {
    process.env.PY_CHILD_MEM_LIMIT_MB = '1000';
    const r = await runPython(FIXTURE, ['200'], 60_000);
    expect(r.stdout).toContain('allocated 200');
    expect(r.peakMemMb).toBeGreaterThanOrEqual(200);
    expect(r.peakMemMb).toBeLessThan(1000);
  }, 90_000);

  it('PY_CHILD_MEM_LIMIT_MB=0 disables the ceiling', async () => {
    process.env.PY_CHILD_MEM_LIMIT_MB = '0';
    const r = await runPython(FIXTURE, ['800'], 60_000);
    expect(r.stdout).toContain('allocated 800');
  }, 90_000);

  it('keeps an existing PYTHONPATH importable', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsi-pypath-'));
    fs.writeFileSync(path.join(dir, 'bsi_marker_mod.py'), 'X = 1\n');
    process.env.PYTHONPATH = dir;
    process.env.PY_CHILD_MEM_LIMIT_MB = '1000';
    const r = await runPython(FIXTURE, ['50', 'bsi_marker_mod'], 60_000);
    expect(r.stdout).toContain('allocated 50');
    fs.rmSync(dir, { recursive: true, force: true });
  }, 90_000);

  it('leaves no peak-record temp files behind', async () => {
    process.env.PY_CHILD_MEM_LIMIT_MB = '1000';
    // Scoped to this process's own files: a live bharat-server's runPython jobs share the tmpdir.
    const mine = () => fs.readdirSync(os.tmpdir()).filter(f => f.startsWith(`bsi-py-peak-${process.pid}-`)).length;
    const before = mine();
    await runPython(FIXTURE, ['50'], 60_000);
    await expect(runPython(FIXTURE, ['1200'], 60_000)).rejects.toThrow();
    const after = mine();
    expect(after).toBe(before);
  }, 90_000);
});
