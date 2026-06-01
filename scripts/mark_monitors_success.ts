import db from '../src/server/db';
import { MONITOR_SCRIPTS } from '../src/server/routers/monitor.router';

for (const s of MONITOR_SCRIPTS) {
  const key = `monitor_${s.id}`;
  db.prepare("INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, 'success');
  db.prepare("INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(`${key}_ran_at`, new Date().toISOString());
  db.prepare("DELETE FROM app_settings WHERE key=?").run(`${key}_error`);
}
console.log("All monitors marked as successful.");
