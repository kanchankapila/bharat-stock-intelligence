// Unit tests for graphify-pointer.mjs
// This logic used to be two untested inline bash+python3 one-liners in .claude/settings.json
// that silently never fired on Windows (WSL bash could not parse the command string). These
// tests are the guard that was missing: they pin the emit/silence boundary for both matchers.
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decide, isRawSearch, targetsSourceFile } from './graphify-pointer.mjs';

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
    // relative GRAPH_PATH must resolve. Verified by point: temporarily relocating the graph.
    const dir = mkdtempSync(join(tmpdir(), 'graphify-pointer-'));
    try {
      const cwd = process.cwd();
      process.chdir(dir);
      expect(decide('Bash', { command: 'grep -rn x src/' })).toBeNull(); // no graph here
      process.chdir(cwd);
      copyFileSync('graphify-out/graph.json', join(dir, 'graph.json')); // sanity: the file exists
      expect(decide('Bash', { command: 'grep -rn x src/' }, GRAPH)).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});