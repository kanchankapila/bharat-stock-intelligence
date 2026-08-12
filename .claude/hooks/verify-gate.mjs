// Stop: block completion if code changed this session but no verification command
// actually ran and passed. You are not the verification loop. This is.
//
// This gate used to regex the raw transcript for /pytest/, /vitest/, /tsc --noEmit/.
// That checks whether a command was *mentioned*, not whether it *passed* -- so the
// sentence "I ran pytest" satisfied a hook whose entire purpose is catching exactly
// that claim. It now pairs each tool_use block against its tool_result and requires
// is_error !== true, i.e. a real zero exit.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Which verification a shell command counts as, or null. */
export function classify(cmd) {
  if (/\bpytest\b/.test(cmd) && !/--collect-only|--co\b/.test(cmd)) return 'pytest';
  if (/\bvitest\b|\bnpm (run )?test\b/.test(cmd)) return 'vitest';
  if (/tsc\s+--noEmit|\bnpm run lint\b/.test(cmd)) return 'tsc';
  if (/factor_backtest\.py\b/.test(cmd)) return 'backtest';
  return null;
}

// Files whose logic feeds unified_recommendations/quant_scores directly (see
// .claude/rules/scoring-authority.md). A diff here passing tsc/pytest proves the code
// runs, not that its output is any good -- two separate factor_backtest.py benchmark
// bugs (exit-pricing, --rebalance-1) made dead factors look alive for weeks until a
// manual audit caught them (docs/measurement-history.md). recurring-bugs.md class:
// "unmeasured signal/scoring change merged, caught later by a salvage session".
const SIGNAL_SCORING_SURFACE = [
  /(^|[\\/])unified_ranker\.py$/,
  /(^|[\\/])scoring_engine\.py$/,
  /(^|[\\/])factor_backtest\.py$/,
  /(^|[\\/])multi_factor_scorer\.py$/,
  /(^|[\\/])institutional_quant_engine\.py$/,
  /quantScoringService\.ts$/,
];

const MEASUREMENT_DOCS = [
  /\.claude[\\/]rules[\\/]measurement\.md$/,
  /docs[\\/]measurement-history\.md$/,
];

/**
 * Verifications that ran to a zero exit in this transcript.
 * Two passes: collect the tool_use ids of verification commands, then accept only
 * the ones whose paired tool_result is not an error.
 */
export function verificationsPassed(transcript) {
  const pending = new Map(); // tool_use id -> kind
  const passed = new Set();

  const records = transcript
    .split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

  const blocks = r => (Array.isArray(r?.message?.content) ? r.message.content : []);

  for (const r of records) {
    for (const b of blocks(r)) {
      if (b?.type !== 'tool_use') continue;
      if (b.name !== 'Bash' && b.name !== 'PowerShell') continue;
      const kind = typeof b.input?.command === 'string' ? classify(b.input.command) : null;
      if (kind) pending.set(b.id, kind);
    }
  }
  for (const r of records) {
    for (const b of blocks(r)) {
      if (b?.type !== 'tool_result') continue;
      const kind = pending.get(b.tool_use_id);
      // is_error is set on a non-zero exit. Absent means success.
      if (kind && b.is_error !== true) passed.add(kind);
    }
  }
  return passed;
}

/**
 * null = allow completion; string = the reason to block on.
 * `allChanged` defaults to `changed` for callers that don't distinguish (existing
 * tests); pass the unfiltered git diff separately when checking whether a doc-only
 * file (measurement.md) was also touched, since `changed` excludes non-code files.
 */
export function decide(changed, transcript, allChanged = changed) {
  if (!changed.length) return null;
  const passed = verificationsPassed(transcript);
  const py = changed.some(f => f.endsWith('.py'));
  const ts = changed.some(f => /\.tsx?$/.test(f));

  const missing = [];
  if (py && !passed.has('pytest')) missing.push('python -m pytest src/server/__tests__/ src/server/tests/');
  if (ts && !passed.has('tsc')) missing.push('npx tsc --noEmit');
  if (ts && !passed.has('vitest')) missing.push('npx vitest run');

  const touchesSignalSurface = changed.some(f => SIGNAL_SCORING_SURFACE.some(re => re.test(f)));
  if (touchesSignalSurface && !passed.has('backtest')) {
    const docsUpdated = allChanged.some(f => MEASUREMENT_DOCS.some(re => re.test(f)));
    if (!docsUpdated) {
      missing.push(
        'python src/server/factor_backtest.py (or update .claude/rules/measurement.md / docs/measurement-history.md with the measured result)'
      );
    }
  }
  if (!missing.length) return null;

  return (
    `${changed.length} code file(s) changed but these never ran to a passing exit this session:\n` +
    missing.map(m => `  ${m}`).join('\n') +
    `\n\nRun them and report the real output. Describing a command is not running it -- this gate ` +
    `reads tool results, not prose. If a failure is pre-existing or unrelated, say so explicitly ` +
    `with evidence (e.g. git diff / a run on the unmodified file) rather than waving it through. ` +
    `If verification is genuinely impossible here (no live DB, no network), state that as a ` +
    `limitation instead of claiming the change is verified.`
  );
}

function main() {
  let raw = '';
  process.stdin.on('data', c => (raw += c));
  process.stdin.on('end', () => {
    let inp;
    try { inp = JSON.parse(raw); } catch { process.exit(0); }
    if (inp.stop_hook_active) process.exit(0); // already blocked once; don't loop

    let changed = [];
    let allChanged = [];
    try {
      allChanged = execSync('git diff --name-only HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split('\n')
        .filter(Boolean);
      changed = allChanged.filter(f => /\.(py|ts|tsx)$/.test(f) && !/(test|spec|__tests__)/i.test(f));
    } catch { process.exit(0); } // not a repo / git unavailable — don't block
    if (!changed.length) process.exit(0);

    // Fail loud, not open: an unreadable transcript means we cannot tell whether
    // anything was verified. Silently passing here would disable the gate invisibly.
    let transcript;
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

    const reason = decide(changed, transcript, allChanged);
    if (!reason) process.exit(0);
    process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  });
}

if (process.argv[1]?.endsWith('verify-gate.mjs')) main();
