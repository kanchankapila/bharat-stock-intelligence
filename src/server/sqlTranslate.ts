/**
 * SQLite -> PostgreSQL SQL translation (Phase 3).
 *
 * A pragmatic translator for the dbAsync facade's Postgres path. It mechanises the
 * high-frequency, unambiguous conversions so the 477-site migration is mostly a
 * find/replace of the call API, not the SQL. It is NOT a full transpiler:
 *
 *   - INSERT OR REPLACE  -> rejected loudly at translate time (see below); no generic
 *                           conflict target exists, so this must become an explicit
 *                           ON CONFLICT at the call site, not something this file guesses.
 *   - strftime(...)      -> left as-is; convert per-call where it appears.
 *   - complex json paths -> only single/dotted json_extract is handled.
 *
 * date('now'[, mod]) -> `current_date::text` is a DELIBERATE, NOT universally correct,
 * choice: most `date`/`signal_date` columns in this schema are TEXT (migrated from
 * SQLite), so the ::text cast is required there — but a handful of tables use native
 * Postgres DATE (e.g. `stock_ohlcv.date`, `feature_store.date`). Comparing a native DATE
 * column against this ::text output raises `operator does not exist: date >= text`; the
 * existing convention at those call sites is to cast the *column* side to ::text too
 * (`date::text >= date('now', ...)`) rather than changing this function's default, since
 * the majority (TEXT) case would break instead. Check the column's real type via
 * `information_schema.columns` or `db/schema.postgres.sql` before trusting either side —
 * `db.ts`'s SQLite schema-of-record shows everything as TEXT and is not authoritative for
 * this. See CLAUDE.md's "date('now')" / column-type-blind-SQL-fix incident notes for the
 * history of bugs this exact ambiguity has caused. The Python port of this file
 * (`sql_translate.py`) has the *opposite* default (bare `current_date`, no cast) because
 * the majority of its own callers target native-DATE tables — the two are not equivalent
 * translators and neither default is "the fix" for the other's callers.
 *
 * Everything it does handle is covered by sqlTranslate.test.ts.
 */

/** Replace `?` placeholders with `$1,$2,...`, skipping any inside string/identifier literals. */
export function convertPlaceholders(sql: string): string {
  let out = '';
  let n = 1;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    // Skip `-- ...` line comments entirely (outside a string) before quote-tracking sees
    // them. Without this, a stray apostrophe in a natural-language SQL comment (e.g.
    // "wasn't", "500'd the endpoint") toggles `inSingle` just like a real string-literal
    // quote would, desyncing quote state for the rest of the query and silently leaving
    // every subsequent `?` unconverted -- a real bug hit live 2026-07-18 via a comment in
    // commandCenter.router.ts, not a hypothetical.
    if (!inSingle && !inDouble && ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? sql.length : nl;
      out += sql.slice(i, end);
      i = end - 1;
      continue;
    }
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (ch === '?' && !inSingle && !inDouble) {
      out += '$' + n++;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Postgres has no ROUND(double precision, int) — only ROUND(numeric, int). SQLite's
 * numeric columns are typeless so ROUND(AVG(x), 1) works there. Rewrite the 2-arg
 * integer-precision form to ROUND((<value>)::numeric, n) for PG. Paren-aware so nested
 * commas (e.g. COALESCE(x, 0)) don't confuse the split.
 */
function castRoundNumeric(sql: string): string {
  const lower = sql.toLowerCase();
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const idx = lower.indexOf('round(', i);
    if (idx === -1) { out += sql.slice(i); break; }
    const prev = idx > 0 ? sql[idx - 1] : ' ';
    if (/[A-Za-z0-9_]/.test(prev)) { out += sql.slice(i, idx + 6); i = idx + 6; continue; }

    out += sql.slice(i, idx);
    const open = idx + 5;            // index of '('
    let depth = 0, j = open;
    const topCommas: number[] = [];
    for (; j < sql.length; j++) {
      const c = sql[j];
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) break; }
      else if (c === ',' && depth === 1) topCommas.push(j);
    }
    if (topCommas.length >= 1 && j < sql.length) {
      const lastComma = topCommas[topCommas.length - 1];
      const precision = sql.slice(lastComma + 1, j).trim();
      if (/^\d+$/.test(precision)) {
        const valueExpr = sql.slice(open + 1, lastComma);
        out += `round((${valueExpr})::numeric, ${precision})`;
        i = j + 1;
        continue;
      }
    }
    out += sql.slice(idx, j + 1);    // not a 2-arg integer round — leave as-is
    i = j + 1;
  }
  return out;
}

function mapSqliteFunctions(sql: string): string {
  let s = castRoundNumeric(sql);

  // datetime('now' [, '<modifier>']) -> now()  /  (now() + interval '<modifier>')
  s = s.replace(/datetime\(\s*'now'\s*\)/gi, 'now()');
  s = s.replace(/datetime\(\s*'now'\s*,\s*'([^']+)'\s*\)/gi, (_m, mod) => `(now() + interval '${mod}')`);

  // date('now' [, '<modifier>']) -> current_date::text / ((current_date + interval '<mod>')::date)::text
  // The ::text cast is essential: date/signal_date columns are stored as TEXT (migrated from SQLite),
  // so PG refuses `TEXT >= date` without it. Both the 'now' form and the modifier form must output
  // TEXT to match the column type used in WHERE date >= date('now','-N days') comparisons.
  s = s.replace(/date\(\s*'now'\s*\)/gi, 'current_date::text');
  s = s.replace(/date\(\s*'now'\s*,\s*'([^']+)'\s*\)/gi, (_m, mod) => `((current_date + interval '${mod}')::date)::text`);
  // date(<column/expr>) -> (<expr>)::date  (must run AFTER the 'now' forms; skip quoted args)
  s = s.replace(/\bdate\(\s*([^'")][^)]*?)\s*\)/gi, '($1)::date');

  // julianday: SQLite-only. julianday('now') - julianday(col) is a day difference.
  // Map julianday('now') -> current_date and julianday(col) -> (col)::date, so the
  // surrounding subtraction becomes Postgres date arithmetic (integer days).
  s = s.replace(/\bjulianday\(\s*'now'\s*\)/gi, 'current_date');
  s = s.replace(/\bjulianday\(\s*([^'")][^)]*?)\s*\)/gi, '($1)::date');

  // IFNULL -> COALESCE
  s = s.replace(/\bIFNULL\s*\(/gi, 'COALESCE(');

  // INSTR(a, b) -> position(b in a)   (argument order swaps)
  s = s.replace(/\bINSTR\s*\(\s*([^,()]+?)\s*,\s*([^,()]+?)\s*\)/gi, 'position($2 in $1)');

  // group_concat(x [, sep]) -> string_agg(x::text, sep|',')
  s = s.replace(/\bGROUP_CONCAT\s*\(\s*([^,()]+?)\s*,\s*('[^']*')\s*\)/gi, 'string_agg($1::text, $2)');
  s = s.replace(/\bGROUP_CONCAT\s*\(\s*([^,()]+?)\s*\)/gi, "string_agg($1::text, ',')");

  // json_extract(col, '$.a.b') -> (col::jsonb #>> '{a,b}') ; single key -> (col::jsonb ->> 'a')
  s = s.replace(/\bjson_extract\s*\(\s*([^,]+?)\s*,\s*'\$\.([^']+)'\s*\)/gi, (_m, col, path) => {
    const parts = String(path).split('.');
    return parts.length === 1
      ? `(${col}::jsonb ->> '${parts[0]}')`
      : `(${col}::jsonb #>> '{${parts.join(',')}}')`;
  });

  // CAST(x AS REAL|INTEGER|TEXT) -> Postgres types
  s = s.replace(/CAST\s*\(([^)]+?)\s+AS\s+REAL\s*\)/gi, 'CAST($1 AS double precision)');
  s = s.replace(/CAST\s*\(([^)]+?)\s+AS\s+INTEGER\s*\)/gi, 'CAST($1 AS bigint)');

  // INSERT OR IGNORE -> INSERT ... ON CONFLICT DO NOTHING (only if not already present)
  if (/\bINSERT\s+OR\s+IGNORE\b/i.test(s)) {
    s = s.replace(/\bINSERT\s+OR\s+IGNORE\b/gi, 'INSERT');
    if (!/ON\s+CONFLICT/i.test(s)) {
      s = s.replace(/;?\s*$/, ' ON CONFLICT DO NOTHING');
    }
  }

  return s;
}

/**
 * Reject SQLite constructs this translator deliberately does not map, so a bad call site
 * fails loudly and immediately (a clear dev-time error) instead of reaching Postgres as a
 * confusing raw syntax error, or silently doing the wrong thing.
 */
function assertTranslatable(sql: string): void {
  if (/\bINSERT\s+OR\s+REPLACE\b/i.test(sql)) {
    throw new Error(
      'sqlTranslate: INSERT OR REPLACE has no generic Postgres translation (no single ' +
      'conflict target to infer). Rewrite the call site as an explicit ' +
      'INSERT ... ON CONFLICT (<key columns>) DO UPDATE SET ... — see the signals.router.ts ' +
      'getSignalHistory upsert for a worked example.'
    );
  }
}

// translateSql() is a pure function of its input, called on every query on the hot request
// path for SQL that is static per call site (only bound parameters vary) — cache the result
// instead of re-running the full regex pipeline every time. Unbounded in practice: distinct
// call-site SQL strings in this codebase number in the hundreds, not per-request.
const translateCache = new Map<string, string>();

/** Full translation: function/syntax mapping, then placeholder conversion. Memoized. */
export function translateSql(sql: string): string {
  const cached = translateCache.get(sql);
  if (cached !== undefined) return cached;
  assertTranslatable(sql);
  const out = convertPlaceholders(mapSqliteFunctions(sql));
  translateCache.set(sql, out);
  return out;
}

/**
 * Strip PostgreSQL-style `::typename` casts from SQL so it can be passed to SQLite,
 * which does not understand that syntax. Called on the SQLite path in dbAsync.ts.
 *
 * Examples:
 *   `?::timestamptz`   -> `?`
 *   `current_date::text` -> `current_date`
 *   `(col::jsonb ->> 'k')` -> `(col ->> 'k')`  (jsonb stripped too)
 *
 * The regex matches `::` followed by an optional `[]` array suffix (e.g. `::text[]`).
 * It does NOT touch `::` inside string literals (extremely rare in practice).
 */
export function stripPgCasts(sql: string): string {
  // Match :: followed by a pg type name (letters, digits, underscore) with optional []
  // array suffix. Does NOT include space so that operators like ->> after a ::jsonb cast
  // retain their separating whitespace.
  return sql.replace(/::[A-Za-z][A-Za-z0-9_]*(?:\[\])?/g, '');
}
