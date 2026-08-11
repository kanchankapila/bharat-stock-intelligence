// PreToolUse(Edit|Write): surface the rule file for the path being edited.
// ponytail: substring matching, not a router. Add a line when a rule file earns one.
let raw = '';
process.stdin.on('data', c => (raw += c));
process.stdin.on('end', () => {
  let p = '';
  try { p = (JSON.parse(raw).tool_input?.file_path ?? '').replace(/\\/g, '/'); } catch { process.exit(0); }
  if (!/\.(py|ts|tsx|sql)$/.test(p)) process.exit(0);

  const rules = [];
  const add = f => rules.includes(f) || rules.push(f);

  if (/(rank|scor|signal|conviction|confluence|outcome)/i.test(p)) add('scoring-authority.md');
  if (/(fetcher|_client|screener|stockMapping|dataQualityChecks)/i.test(p)) add('data-sources.md');
  if (/(backtest|factor_|accuracy|performance_tracker|calibrat|_edge)/i.test(p)) add('measurement.md');
  if (/\.py$/.test(p) || /\.sql$/.test(p)) add('recurring-bugs.md');

  if (!rules.length) process.exit(0);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext:
        `Rules that apply to ${p}: ` +
        rules.map(r => `.claude/rules/${r}`).join(', ') +
        `. Read any you have not already read this session before editing.`,
    },
  }));
});
