import { describe, it, expect } from 'vitest';
import { convertPlaceholders, translateSql } from '../sqlTranslate';

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
});

describe('translateSql function mapping', () => {
  it('maps datetime(now) and modifiers', () => {
    expect(translateSql("SELECT datetime('now')")).toBe('SELECT now()');
    expect(translateSql("WHERE d < datetime('now', '-30 days')"))
      .toBe("WHERE d < (now() + interval '-30 days')");
  });
  it('maps date(now)', () => {
    expect(translateSql("WHERE d = date('now')")).toBe('WHERE d = current_date');
  });
  it('maps date(column) to ::date cast', () => {
    expect(translateSql('WHERE date(cs.computed_at) = ?')).toBe('WHERE (cs.computed_at)::date = $1');
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
  it('maps CAST REAL -> double precision and group_concat -> string_agg', () => {
    expect(translateSql('SELECT CAST(x AS REAL) FROM t')).toBe('SELECT CAST(x AS double precision) FROM t');
    expect(translateSql('SELECT GROUP_CONCAT(sym) FROM t')).toBe("SELECT string_agg(sym::text, ',') FROM t");
  });
});
