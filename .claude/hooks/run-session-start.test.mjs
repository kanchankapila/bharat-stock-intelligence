// Unit tests for run-session-start.mjs
// The bug these pin down: `bash "$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.sh"` never ran
// on Windows (WSL bash cannot open a Windows path; exit 127), and a Windows-shaped
// CLAUDE_PROJECT_DIR made the script's own `cd ... || exit 0` a silent no-op even when bash did
// start. These tests lock in the resolution rules that fix it.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { bashCandidates, envForBash, isWindowsStylePath, pickBash, run } from './run-session-start.mjs';

describe('run-session-start / path shape', () => {
  it('recognises Windows-shaped paths and leaves POSIX ones alone', () => {
    expect(isWindowsStylePath('d:\\Github\\bharat-stock-intelligence')).toBe(true);
    expect(isWindowsStylePath('D:/Github/bharat-stock-intelligence')).toBe(true);
    expect(isWindowsStylePath('/home/user/repo')).toBe(false);
    expect(isWindowsStylePath(undefined)).toBe(false);
  });
});

describe('run-session-start / bash discovery', () => {
  it('prefers Git Bash on Windows, then falls back to PATH bash', () => {
    const env = { ProgramFiles: 'C:\\Program Files' };
    expect(bashCandidates(env, 'win32')).toEqual(['C:\\Program Files\\Git\\bin\\bash.exe', 'bash']);
  });

  it('adds the 32-bit Git Bash when ProgramFiles(x86) is set', () => {
    const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' };
    expect(bashCandidates(env, 'win32')[1]).toBe('C:\\Program Files (x86)\\Git\\bin\\bash.exe');
  });

  it('on POSIX uses bash from PATH only', () => {
    expect(bashCandidates({}, 'linux')).toEqual(['bash']);
  });

  it('skips a Git Bash that is not installed, and never returns null while PATH has bash', () => {
    const env = { ProgramFiles: 'C:\\Program Files' };
    expect(pickBash(env, 'win32', () => false)).toBe('bash');
    expect(pickBash(env, 'win32', p => p.includes('Program Files'))).toContain('Git\\bin\\bash.exe');
  });
});

describe('run-session-start / environment handed to the script', () => {
  it('drops a Windows-shaped CLAUDE_PROJECT_DIR (the script falls back to dirname)', () => {
    const out = envForBash({ CLAUDE_PROJECT_DIR: 'd:\\Github\\bharat-stock-intelligence', PATH: '/usr/bin' });
    expect(out.CLAUDE_PROJECT_DIR).toBeUndefined();
    expect(out.PATH).toBe('/usr/bin');
  });

  it('keeps a POSIX CLAUDE_PROJECT_DIR (the remote-container case)', () => {
    const out = envForBash({ CLAUDE_PROJECT_DIR: '/workspace/repo' });
    expect(out.CLAUDE_PROJECT_DIR).toBe('/workspace/repo');
  });
});

describe('run-session-start / execution', () => {
  it('runs the script by relative path from the repo root, with CLAUDE_PROJECT_DIR stripped', () => {
    const spawn = vi.fn(() => ({ status: 0 }));
    const status = run({
      env: { CLAUDE_PROJECT_DIR: 'd:\\Github\\bharat-stock-intelligence' },
      platform: 'win32',
      exists: () => false,
      spawn,
    });
    expect(status).toBe(0);
    const [bash, args, opts] = spawn.mock.calls[0];
    expect(bash).toBe('bash');
    expect(args).toEqual(['.claude/hooks/session-start.sh']);
    // Repo-root-anchored, NOT checkout-name-anchored: this module computes the root from its
    // own location, so the assertion must too — a git worktree (…/.claude/worktrees/<name>)
    // is a valid checkout whose basename is not the repo's name.
    const expectedRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
    expect(opts.cwd).toBe(expectedRoot);
    // …and that root really is one: it contains both the package manifest and the script
    // the hook launches.
    expect(existsSync(join(expectedRoot, 'package.json'))).toBe(true);
    expect(existsSync(join(expectedRoot, '.claude', 'hooks', 'session-start.sh'))).toBe(true);
    expect(opts.env.CLAUDE_PROJECT_DIR).toBeUndefined();
  });

  it('never bricks the session when bash failed to start', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const status = run({ spawn: () => ({ error: new Error('spawn ENOENT') }) });
    expect(status).toBe(0);
    expect(String(stderr.mock.calls[0][0])).toContain('did NOT run');
    stderr.mockRestore();
  });

  it('never bricks the session when bash exits 127 (script not found)', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(run({ spawn: () => ({ status: 127 }) })).toBe(0);
    expect(String(stderr.mock.calls[0][0])).toContain('exited 127');
    stderr.mockRestore();
  });
});