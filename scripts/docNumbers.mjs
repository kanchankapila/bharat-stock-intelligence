/**
 * Re-derive every inventory number quoted in CLAUDE.md / CONTEXT.md / AGENTS.md.
 *
 * Why this exists: those files carried hand-copied counts ("~210 Python modules",
 * "81 fetchers", "830 templates", "~140 server files") that silently went stale as the
 * repo grew -- the exact failure CLAUDE.md's own "Read first" section warns about when
 * it retired three duplicate trackers. A number nobody can re-derive is a number
 * nobody should trust. This script makes each one reproducible in one command.
 *
 * Usage:  node scripts/docNumbers.mjs            # human-readable report
 *         node scripts/docNumbers.mjs --check    # exit 1 if a doc is stale (for CI)
 *
 * FS-derived figures need no database. The Postgres figures are read through the
 * repo's own read-only helper and reported as "unavailable" if it cannot connect --
 * never guessed, because a fabricated count is worse than a missing one.
 */
import { readdirSync, statSync, existsSync, readFileSync } from 'fs';
import { join, extname, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');

/** Recursively collect files under `dir`, skipping noise dirs. */
function walk(dir, exts, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '__pycache__', '.pytest_cache', 'dist', '.claude'].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, exts, out);
    else if (exts.has(extname(e.name))) out.push(p);
  }
  return out;
}

const isTestPath = (p) => /(__tests__|[\\/]tests?[\\/])/.test(p);
const isTestName = (p) => /(^|[\\/])(test_[^\\/]+|conftest)\.py$/.test(p);

const py = walk(join(ROOT, 'src', 'server'), new Set(['.py']));
const pyNonTest = py.filter((p) => !isTestPath(p) && !isTestName(p));
const fetchers = pyNonTest.filter((p) => p.endsWith('_fetcher.py'));
const tsAll = walk(join(ROOT, 'src'), new Set(['.ts', '.tsx']));
const tsServer = walk(join(ROOT, 'src', 'server'), new Set(['.ts']));
const routers = readdirSync(join(ROOT, 'src', 'server', 'routers')).filter((f) => f.endsWith('.ts'));
const rules = readdirSync(join(ROOT, '.claude', 'rules')).filter((f) => f.endsWith('.md'));
const rulesBytes = rules.reduce((n, f) => n + statSync(join(ROOT, '.claude', 'rules', f)).size, 0);

// jobRegistry entries: count only the `jobName:` keys inside the registry array. A repo-wide
// match also counts JobRegistryEntry.jobName in the interface and overstated the inventory by 1.
const registrySrc = readFileSync(join(ROOT, 'src', 'server', 'jobRegistry.ts'), 'utf8');
const registryStart = registrySrc.indexOf('export const JOB_REGISTRY');
const registryEnd = registrySrc.indexOf('];', registryStart);
const registryBlock = registryStart >= 0 && registryEnd >= 0
  ? registrySrc.slice(registryStart, registryEnd + 2)
  : '';
const jobRegistry = (registryBlock.match(/jobName:/g) || []).length;

// Raw console.* call sites under src/server (the logger.ts shim's blast radius).
let consoleSites = 0;
for (const f of tsServer) {
  consoleSites += (readFileSync(f, 'utf8').match(/console\.(log|info|warn|error|debug)\(/g) || []).length;
}

// unique_urls.txt is a static corpus in the repo root.
const urlsFile = join(ROOT, 'unique_urls.txt');
const uniqueUrls = existsSync(urlsFile)
  ? readFileSync(urlsFile, 'utf8').split(/\r?\n/).filter((l) => l.trim()).length
  : null;

/** Read-only Postgres figure. Returns null (never a guess) if unavailable. */
function dbScalar(sql) {
  const candidates = [
    [join(ROOT, 'backend-python', 'venv', 'Scripts', 'python.exe'), join(ROOT, 'scripts', 'sql.py')],
    [join(ROOT, 'backend-python', 'venv', 'bin', 'python'), join(ROOT, 'scripts', 'sql.py')],
  ];
  for (const [pyExe, script] of candidates) {
    if (!existsSync(pyExe)) continue;
    try {
      const out = execFileSync(pyExe, [script, sql], {
        cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000,
      });
      const m = out.match(/^\s*(\d+)\s*$/m);
      if (m) return Number(m[1]);
    } catch { /* try the next interpreter */ }
  }
  return null;
}

const registryTotal = dbScalar('SELECT count(*)::text FROM market_endpoint_registry');
const registryGet = dbScalar("SELECT count(*)::text FROM market_endpoint_registry WHERE http_method = 'GET'");
const registryPost = dbScalar("SELECT count(*)::text FROM market_endpoint_registry WHERE http_method = 'POST'");
const urlEndpoints = dbScalar('SELECT count(*)::text FROM url_endpoints');

const figures = [
  ['Python modules in src/server (non-test)', pyNonTest.length, 'CLAUDE.md intro'],
  ['Python .py files in src/server (incl. tests)', py.length, 'CLAUDE.md intro'],
  ['*_fetcher.py (non-test)', fetchers.length, 'CLAUDE.md intro / CONTEXT.md'],
  ['.ts/.tsx under src', tsAll.length, '-'],
  ['.ts under src/server', tsServer.length, 'logger.ts comment'],
  ['tRPC routers', routers.length, '-'],
  ['JOB_REGISTRY entries', jobRegistry, 'CONTEXT.md'],
  ['rule files', rules.length, 'CLAUDE.md rules section'],
  ['rule files total size (KB)', (rulesBytes / 1024).toFixed(1), 'CLAUDE.md rules section'],
  ['raw console.* call sites in src/server', consoleSites, 'logger.ts comment'],
  ['unique_urls.txt URLs', uniqueUrls, 'CLAUDE.md / DATA_SOURCE_INTEGRATION_GUIDE.md'],
  ['market_endpoint_registry rows', registryTotal, 'CLAUDE.md / CONTEXT.md'],
  ['  ...GET', registryGet, 'CLAUDE.md'],
  ['  ...POST', registryPost, 'CLAUDE.md'],
  ['url_endpoints rows (= distinct templates)', urlEndpoints, 'CLAUDE.md'],
];

console.log('Inventory numbers re-derived ' + new Date().toISOString().slice(0, 10) + '\n');
for (const [label, value, where] of figures) {
  const shown = value === null ? 'unavailable (no DB)' : String(value);
  console.log(`  ${label.padEnd(44)} ${shown.padStart(10)}   [${where}]`);
}


// --check: assert the doc files quote the numbers we just re-derived. Exits 1 on drift.
// Only FS-derived figures are asserted; DB figures are skipped when Postgres is
// unreachable so a developer without a running database still gets a useful check.
if (CHECK) {
  const claude = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');
  const context = readFileSync(join(ROOT, 'CONTEXT.md'), 'utf8');
  const stale = [];
  const expect = (hay, needle, label) => {
    if (needle !== null && !hay.includes(needle)) stale.push(`${label}: expected "${needle}"`);
  };
  expect(claude, String(pyNonTest.length), 'CLAUDE.md non-test Python module count');
  expect(claude, String(fetchers.length), 'CLAUDE.md fetcher count');
  expect(context, String(fetchers.length), 'CONTEXT.md fetcher count');
  expect(context, String(jobRegistry), 'CONTEXT.md JOB_REGISTRY entries');
  // The console.* count is quoted in logger.ts (and mirrored in server.ts), not CLAUDE.md.
  const loggerSrc = readFileSync(join(ROOT, 'src', 'server', 'logger.ts'), 'utf8');
  expect(loggerSrc, String(consoleSites), 'logger.ts console.* call-site count');
  // The registry method split is written with thousands separators ("2,864 GET / 544 POST"),
  // so match the grouped form rather than the bare integer.
  if (registryGet !== null) {
    const grouped = (n) => n.toLocaleString('en-US');
    expect(claude, `${grouped(registryGet)} GET / ${registryPost} POST`, 'CLAUDE.md registry method split');
    expect(claude, grouped(registryTotal), 'CLAUDE.md registry total');
  }
  expect(claude, String(urlEndpoints), 'CLAUDE.md url_endpoints count');

  if (stale.length) {
    console.error('\nSTALE DOC NUMBERS:\n  ' + stale.join('\n  ') +
      '\n\nUpdate each quoted figure to the re-derived value above, or fix the doc if it is correct.');
    process.exit(1);
  }
  console.log('\nAll checked doc numbers match the re-derived values.');
}
