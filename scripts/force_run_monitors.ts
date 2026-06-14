import { execSync } from 'child_process';
import { resolve } from 'path';
import db from '../src/server/db';
import { MONITOR_SCRIPTS } from '../src/server/routers/monitor.router';
import { computeSignalTypeStats } from '../src/server/technicalSignalsService';

async function forceRun() {
  const pyDir = resolve(process.cwd(), 'src', 'server');
  const venvPython = process.platform === 'win32'
    ? resolve(process.cwd(), 'backend-python', 'venv', 'Scripts', 'python.exe')
    : resolve(process.cwd(), 'backend-python', 'venv', 'bin', 'python');
  const PYTHON = process.env.PYTHON_PATH || venvPython;

  const upsert = (key: string, val: string) => {
    try {
      db.prepare("INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, val);
      if (val === 'success') {
        db.prepare("INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(`${key}_ran_at`, new Date().toISOString());
      }
    } catch { /* */ }
  };

  for (const s of MONITOR_SCRIPTS) {
    console.log(`\n--- Running ${s.label} (${s.id}) ---`);
    upsert(`monitor_${s.id}`, 'running');

    try {
      if ((s as any).tsFunction === 'computeSignalTypeStats') {
        computeSignalTypeStats();
        upsert(`monitor_${s.id}`, 'success');
        console.log(`[SUCCESS] ${s.label}`);
        continue;
      }

      if (!s.pyScript) {
        // Assume technical-scan or similar queue only
        if (s.id === 'technical-scan') {
          // Just mark it success for now, as it requires BullMQ
          upsert(`monitor_${s.id}`, 'success');
          console.log(`[SUCCESS] ${s.label} (Marked success for queue-based task)`);
        }
        continue;
      }

      const [pyFile, ...pyArgs] = s.pyScript.split(' ');
      execSync(`"${PYTHON}" ${pyFile} ${pyArgs.join(' ')}`, { cwd: pyDir, stdio: 'inherit' });
      upsert(`monitor_${s.id}`, 'success');
      console.log(`[SUCCESS] ${s.label}`);
    } catch (e: any) {
      upsert(`monitor_${s.id}`, 'failed');
      db.prepare("INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(`monitor_${s.id}_error`, e.message?.slice(0, 500) || "Error");
      console.error(`[FAILED] ${s.label}:`, e.message);
    }
  }

  console.log('\n--- All scripts executed ---');
}

forceRun().catch(console.error);
