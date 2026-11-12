#!/usr/bin/env node
// Keep LF: Vite SSR imports this CLI and does not recognize a CRLF hashbang.
// Validates docs/audit-findings.md against the "fix it, test it, in the same pass" rule
// (CLAUDE.md "Resolve findings, don't just log them"; added 2026-09-30 at the user's request).
//
//   node scripts/checkFindingsLedger.mjs            # exit 1 on any violation
//   node scripts/checkFindingsLedger.mjs <file>     # validate another ledger (tests use this)
//
// Enforced for rows FOUND on/after RULE_START only -- older rows predate the rule and were
// closed under the previous standard; re-judging them retroactively would flag hundreds of
// legitimate historical closes. Structure is checked for every row.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RULE_START = '2026-09-30';
// From here a FIX-lane row cannot stay open on EVIDENCE: the lane says the fix is known.
export const FIX_RULE_START = '2026-11-04';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// An artifact that can fail: a test file, a scanner/check script, or a named static check.
const ARTIFACT = /`?([\w./-]+?\.(?:test\.tsx?|test\.mjs|py|mjs|tsx?))(?![\w./-])`?|check_[a-z_]+|\bTest[A-Z]\w+|\btest_[a-z0-9_]+/g;
// The four legitimate reasons for a row to stay open (CLAUDE.md), plus a refused permission,
// which is "needs a user decision" in practice.
// "Fixed, pending the next live run/retrain" is committed-not-yet-verified-live: calendar-blocked
// on the next scheduled run, and stated as such.
const NON_EVIDENCE_REASON = /calendar[- ]blocked|needs? (?:a |the )?user|user decision|depends on|DEPENDS|(?:blocked|refused) by the auto-mode classifier|pending (?:the )?(?:next|live)/i;
// DEPLOY-PENDING: committed, waiting only on a restart or migration. Case-sensitive so the words in prose do not count.
const DEPLOY_PENDING = /\bDEPLOY-PENDING\b/;
const hasReason = (t, evidenceOk) => NON_EVIDENCE_REASON.test(t) || DEPLOY_PENDING.test(t) || (evidenceOk && /EVIDENCE/i.test(t));

const SPLIT = /(?<!\\)\|/;
const cells = line => line.split(SPLIT).slice(1, -1).map(c => c.trim());
const isSep = line => /^\|[-: |]+\|$/.test(line);
const isDate = s => /^\*{0,2}\d{4}-\d{2}-\d{2}/.test(s);

// Every directory a test or check can live in; both lookups below read this one list.
const TEST_DIRS = ['src/server/tests', 'src/server/__tests__', 'src', 'scripts', 'tests', '.claude/hooks', 'bharat_alpha/tests'];
const CHECK_FILES = ['scripts/check_recurring_bugs.py', 'src/server/dataQualityChecks.ts'];

// Two lazy layers: the file LISTING (cheap, answers "does test_x.py exist") and the file
// CONTENTS (only read if a bare name like TestFoo must be resolved).
let files = null;
function testFiles() {
  if (files) return files;
  files = new Map(); // basename -> absolute path
  for (const d of TEST_DIRS) {
    const abs = resolve(ROOT, d);
    if (!existsSync(abs)) continue;
    for (const e of readdirSync(abs, { recursive: true })) {
      const rel = String(e).replace(/\\/g, '/');
      if (rel.includes('node_modules') || rel.includes('__pycache__')) continue;
      if (/(^|\/)(test_[^/]+\.py|[^/]+\.test\.(ts|tsx|mjs))$/.test(rel)) files.set(rel.split('/').pop(), resolve(abs, rel));
    }
  }
  return files;
}

let corpus = null;
// A DEFINITION, not a mention: a name that only appears in a comment or in this validator's own
// fixtures must not count as an existing test (it did, and the rejection test caught it).
function namedArtifactExists(name) {
  if (corpus === null) {
    const paths = [...CHECK_FILES.map(f => resolve(ROOT, f)).filter(p => existsSync(p)), ...testFiles().values()];
    corpus = paths.map(p => readFileSync(p, 'utf8')).join('\n');
  }
  const def = new RegExp(`(?:\\bclass|\\bdef|\\bfunction)\\s+${name}\\b|\\bid:\\s*['"]${name}['"]`);
  return def.test(corpus);
}

function artifactExists(text) {
  for (const m of text.matchAll(ARTIFACT)) {
    const tok = m[1] ?? m[0];
    if (m[1] === undefined) { // a bare name (check_x, TestX, test_x), not a file path
      if (namedArtifactExists(tok)) return true;
      continue;
    }
    if (existsSync(resolve(ROOT, tok)) || existsSync(resolve(ROOT, 'scripts', tok))) return true;
    if (testFiles().has(tok.split('/').pop())) return true;
  }
  return false;
}

export function validate(text) {
  return validateDetailed(text).problems;
}

export function validateDetailed(text) {
  const problems = [];
  const warnings = [];
  if (text.includes('\x0b')) problems.push('ledger contains a vertical-tab control character (\\x0b)');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let width = null;
  const seen = new Map();
  lines.forEach((line, i) => {
    const n = i + 1;
    if (isSep(line)) { width = cells(line).length; return; }
    if (!line.startsWith('| AF-')) {
      if (!line.startsWith('|')) width = null;
      // A data row that lost its "| AF-" prefix (a scripted edit once split a row into one cell per
      // character) was skipped here and the check stayed green: reject any other line in a ledger table.
      else if (width === 8 && !/^\|\s*ID\s*\|/.test(line)) problems.push(`L${n}: table line is not an AF- row (corrupted by a scripted edit?): ${line.slice(0, 40)}`);
      return;
    }
    const c = cells(line);
    if (width === null) { problems.push(`L${n} ${c[0]}: row is outside any table (no header/separator above it)`); return; }
    if (c.length !== width) { problems.push(`L${n} ${c[0]}: ${c.length} cells in a ${width}-column table (unescaped "|"?)`); return; }
    if (width !== 8) return; // cross-reference sub-tables
    const [id, found, , , lane, status, immunized, closed] = c;
    if (seen.has(id)) {
      // Pre-rule history restates some rows as status updates in later tables, and one real
      // collision (AF-20260823-77) exists -- report those, fail only on new duplicates.
      (found < RULE_START ? warnings : problems).push(`L${n} ${id}: duplicate ID (also L${seen.get(id)})`);
    }
    seen.set(id, n);
    if (found < RULE_START) return;
    const isClosed = isDate(closed);
    if (isClosed && /FIX/i.test(lane) && !artifactExists(immunized)) {
      problems.push(`L${n} ${id}: closed FIX row cites no existing regression test/check in "Immunized" (${immunized.slice(0, 60) || 'empty'})`);
    }
    if (!isClosed && !hasReason(`${lane} ${status}`, true)) {
      problems.push(`L${n} ${id}: open row states none of the four reasons (EVIDENCE / calendar-blocked / needs a user decision / depends on another row)`);
    } else if (!isClosed && /^FIX/i.test(lane.replace(/\*/g, "")) && !hasReason(`${lane} ${status}`, false)) {
      (found < FIX_RULE_START ? warnings : problems).push(`L${n} ${id}: open FIX row relies on EVIDENCE; a FIX row stays open only as DEPLOY-PENDING / calendar-blocked / needs a user decision / depends on another row`);
    }
  });
  return { problems, warnings };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = resolve(ROOT, process.argv[2] ?? 'docs/audit-findings.md');
  const { problems, warnings } = validateDetailed(readFileSync(file, 'utf8'));
  for (const w of warnings) console.warn(`[findings:check] warn: ${w}`);
  if (problems.length) {
    console.error(`[findings:check] ${problems.length} problem(s) in ${file}:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`[findings:check] ${file}: OK`);
}
