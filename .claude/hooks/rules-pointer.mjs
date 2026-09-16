// PreToolUse(Edit|Write): surface the rule file for the path being edited.
// ponytail: substring matching, not a router. Add a line when a rule file earns one.

export function getRulesForPath(filePath) {
  if (!filePath) return null;
  const p = String(filePath).replace(/\\/g, '/');
  if (!/\.(py|ts|tsx|sql)$/.test(p)) return null;

  const rules = [];
  const add = f => rules.includes(f) || rules.push(f);
  const extras = [];
  const addExtra = f => extras.includes(f) || extras.push(f);

  if (/(rank|scor|signal|conviction|confluence|outcome)/i.test(p)) add('scoring-authority.md');
  if (/(fetcher|_client|screener|stockMapping|dataQualityChecks)/i.test(p)) add('data-sources.md');
  if (/(backtest|factor_|accuracy|performance_tracker|calibrat|_edge)/i.test(p)) add('measurement.md');
  if (/(ml_|_model|model_|classifier|predictor|ensemble|promotion|drift_|dl_engine|ranker|backtest|factor_|_edge|ablation|walkforward|calibrat)/i.test(p)) add('ml-model-bugs.md');
  if (/\.py$/.test(p) || /\.sql$/.test(p)) add('recurring-bugs.md');
  // node-pg-migrate migrations don't match any of the keyword patterns above by filename alone,
  // so a routine new migration got no automatic pointer to the hazard-specific review that
  // already exists for it (hypertable/compression constraints, SQLite/Postgres dual-schema drift).
  if (/^migrations\/.*\.sql$/.test(p)) addExtra('/migration-safety-review');

  if (!rules.length && !extras.length) return null;
  const parts = [];
  if (rules.length) {
    parts.push(
      `Rules that apply to ${p}: ` +
      rules.map(r => `.claude/rules/${r}`).join(', ') +
      `. Read any you have not already read this session before editing.`
    );
  }
  if (extras.length) {
    parts.push(`Also run ${extras.join(', ')} on this migration before it applies to production.`);
  }

  return {
    rules,
    extras,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: parts.join(' '),
    },
  };
}

if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  let raw = '';
  process.stdin.on('data', c => (raw += c));
  process.stdin.on('end', () => {
    let p = '';
    try { p = JSON.parse(raw).tool_input?.file_path ?? ''; } catch { process.exit(0); }
    const result = getRulesForPath(p);
    if (!result) process.exit(0);
    process.stdout.write(JSON.stringify({ hookSpecificOutput: result.hookSpecificOutput }));
  });
}

