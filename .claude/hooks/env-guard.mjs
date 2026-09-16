// PreToolUse(Edit|Write): require explicit confirmation before touching .env* files.
// .env holds real production credentials (POSTGRES_URL, provider keys) -- recurring-bugs.md's
// dotenv-leaks-into-test-worker entry is evidence this repo has already been bitten by careless
// env-file handling once. This doesn't hard-block (editing .env to add a new documented var is
// legitimate) -- it downgrades to an explicit "ask" so a stray/automated edit can't slip through
// silently the way a plain Edit/Write permission grant otherwise would.

/** Given a tool_input.file_path, the hook JSON to emit, or null to allow silently. */
export function decide(filePath) {
  const p = (filePath ?? '').replace(/\\/g, '/');
  const base = p.split('/').pop() ?? '';
  if (!/^\.env(\..+)?$/.test(base)) return null;

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason:
        `${base} holds real credentials (POSTGRES_URL, provider API keys). Confirm this edit is ` +
        `intentional -- and if it's adding a new var, check it also needs documenting/seeding ` +
        `elsewhere (a migration for a DB-backed setting, not just this file) per recurring-bugs.md's ` +
        `"A manual UPDATE app_settings is not a fix" entry.`,
    },
  };
}

function main() {
  let raw = '';
  process.stdin.on('data', c => (raw += c));
  process.stdin.on('end', () => {
    let p = '';
    try {
      p = JSON.parse(raw).tool_input?.file_path ?? '';
    } catch {
      process.exit(0);
    }
    const out = decide(p);
    if (out) process.stdout.write(JSON.stringify(out));
  });
}

if (process.argv[1]?.endsWith('env-guard.mjs')) main();
