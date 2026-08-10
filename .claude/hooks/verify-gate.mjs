// Stop: block completion if code changed this session but no verification command ran.
// You are not the verification loop. This is.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

let raw = '';
process.stdin.on('data', c => (raw += c));
process.stdin.on('end', () => {
  let inp;
  try { inp = JSON.parse(raw); } catch { process.exit(0); }
  if (inp.stop_hook_active) process.exit(0); // already blocked once; don't loop

  let changed = [];
  try {
    changed = execSync('git diff --name-only HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .filter(f => /\.(py|ts|tsx)$/.test(f) && !/(test|spec|__tests__)/i.test(f));
  } catch { process.exit(0); } // not a repo / git unavailable — don't block
  if (!changed.length) process.exit(0);

  // Fail loud, not open: an unreadable transcript means we cannot tell whether
  // anything was verified. Silently passing here would disable the gate invisibly.
  let transcript = '';
  try {
    transcript = readFileSync(inp.transcript_path, 'utf8');
  } catch (e) {
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason:
        `${changed.length} code file(s) changed and the verify-gate hook could not read the ` +
        `transcript (${e.code ?? e.message}), so it cannot confirm anything was run. ` +
        `State which verification commands you ran and their real output.`,
    }));
    process.exit(0);
  }

  const py = changed.some(f => f.endsWith('.py'));
  const ts = changed.some(f => /\.tsx?$/.test(f));
  const ran = {
    pytest: /pytest/.test(transcript),
    vitest: /vitest|npm (run )?test/.test(transcript),
    tsc: /tsc --noEmit/.test(transcript),
  };

  const missing = [];
  if (py && !ran.pytest) missing.push('python -m pytest src/server/__tests__ src/server/tests');
  if (ts && !ran.tsc) missing.push('npx tsc --noEmit');
  if (ts && !ran.vitest) missing.push('npx vitest run');
  if (!missing.length) process.exit(0);

  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason:
      `${changed.length} code file(s) changed but these never ran this session:\n` +
      missing.map(m => `  ${m}`).join('\n') +
      `\n\nRun them and report the real output. If a failure is pre-existing or unrelated, ` +
      `say so explicitly with evidence (e.g. git diff / a run on the unmodified file) rather than ` +
      `waving it through. If verification is genuinely impossible here (no live DB, no network), ` +
      `state that as a limitation instead of claiming the change is verified.`,
  }));
});
