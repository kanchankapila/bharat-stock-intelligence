// Guards the Claude-facing config against the two ways it has already rotted here:
//  1. .claude/rules/*.md without `paths:` frontmatter are injected into EVERY session (~77k tokens
//     until 2026-09-26), and a glob typo silently means the rule never loads at all.
//  2. AGENTS.md/CONTEXT.md named files that did not exist (5 phantom fetchers, a GPT-4o agents/openai.yaml)
//     and omitted real skills. Both lists are derived from the tree here, never hand-maintained.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { matchesGlob } from 'node:path';

const tracked = execSync('git ls-files', { encoding: 'utf8', maxBuffer: 64e6 }).split('\n').filter(Boolean);
const RULES = readdirSync('.claude/rules').filter(f => f.endsWith('.md'));

function pathsOf(file) {
  const m = readFileSync(`.claude/rules/${file}`, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m || !/^paths:/m.test(m[1])) return null;
  return [...m[1].matchAll(/^\s*-\s*"(.+)"\s*$/gm)].map(x => x[1]);
}

describe('.claude/rules are path-scoped, not always-on', () => {
  it('found the rule files (non-vacuity)', () => expect(RULES.length).toBeGreaterThanOrEqual(5));

  for (const r of RULES) {
    it(`${r} has paths: frontmatter and every glob matches a tracked file`, () => {
      const globs = pathsOf(r);
      expect(globs, `${r} has no paths: frontmatter — it will load into every session`).not.toBeNull();
      expect(globs.length).toBeGreaterThan(0);
      for (const g of globs) {
        expect(tracked.some(f => matchesGlob(f, g)), `${r}: glob matches nothing — ${g}`).toBe(true);
      }
    });
  }
});

describe('AGENTS.md / CONTEXT.md name only real things, and every real skill/command', () => {
  const docs = { 'AGENTS.md': readFileSync('AGENTS.md', 'utf8'), 'CONTEXT.md': readFileSync('CONTEXT.md', 'utf8') };

  it('every skill and command is listed in AGENTS.md', () => {
    const skills = readdirSync('.claude/skills', { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
    const commands = readdirSync('.claude/commands').filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, ''));
    const agents = readdirSync('.claude/agents').filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, ''));
    expect(skills.length + commands.length).toBeGreaterThan(10);
    const missing = [...skills, ...commands, ...agents].filter(n => !docs['AGENTS.md'].includes(`\`${n}\``));
    expect(missing, 'add these to AGENTS.md').toEqual([]);
  });

  for (const [name, text] of Object.entries(docs)) {
    it(`every file path cited in ${name} exists`, () => {
      const cited = [...text.matchAll(/`([\w.\-/]+\.(?:md|py|ts|tsx|mjs|cjs|json|sql|sh|txt|yaml))`/g)]
        .map(m => m[1])
        .filter(p => p.includes('/') || existsSync(p) || /^[A-Z_]+\.md$/.test(p) || p.includes('.'));
      expect(cited.length).toBeGreaterThan(5);
      // Bare module names (e.g. `unified_ranker.py`) resolve under src/server/.
      const missing = cited.filter(p => !existsSync(p) && !existsSync(`src/server/${p}`) && !existsSync(`.claude/rules/${p}`)
        && !existsSync(`.claude/hooks/${p}`));
      expect(missing, `${name} cites files that do not exist`).toEqual([]);
    });
  }
});
