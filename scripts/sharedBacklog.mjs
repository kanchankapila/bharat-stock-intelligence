import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const LEDGER = 'docs/audit-findings.md';
export const ENTRYPOINTS = ['AGENTS.md', 'CLAUDE.md', '.clinerules/01-project.md', '.cursor/rules/project.mdc', '.github/copilot-instructions.md'];
const SKIP = new Set(['node_modules', '.git', 'venv', '.venv', '__pycache__', 'worktrees', 'screenshots', 'dist', 'build']);

export function collectFiles(root) {
  const files = new Map();
  function walk(relative) {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      if (SKIP.has(entry.name) || entry.isSymbolicLink()) continue;
      const name = [relative, entry.name].filter(Boolean).join('/');
      if (entry.isDirectory()) walk(name);
      else if (/\.(?:md|mdc|ts|tsx|py|mjs|cjs)$/.test(name)) files.set(name, readFileSync(join(root, name), 'utf8'));
    }
  }
  for (const dir of ['docs', 'src', 'scripts', '.agents', '.claude', '.clinerules', '.cursor', '.github']) {
    if (existsSync(join(root, dir))) walk(dir);
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && /\.(?:md|ts|cjs)$/.test(entry.name)) files.set(entry.name, readFileSync(join(root, entry.name), 'utf8'));
  }
  return files;
}

export function markerKey(file, text) {
  return `${file}#${createHash('sha256').update(text.trim()).digest('hex').slice(0, 10)}`;
}

export function sourceMarkers(files) {
  const markers = [];
  for (const [file, text] of files) {
    if (!/^(?:src|scripts)\//.test(file) || !/\.(?:ts|tsx|py|mjs|cjs)$/.test(file)
      || /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\./.test(file)) continue;
    text.split(/\r?\n/).forEach((line, i) => {
      if (/(?:\/\/|#|\/\*|<!--).*\b(?:TODO|FIXME|ponytail):|^\s*(?:\*\s*)?(?:TODO|FIXME|ponytail):/i.test(line)) {
        markers.push({ file, line: i + 1, text: line.trim(), key: markerKey(file, line) });
      }
    });
  }
  return markers;
}

export function uncheckedItems(files) {
  const items = [];
  for (const [file, text] of files) {
    if (file === LEDGER || !/\.(?:md|mdc)$/.test(file)) continue;
    let fence = null;
    text.split(/\r?\n/).forEach((line, i) => {
      const delimiter = line.match(/^\s*(`{3,}|~{3,})/);
      if (delimiter) { if (!fence) fence = delimiter[1][0]; else if (delimiter[1][0] === fence) fence = null; return; }
      if (!fence && /^\s*[-*]\s+\[ \]/.test(line)) items.push({ file, line: i + 1, text: line.trim(), key: markerKey(file, line) });
    });
  }
  return items;
}

export function validateSharedBacklog(files) {
  const errors = [];
  const ledger = files.get(LEDGER);
  if (!ledger?.trim()) return ['Missing authoritative ledger: docs/audit-findings.md'];
  const ids = new Set([...ledger.matchAll(/^\|\s*(AF-\d{8}-\d+)\s*\|/gm)].map(m => m[1]));
  for (const file of ENTRYPOINTS) {
    if (!files.get(file)?.includes(LEDGER)) errors.push(`${file}: missing pointer to ${LEDGER}`);
  }
  const registered = new Map();
  for (const m of ledger.matchAll(/<!-- backlog-source: ([^\s]+) (AF-\d{8}-\d+) -->/g)) {
    if (!ids.has(m[2])) errors.push(`${m[1]}: unknown finding ${m[2]}`);
    if (registered.has(m[1])) errors.push(`${m[1]}: duplicate source registration`);
    registered.set(m[1], m[2]);
  }
  for (const marker of sourceMarkers(files)) {
    if (!registered.has(marker.key)) errors.push(`${marker.file}:${marker.line}: unregistered source marker ${marker.key}`);
  }
  const templates = new Set();
  for (const m of ledger.matchAll(/<!-- backlog-checklist: ([^\s]+) (AF-\d{8}-\d+) -->/g)) {
    if (!ids.has(m[2])) errors.push(`${m[1]}: unknown finding ${m[2]}`);
    templates.add(m[1]);
  }
  for (const item of uncheckedItems(files)) {
    if (!templates.has(item.key)) errors.push(`${item.file}:${item.line}: unchecked work item outside ${LEDGER}`);
  }
  for (const [file, text] of files) {
    if (file === LEDGER || !/\.(?:md|mdc)$/.test(file)) continue;
    let fence = null;
    text.split(/\r?\n/).forEach((line, i) => {
      const delimiter = line.match(/^\s*(`{3,}|~{3,})/);
      if (delimiter) { if (!fence) fence = delimiter[1][0]; else if (delimiter[1][0] === fence) fence = null; return; }
      if (fence) return;
      if (/^\|.*\|\s*(?:Remediation state|Backlog status)\s*\|/i.test(line)) errors.push(`${file}:${i + 1}: parallel status matrix`);
    });
  }
  return errors;
}
