import { describe, expect, it } from 'vitest';
import { sanitizeMarkdownWithCode } from '../telegramService';

describe('data-integrity message formatting', () => {
  it('preserves commands inside code spans while sanitizing surrounding text', () => {
    const text = sanitizeMarkdownWithCode('Bad_table: run `python scripts/repair/repair_unadjusted_splits.py` before [review].');
    expect(text).toContain('`python scripts/repair/repair_unadjusted_splits.py`');
    expect(text).not.toContain('Bad_table');
    expect(text).not.toContain('[review]');
  });
});
