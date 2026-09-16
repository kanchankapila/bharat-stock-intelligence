/**
 * The long-running Python services get the same kernel-enforced memory ceiling as runPython
 * children (src/server/pyboot/sitecustomize.py).
 *
 * pm2's max_memory_restart cannot protect them on this box: pm2 watches the PID it launched,
 * and venv\Scripts\python.exe is a redirector that spawns the real interpreter. Measured
 * 2026-09-11: pm2 reported 1MB for each Python service while the real interpreters held
 * 2.0-2.6GB private -- and ml-api can retrain the ensemble in-process.
 */
import { describe, expect, it } from 'vitest';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..', '..', '..');
const { apps } = require(path.join(ROOT, 'ecosystem.config.cjs')) as { apps: any[] };
const PY_SERVICES = ['alphaquant-api', 'ml-api', 'chatbot', 'engine-worker'];

describe('ecosystem.config.cjs Python services', () => {
  it.each(PY_SERVICES)('%s runs with the pyboot memory ceiling', (name) => {
    const app = apps.find(a => a.name === name);
    expect(app, `${name} missing from ecosystem.config.cjs`).toBeDefined();
    expect(app.env.PYTHONPATH.split(path.delimiter)).toContain(path.join(ROOT, 'src', 'server', 'pyboot'));
    expect(Number(app.env.BHARAT_PY_MEM_LIMIT_MB)).toBeGreaterThan(0);
    expect(app.env.PYTHONUNBUFFERED).toBe('1');
  });
});
