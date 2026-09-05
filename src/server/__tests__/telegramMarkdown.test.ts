import { describe, it, expect } from 'vitest';
import { balanceMarkdownEntities } from '../telegramService';

/**
 * Telegram's legacy Markdown parser rejects a message containing an UNTERMINATED entity with
 * HTTP 400 "can't parse entities: Can't find end of the entity starting at byte offset N".
 *
 * This fires on real production content, not on exotic input. Live 2026-09-05 14:08:08, the
 * ml-daily-ops completion notice read `19 ok, 1 failed: analyst_revision` -- one underscore,
 * which legacy Markdown reads as the start of an italic run that never closes. Every job step,
 * table and script name in this platform is snake_case, so any notification naming one is a
 * coin flip on whether the underscore count happens to be even.
 *
 * The existing plain-text retry means nothing is ever LOST, so this is not a delivery bug --
 * it is a permanent error-level log line plus the silent loss of all formatting in exactly the
 * messages that report failures, which are the ones worth reading.
 *
 * The fix escapes a delimiter only when its count is ODD, so deliberate formatting (`*bold*`,
 * a balanced `_italic_`) is preserved and only the genuinely broken cases are neutralised.
 */
describe('balanceMarkdownEntities', () => {
  it('escapes a lone underscore that would open an entity and never close it', () => {
    // The exact live payload that produced the 2026-09-05 400.
    const out = balanceMarkdownEntities('ml-daily-ops: 19 ok, 1 failed: analyst_revision');
    expect(out).toBe('ml-daily-ops: 19 ok, 1 failed: analyst\\_revision');
  });

  it('leaves balanced formatting alone', () => {
    expect(balanceMarkdownEntities('*Daily Digest*')).toBe('*Daily Digest*');
    expect(balanceMarkdownEntities('_emphasis_ here')).toBe('_emphasis_ here');
    expect(balanceMarkdownEntities('`code`')).toBe('`code`');
  });

  it('escapes every occurrence when the count is odd, not just the last one', () => {
    // Two snake_case names = 2 underscores = balanced by luck, and Telegram would render
    // "ensemble.py failed: analyst" as italic. Three is a parse error. Both are wrong, but
    // only the odd case breaks delivery, and that is the one this must catch.
    const out = balanceMarkdownEntities('a_b c_d e_f');
    expect(out).toBe('a\\_b c\\_d e\\_f');
  });

  it('treats each delimiter independently', () => {
    const out = balanceMarkdownEntities('*bold* with one_underscore');
    expect(out).toBe('*bold* with one\\_underscore');
  });

  it('does not double-escape an already-escaped delimiter', () => {
    expect(balanceMarkdownEntities('already\\_escaped')).toBe('already\\_escaped');
  });

  it('escapes an unmatched link bracket', () => {
    expect(balanceMarkdownEntities('see [the report')).toBe('see \\[the report');
    expect(balanceMarkdownEntities('see [the report](http://x)')).toBe('see [the report](http://x)');
  });

  it('handles a triple-backtick block without mangling the single-backtick count', () => {
    expect(balanceMarkdownEntities('```\nsome code\n```')).toBe('```\nsome code\n```');
  });

  it('is a no-op on text with no delimiters at all', () => {
    expect(balanceMarkdownEntities('plain text, 19 ok')).toBe('plain text, 19 ok');
  });

  it('never returns text that still has an odd count of any delimiter', () => {
    // Property check across the shapes this platform actually emits.
    const samples = [
      'ml-daily-ops: 19 ok, 1 failed: analyst_revision',
      '*Digest* — so_option_chain, mc_earnings_forecast, index_membership',
      'a_b_c_d_e',
      '`unterminated code',
      '*bold _mixed* trailing_',
    ];
    for (const s of samples) {
      const out = balanceMarkdownEntities(s);
      for (const d of ['_', '*', '`']) {
        const unescaped = (out.match(new RegExp(`(^|[^\\\\])\\${d}`, 'g')) || []).length;
        expect(unescaped % 2, `delimiter ${d} left unbalanced in ${JSON.stringify(out)}`).toBe(0);
      }
    }
  });
});
