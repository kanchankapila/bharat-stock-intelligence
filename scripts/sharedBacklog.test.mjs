import { describe, expect, it } from 'vitest';
import { collectFiles, markerKey, validateSharedBacklog } from './sharedBacklog.mjs';

const ledger = 'docs/audit-findings.md';
const id = 'AF-20261025-01';
const entrypoints = ['AGENTS.md', 'CLAUDE.md', '.clinerules/01-project.md', '.cursor/rules/project.mdc', '.github/copilot-instructions.md'];
function fixture() {
  return new Map([[ledger, `# Shared ledger\n| ${id} | fixture |`],
    ...entrypoints.map(p => [p, `Read AGENTS.md and CLAUDE.md. Shared backlog: ${ledger}.`])]);
}

describe('single model-independent repository backlog', () => {
  it('checks the actual repository, including untracked instruction entrypoints', () => {
    const files = collectFiles(process.cwd());
    expect(files.size).toBeGreaterThan(entrypoints.length);
    expect(validateSharedBacklog(files)).toEqual([]);
  }, 30_000); // Whole-tree disk scan measured 12.7s under contention; not a 5s logic/performance test.
  it('accepts one authoritative ledger and thin agent pointers', () => {
    expect(validateSharedBacklog(fixture())).toEqual([]);
  });
  it('rejects an absent ledger rather than treating an empty scan as clean', () => {
    const files = fixture(); files.delete(ledger);
    expect(validateSharedBacklog(files).join('\n')).toContain('authoritative ledger');
  });
  it('rejects missing or diverted model instructions', () => {
    const files = fixture(); files.set('.clinerules/01-project.md', 'Use private-cline-todo.md');
    expect(validateSharedBacklog(files).join('\n')).toContain('.clinerules/01-project.md');
  });
  it('rejects a second unchecked work queue without marking tasks completed', () => {
    const files = fixture(); files.set('docs/old-plan.md', '- [ ] Fix delivery');
    expect(validateSharedBacklog(files).join('\n')).toContain('unchecked work item');
    files.set('docs/old-plan.md', `Historical recipe; status: ${ledger} ${id}.\n- Fix delivery`);
    expect(validateSharedBacklog(files)).toEqual([]);
  });
  it('does not turn fenced documentation examples into actual pending work', () => {
    const files = fixture(); files.set('docs/example.md', '```md\n- [ ] example\n```');
    expect(validateSharedBacklog(files)).toEqual([]);
  });
  it('preserves individually registered runbook templates without exempting an entire file', () => {
    const files = fixture(); const item = '- [ ] Verify the health response for this deployment';
    files.set('docs/runbook.md', item);
    files.set(ledger, `${files.get(ledger)}\n<!-- backlog-checklist: ${markerKey('docs/runbook.md', item)} ${id} -->`);
    expect(validateSharedBacklog(files)).toEqual([]);
    files.set('docs/runbook.md', `${item}\n- [ ] A new engineering task`);
    expect(validateSharedBacklog(files).join('\n')).toContain('unchecked work item');
  });
  it('rejects duplicate remediation-state matrices outside the ledger', () => {
    const files = fixture(); files.set('docs/plan.md', '| Finding | Remediation state |');
    expect(validateSharedBacklog(files).join('\n')).toContain('parallel status matrix');
  });
  it('requires each source-debt marker to reference an existing central ID', () => {
    const files = fixture(); const source = '// TODO: correct the holiday calendar';
    files.set('src/calendar.ts', source);
    expect(validateSharedBacklog(files).join('\n')).toContain('unregistered source marker');
    files.set(ledger, `${files.get(ledger)}\n<!-- backlog-source: ${markerKey('src/calendar.ts', source)} ${id} -->`);
    expect(validateSharedBacklog(files)).toEqual([]);
    files.set('src/calendar.ts', `${source}\n// TODO: a new distinct task`);
    expect(validateSharedBacklog(files).join('\n')).toContain('unregistered source marker');
  });
  it('rejects links to nonexistent findings', () => {
    const files = fixture();
    files.set(ledger, `${files.get(ledger)}\n<!-- backlog-source: src/a.ts#0123456789 AF-20990101-99 -->`);
    expect(validateSharedBacklog(files).join('\n')).toContain('unknown finding');
  });
});
