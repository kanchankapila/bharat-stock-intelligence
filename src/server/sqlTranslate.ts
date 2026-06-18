/**
 * SQLite -> PostgreSQL SQL translation (Phase 3).
 *
 * A pragmatic translator for the dbAsync facade's Postgres path. It mechanises the
 * high-frequency, unambiguous conversions so the 477-site migration is mostly a
 * find/replace of the call API, not the SQL. It is NOT a full transpiler:
 *
 *   - INSERT OR REPLACE  -> left as-is on purpose (no generic conflict target exists);
 *                           Postgres will error, forcing an explicit ON CONFLICT in P3e.
 *   - strftime(...)      -> left as-is; convert per-call where it appears.
 *   - complex json paths -> only single/dotted json_extract is handled.
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

function mapSqliteFunctions(sql: string): string {
  let s = sql;

  // datetime('now' [, '<modifier>']) -> now()  /  (now() + interval '<modifier>')
  s = s.replace(/datetime\(\s*'now'\s*\)/gi, 'now()');
  s = s.replace(/datetime\(\s*'now'\s*,\s*'([^']+)'\s*\)/gi, (_m, mod) => `(now() + interval '${mod}')`);

  // date('now' [, '<modifier>']) -> current_date / ((current_date + interval '<mod>')::date)
  s = s.replace(/date\(\s*'now'\s*\)/gi, 'current_date');
  s = s.replace(/date\(\s*'now'\s*,\s*'([^']+)'\s*\)/gi, (_m, mod) => `((current_date + interval '${mod}')::date)`);

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

/** Full translation: function/syntax mapping, then placeholder conversion. */
export function translateSql(sql: string): string {
  return convertPlaceholders(mapSqliteFunctions(sql));
}
