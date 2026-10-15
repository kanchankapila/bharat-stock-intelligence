import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('weekend audit route inventory', () => {
  it('targets the live route topology and not the removed v6 shell', () => {
    const source = readFileSync(new URL('./SKILL.md', import.meta.url), 'utf8');
    expect(source).toContain('`/*` v1 shell');
    expect(source).toContain('`/tala/*`');
    expect(source).toContain('`/concept`');
    expect(source).not.toContain('screenshot **v6 first**');
  });
});
