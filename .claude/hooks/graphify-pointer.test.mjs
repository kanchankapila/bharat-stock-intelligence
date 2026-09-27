// Unit tests for graphify-pointer.mjs
// This logic used to be two untested inline bash+python3 one-liners in .claude/settings.json
// that silently never fired on Windows (WSL bash could not parse the command string). These
// tests are the guard that was missing: they pin the emit/silence boundary for both matchers.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { decide, isGraphifyCall, isRawSearch, targetsSourceFile } from './graphify-pointer.mjs';

const GRAPH = { graphExists: true };
const NO_GRAPH = { graphExists: false };

describe('graphify-pointer / file targeting', () => {
  it('targets source files by Read file_path and by Glob pattern', () => {
    expect(targetsSourceFile('src/server/queues.ts', undefined, undefined)).toBe(true);
    expect(targetsSourceFile(undefined, 'src/server/**/*.py', undefined)).toBe(true);
    expect(targetsSourceFile(undefined, undefined, 'src/server')).toBe(false); // bare dir, no extension
  });

  it('never targets the graph artifact itself', () => {
    expect(targetsSourceFile('graphify-out/graph.json', undefined, undefined)).toBe(false);
    expect(targetsSourceFile('graphify-out/wiki/index.md', undefined, undefined)).toBe(false);
    expect(targetsSourceFile(undefined, 'graphify-out/**/*.ts', undefined)).toBe(false);
  });

  it('normalises Windows separators before matching', () => {
    expect(targetsSourceFile('src\\server\\drift_detector.py', undefined, undefined)).toBe(true);
  });
});

describe('graphify-pointer / search detection', () => {
  it('detects the search commands the inline hook used to match', () => {
    expect(isRawSearch('grep -rn "drift" src/server/')).toBe(true);
    expect(isRawSearch('rg drift src/')).toBe(true);
    expect(isRawSearch('find src -name "*.py"')).toBe(true);
  });

  it('stays silent for unrelated commands', () => {
    expect(isRawSearch('git status --short')).toBe(false);
    expect(isRawSearch('npx vitest run')).toBe(false);
  });
});

describe('graphify-pointer / decision', () => {
  it('emits the read reminder for a source Read', () => {
    const out = decide('Read', { file_path: 'src/server/queues.ts' }, GRAPH);
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput.additionalContext).toContain('MANDATORY');
    expect(out.hookSpecificOutput.additionalContext).toContain('graphify query');
  });

  it('emits the grep reminder for a Bash search', () => {
    const out = decide('Bash', { command: 'grep -rn "stop loss" src/' }, GRAPH);
    expect(out.hookSpecificOutput.additionalContext).toContain('before grepping');
  });

  it('stays silent for a non-search Bash command and for Edit/Write', () => {
    expect(decide('Bash', { command: 'git status --short' }, GRAPH)).toBeNull();
    expect(decide('Edit', { file_path: 'src/server/queues.ts' }, GRAPH)).toBeNull();
  });

  it('tells nobody to run graphify when there is no graph to run against', () => {
    expect(decide('Read', { file_path: 'src/server/queues.ts' }, NO_GRAPH)).toBeNull();
    expect(decide('Bash', { command: 'grep -rn x src/' }, NO_GRAPH)).toBeNull();
  });

  it('reads graph existence from a real cwd, not a hardcoded absolute path', () => {
    // Guards the regression that matters most: the hook runs with cwd = repo root, so a
    // relative GRAPH_PATH must resolve. Verified without depending on the repo's own
    // (gitignored) graph artifact, which only exists in checkouts that have run
    // `graphify update` — a fresh clone or CI must pass this too.
    const dir = mkdtempSync(join(tmpdir(), 'graphify-pointer-'));
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      // No graph in this cwd -> stay silent.
      expect(decide('Bash', { command: 'grep -rn x src/' })).toBeNull();
      // Create one IN this cwd -> the relative path must now resolve.
      mkdirSync(join(dir, 'graphify-out'), { recursive: true });
      writeFileSync(join(dir, 'graphify-out', 'graph.json'), '{}');
      expect(decide('Bash', { command: 'grep -rn x src/' })).not.toBeNull();
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
describe('graphify-pointer / stops nagging once the session has run graphify', () => {
  it('recognises real graphify calls, including the python -m form CLAUDE.md documents', () => {
    expect(isGraphifyCall('graphify query "what writes feature_store"')).toBe(true);
    expect(isGraphifyCall('& $PY -m graphify explain "unified_ranker"')).toBe(true);
    expect(isGraphifyCall('grep -rn graphify .claude/')).toBe(false);
    expect(isGraphifyCall('graphify update .')).toBe(false); // updating is not orienting
    expect(isGraphifyCall('cd repo && graphify path "A" "B"')).toBe(true);
    // merely mentioning it (heredoc, echo, a test string) is not running it
    expect(isGraphifyCall(`cat >> t.mjs <<'EOF'\n  expect(isGraphifyCall('graphify query "x"'))\nEOF`)).toBe(false);
    expect(isGraphifyCall('echo "run graphify query first"')).toBe(false);
  });

  it('a graphify call is never itself nagged, and oriented sessions are silent', () => {
    expect(decide('Bash', { command: 'graphify query "x" | grep foo' }, GRAPH)).toBeNull();
    expect(decide('Read', { file_path: 'src/server/queues.ts' }, { ...GRAPH, oriented: true })).toBeNull();
    expect(decide('Read', { file_path: 'src/server/queues.ts' }, { ...GRAPH, oriented: false })).not.toBeNull();
  });

  it('end to end: the real hook process reminds, then goes quiet after a graphify call in the same session', () => {
    const sid = `test-${process.pid}-${Date.now()}`;
    const run = payload => spawnSync(process.execPath, ['.claude/hooks/graphify-pointer.mjs'],
      { input: JSON.stringify({ session_id: sid, ...payload }), encoding: 'utf8' }).stdout;
    const read = { tool_name: 'Read', tool_input: { file_path: 'src/server/queues.ts' } };
    try {
      expect(run(read)).toContain('graphify');
      expect(run({ tool_name: 'Bash', tool_input: { command: 'graphify query "queues"' } })).toBe('');
      expect(run(read)).toBe('');
      // a different session is unaffected
      expect(spawnSync(process.execPath, ['.claude/hooks/graphify-pointer.mjs'],
        { input: JSON.stringify({ session_id: `${sid}-other`, ...read }), encoding: 'utf8' }).stdout).toContain('graphify');
    } finally {
      rmSync(`.claude/.session-start/graphify-oriented-${sid}`, { force: true });
    }
  }, 30_000); // four cold node spawns: ~2.5s each on this box, so the 5s default flakes
});
