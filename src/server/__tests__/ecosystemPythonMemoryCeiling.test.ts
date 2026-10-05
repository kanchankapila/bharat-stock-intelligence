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
// DERIVED from the config, never hand-listed. A hand-maintained allowlist silently exempts the
// next Python app someone adds -- which is exactly what happened: `bqa-daily` (2026-09-29) was
// registered with a Python interpreter and no ceiling, and this suite stayed green because its
// name was not in the list. `test-integrity-audit.md` section 3 names this shape.
const PY_APPS = apps.filter(a => /python(\.exe)?$/i.test(String(a.interpreter ?? '')));

describe('ecosystem.config.cjs Python services', () => {
  it('keeps the Bharat Alpha scheduler online for bounded catch-up and pre-open capture', () => {
    const scheduler = apps.find(a => a.name === 'bqa-scheduler');
    expect(scheduler, 'bqa-scheduler missing from ecosystem.config.cjs').toBeDefined();
    expect(scheduler.args).toBe('preopen-scheduler');
    expect(scheduler.autorestart).toBe(true);
  });

  it('finds every Python app by interpreter, not by a hand-kept list', () => {
    // Guard the guard: if this ever reads 0, the filter broke and every assertion below
    // vacuously passes. Independent floor -- the four long-running services plus bqa-daily.
    expect(PY_APPS.length).toBeGreaterThanOrEqual(6);
    expect(PY_APPS.map(a => a.name)).toEqual(
      expect.arrayContaining(['alphaquant-api', 'ml-api', 'chatbot', 'engine-worker', 'bqa-daily', 'bqa-scheduler']));
  });

  it.each(PY_APPS.map(a => a.name))('%s runs with the pyboot memory ceiling', (name) => {
    const app = apps.find(a => a.name === name);
    expect(app, `${name} missing from ecosystem.config.cjs`).toBeDefined();
    expect(app.env.PYTHONPATH.split(path.delimiter)).toContain(path.join(ROOT, 'src', 'server', 'pyboot'));
    expect(Number(app.env.BHARAT_PY_MEM_LIMIT_MB)).toBeGreaterThan(0);
    expect(app.env.PYTHONUNBUFFERED).toBe('1');
  });
});
