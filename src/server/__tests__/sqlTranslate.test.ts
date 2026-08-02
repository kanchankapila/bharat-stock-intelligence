import { describe, it, expect } from 'vitest';
import { convertPlaceholders, translateSql, stripPgCasts } from '../sqlTranslate';

describe('convertPlaceholders', () => {
  it('numbers positional placeholders', () => {
    expect(convertPlaceholders('SELECT * FROM t WHERE a=? AND b=?'))
      .toBe('SELECT * FROM t WHERE a=$1 AND b=$2');
  });
  it('ignores ? inside string literals', () => {
    expect(convertPlaceholders("SELECT '?' AS q, a=? FROM t"))
      .toBe("SELECT '?' AS q, a=$1 FROM t");
  });
  it('ignores ? inside double-quoted identifiers', () => {
    expect(convertPlaceholders('SELECT "we?rd" FROM t WHERE a=?'))
      .toBe('SELECT "we?rd" FROM t WHERE a=$1');
  });
  it('does not let an apostrophe inside a -- comment desync quote-tracking', () => {
    // A stray apostrophe in a natural-language comment (contractions, possessives) used to
    // toggle inSingle just like a real string-literal quote, leaving every subsequent `?`
    // unconverted — hit live 2026-07-18 in commandCenter.router.ts's getBuyRecommendations.
    const sql = `SELECT a\n-- this wasn't obvious, 500'd the endpoint\nFROM t WHERE a=? AND b=?`;
    expect(convertPlaceholders(sql)).toBe(
      `SELECT a\n-- this wasn't obvious, 500'd the endpoint\nFROM t WHERE a=$1 AND b=$2`,
    );
  });
  it('handles multiple -- comments each with their own apostrophe', () => {
    const sql = `-- won't happen\nSELECT a FROM t\n-- can't skip\nWHERE a=?`;
    expect(convertPlaceholders(sql)).toBe(
      `-- won't happen\nSELECT a FROM t\n-- can't skip\nWHERE a=$1`,
    );
  });
});

describe('translateSql function mapping', () => {
  it('maps datetime(now) and modifiers', () => {
    expect(translateSql("SELECT datetime('now')")).toBe('SELECT now()');
    expect(translateSql("WHERE d < datetime('now', '-30 days')"))
      .toBe("WHERE d < (now() + interval '-30 days')");
  });
  it('maps date(now)', () => {
    // ::text is required: date/signal_date columns are TEXT in PG (migrated from SQLite);
    // PG refuses `TEXT >= date` without the cast.
    expect(translateSql("WHERE d = date('now')")).toBe('WHERE d = current_date::text');
  });
  it('maps date(now, modifier) to ::text so TEXT columns compare correctly', () => {
    expect(translateSql("WHERE date >= date('now', '-3 days')"))
      .toBe("WHERE date >= ((current_date + interval '-3 days')::date)::text");
  });
  it('maps date(column) to ::date cast', () => {
    expect(translateSql('WHERE date(cs.computed_at) = ?')).toBe('WHERE (cs.computed_at)::date = $1');
  });
  it('maps julianday day-difference to date arithmetic', () => {
    expect(translateSql("AVG(julianday('now') - julianday(date))"))
      .toBe('AVG(current_date - (date)::date)');
  });
  it('maps IFNULL -> COALESCE', () => {
    expect(translateSql('SELECT IFNULL(a, 0) FROM t')).toBe('SELECT COALESCE(a, 0) FROM t');
  });
  it('maps INSERT OR IGNORE -> ON CONFLICT DO NOTHING', () => {
    expect(translateSql('INSERT OR IGNORE INTO t (a) VALUES (?)'))
      .toBe('INSERT INTO t (a) VALUES ($1) ON CONFLICT DO NOTHING');
  });
  it('maps json_extract single and nested', () => {
    expect(translateSql("SELECT json_extract(meta, '$.k') FROM t"))
      .toBe("SELECT (meta::jsonb ->> 'k') FROM t");
    expect(translateSql("SELECT json_extract(meta, '$.a.b') FROM t"))
      .toBe("SELECT (meta::jsonb #>> '{a,b}') FROM t");
  });
  it('casts ROUND(2-arg) value to numeric, paren-aware', () => {
    expect(translateSql('SELECT ROUND(AVG(score), 1) FROM t'))
      .toBe('SELECT round((AVG(score))::numeric, 1) FROM t');
    // nested comma inside COALESCE must not be mistaken for the precision arg
    expect(translateSql('SELECT ROUND(COALESCE(x, 0) + 0.2, 3) FROM t'))
      .toBe('SELECT round((COALESCE(x, 0) + 0.2)::numeric, 3) FROM t');
    // single-arg ROUND left untouched
    expect(translateSql('SELECT ROUND(x) FROM t')).toBe('SELECT ROUND(x) FROM t');
  });

  it('maps CAST REAL -> double precision and group_concat -> string_agg', () => {
    expect(translateSql('SELECT CAST(x AS REAL) FROM t')).toBe('SELECT CAST(x AS double precision) FROM t');
    expect(translateSql('SELECT GROUP_CONCAT(sym) FROM t')).toBe("SELECT string_agg(sym::text, ',') FROM t");
  });
});

describe('translateSql: INSERT OR REPLACE rejection', () => {
  it('throws instead of silently passing an untranslatable construct to Postgres', () => {
    expect(() => translateSql('INSERT OR REPLACE INTO t (a) VALUES (?)')).toThrow(
      /INSERT OR REPLACE/
    );
  });
  it('leaves INSERT OR IGNORE alone (that one IS translated)', () => {
    expect(() => translateSql('INSERT OR IGNORE INTO t (a) VALUES (?)')).not.toThrow();
  });
});

describe('translateSql: memoization', () => {
  it('is a pure cache — repeated calls with the same input return the same output', () => {
    const sql = "SELECT * FROM t WHERE d = date('now') AND a = ?";
    const first = translateSql(sql);
    const second = translateSql(sql);
    expect(second).toBe(first);
    expect(second).toBe("SELECT * FROM t WHERE d = current_date::text AND a = $1");
  });
  it('does not cross-contaminate between distinct SQL strings', () => {
    expect(translateSql('SELECT a FROM t WHERE x = ?')).toBe('SELECT a FROM t WHERE x = $1');
    expect(translateSql('SELECT b FROM t WHERE y = ?')).toBe('SELECT b FROM t WHERE y = $1');
    expect(translateSql('SELECT a FROM t WHERE x = ?')).toBe('SELECT a FROM t WHERE x = $1');
  });
});

describe('stripPgCasts', () => {
  it('strips simple ::type casts from bound parameters', () => {
    expect(stripPgCasts('VALUES (?, ?::timestamptz, ?)')).toBe('VALUES (?, ?, ?)');
  });
  it('strips ::text casts produced by translateSql date mapping', () => {
    expect(stripPgCasts('WHERE d = current_date::text')).toBe('WHERE d = current_date');
  });
  it('strips ::numeric and ::date casts', () => {
    expect(stripPgCasts('round((x)::numeric, 2)')).toBe('round((x), 2)');
    expect(stripPgCasts('WHERE (ts)::date = $1')).toBe('WHERE (ts) = $1');
  });
  it('strips ::jsonb casts', () => {
    // Space between ::jsonb and ->> is preserved (space NOT in type-name char class)
    expect(stripPgCasts("(col::jsonb ->> 'k')")).toBe("(col ->> 'k')");
  });
  it('strips ::text[] array type casts', () => {
    expect(stripPgCasts('?::text[]')).toBe('?');
  });
  it('leaves normal SQL untouched', () => {
    const sql = "SELECT * FROM t WHERE a = 'it\'s ok' AND b = ?";
    expect(stripPgCasts(sql)).toBe(sql);
  });
});
