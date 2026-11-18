// CI gate: the full `npm audit` (dev tooling included) fails on every advisory except the named, expiring exceptions below.
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const ACCEPTED = [
  { id: 'GHSA-fc5q-39xc-vjpf', until: '2026-12-17',
    why: 'picomatch <=4.0.7 ReDoS: no patched release exists (4.0.7 is latest); reached only through dev tooling (vite, vitest, tinyglobby, pm2). AF-20261025-33.' },
];

export function unaccepted(audit, accepted = ACCEPTED, today = new Date().toISOString().slice(0, 10)) {
  const live = new Set(accepted.filter(a => a.until >= today).map(a => a.id));
  const bad = new Set();
  for (const [name, v] of Object.entries(audit.vulnerabilities ?? {})) {
    for (const a of v.via.filter(x => typeof x === 'object')) {
      const id = String(a.url ?? '').split('/').pop();
      if (!live.has(id)) bad.add(`${name}: ${a.title} (${id || a.source})`);
    }
  }
  return [...bad];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let raw;
  try { raw = execSync('npm audit --include=dev --json', { encoding: 'utf8', maxBuffer: 64e6 }); }
  catch (e) { raw = e.stdout; }
  const audit = JSON.parse(raw);
  if (audit.error) { console.error('npm audit failed:', audit.error.summary ?? audit.error); process.exit(1); }
  const bad = unaccepted(audit);
  if (bad.length) { console.error('Unaccepted advisories:\n' + bad.join('\n')); process.exit(1); }
  console.log(`Dependency security OK (${ACCEPTED.length} accepted exception(s), see scripts/securityCheck.mjs).`);
}
