#!/usr/bin/env node
// `npm audit --include=dev --audit-level=low`, except for the advisories listed in ACCEPTED: ones
// with NO patched release whose vulnerable input is not attacker-reachable here. Each entry expires
// so it is re-checked; any other advisory, or an expired entry, fails exactly as plain npm audit did.
// Owner decision 2026-11-18 (AF-20261117-22).
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const ACCEPTED = {
  // picomatch <=4.0.7 ReDoS, no patched version. Needs an attacker-chosen glob; ours come only
  // from vite/vitest config and pm2's own watch config.
  'GHSA-fc5q-39xc-vjpf': '2026-12-17',
};

export function unacceptedAdvisories(audit, accepted = ACCEPTED, today = new Date().toISOString().slice(0, 10)) {
  const found = new Map();
  for (const v of Object.values(audit.vulnerabilities ?? {})) {
    for (const via of v.via ?? []) {
      if (typeof via !== 'object') continue;
      const id = String(via.url ?? '').split('/').pop() || `${via.name}:${via.title}`;
      const until = accepted[id];
      if (!until || until < today) {
        found.set(id, `${via.name} ${via.severity}: ${via.title}${until ? ` (exception expired ${until})` : ''}`);
      }
    }
  }
  return [...found].map(([id, why]) => `${id} ${why}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let raw;
  try {
    raw = execFileSync('npm', ['audit', '--include=dev', '--json'], {
      encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 << 20,
    });
  } catch (e) {
    raw = e.stdout; // npm audit exits 1 whenever it reports anything
    if (!raw) throw e;
  }
  const audit = JSON.parse(raw);
  if (audit.error) throw new Error(`npm audit failed: ${JSON.stringify(audit.error)}`);
  const bad = unacceptedAdvisories(audit);
  if (bad.length) {
    console.error(`npm audit: ${bad.length} unaccepted advisor${bad.length === 1 ? 'y' : 'ies'}:\n  ${bad.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`npm audit: no unaccepted advisories (accepted until expiry: ${Object.keys(ACCEPTED).join(', ') || 'none'})`);
}
