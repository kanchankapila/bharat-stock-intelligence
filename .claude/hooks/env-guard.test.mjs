// Negative-controlled tests for env-guard.mjs, the PreToolUse hook that requires confirmation
// before Edit/Write touches a .env* file (real production credentials live there).
import { describe, it, expect } from 'vitest';
import { decide } from './env-guard.mjs';

describe('env-guard', () => {
  it('NEGATIVE CONTROL: asks for confirmation on .env', () => {
    const out = decide('.env');
    expect(out).not.toBeNull();
    expect(out.hookSpecificOutput.permissionDecision).toBe('ask');
  });

  it('asks on a suffixed variant like .env.local', () => {
    expect(decide('.env.local').hookSpecificOutput.permissionDecision).toBe('ask');
  });

  it('asks regardless of directory depth or path separator', () => {
    expect(decide('D:\\Github\\bharat-stock-intelligence\\.env')).not.toBeNull();
    expect(decide('backend-python/.env')).not.toBeNull();
  });

  it('does not fire on an unrelated file', () => {
    expect(decide('src/server/router.ts')).toBeNull();
  });

  it('does not fire on a filename that merely contains "env"', () => {
    expect(decide('src/server/environment.ts')).toBeNull();
    expect(decide('src/data/envConfig.ts')).toBeNull();
  });
});
