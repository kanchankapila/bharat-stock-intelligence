// PreToolUse(Read|Glob|Bash): make the session consult the knowledge graph BEFORE reading
// raw source or grepping the tree -- graphify returns a scoped subgraph for a fraction of
// the tokens, so an un-oriented read/grep is the single most expensive habit this repo has.
//
// This module replaces two inline one-liners in .claude/settings.json:
//   CMD=$(python3 -c "import json,sys; ...") ; case "$CMD" in *grep*|*rg\ *|...)  echo '{...}' ;; esac
// Those had three failure modes, every one of them silent because the hook still exits 0:
//   1. `bash` on PATH on this Windows box is WSL's bash.exe, which does not honour the `\"`
//      escaping such a command string needs, so bash never ran it at all
//      (measured: "syntax error near unexpected token `('", exit 127).
//   2. It depended on `python3`, which is not guaranteed in the launcher's PATH.
//   3. Nothing tested it. The other three hooks are node modules with vitest coverage
//      (.claude/hooks/*.test.mjs); this logic had none, which is why the breakage went
//      unnoticed. Node is the repo's own runtime, so a node module needs no interpreter hunt.

import { existsSync } from 'node:fs';

export const GRAPH_PATH = 'graphify-out/graph.json';

// Kept identical to the extension list the inline hook used: the rule is about exploring this
// repository, and its prose (CLAUDE.md, .claude/rules/, docs/) is as much a part of the
// orientation problem as its code. `graphify-out/` is excluded in targetsSourceFile() so the
// hook never demands graphify before reading the graph itself.
const SOURCE_EXTENSIONS = [
  '.py', '.js', '.ts', '.tsx', '.jsx', '.go', '.rs', '.java', '.rb', '.c', '.h', '.cpp',
  '.hpp', '.cc', '.cs', '.kt', '.swift', '.php', '.scala', '.lua', '.sh', '.md', '.rst',
  '.txt', '.mdx',
];

// Mirrors the original case glob `*grep*|*rg\ *|*ripgrep*|*find\ *|*fd\ *|*ack\ *|*ag\ *`
// (note the trailing spaces -- they are part of the original patterns and are preserved).
const SEARCH_PATTERNS = /grep|rg |ripgrep|find |fd |ack |ag /;

export function isRawSearch(command) {
  return SEARCH_PATTERNS.test(String(command ?? ''));
}

/** True when a Read/Glob call touches repo source (and is not the graph artifact itself). */
export function targetsSourceFile(filePath, pattern, path) {
  const haystack = [filePath, pattern, path]
    .map(v => String(v ?? ''))
    .join(' ')
    .toLowerCase()
    .replace(/\\/g, '/');
  if (haystack.includes('graphify-out/')) return false;
  return SOURCE_EXTENSIONS.some(ext => haystack.includes(ext));
}

const READ_REMINDER =
  'MANDATORY: graphify-out/graph.json exists. You MUST run graphify before reading source ' +
  'files. Use: `graphify query "<question>"` (scoped subgraph), `graphify explain "<concept>"`, ' +
  'or `graphify path "<A>" "<B>"`. Only read raw files after graphify has oriented you, or to ' +
  'modify/debug specific lines. This rule applies to subagents too \u2014 include it in every ' +
  'subagent prompt involving code exploration.';

const BASH_REMINDER =
  'MANDATORY: graphify-out/graph.json exists. You MUST run `graphify query "<question>"` before ' +
  'grepping raw files. Only grep after graphify has oriented you, or to modify/debug specific lines.';

function emit(additionalContext) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext } };
}

/**
 * The hook decision for one PreToolUse event.
 * @param {string} toolName  Read | Glob | Bash (anything else -> allow silently)
 * @param {object} toolInput the tool's input payload
 * @param {{graphExists?: boolean}} [deps] injected so tests never touch the real filesystem
 * @returns {object|null} hook JSON to emit, or null to allow silently
 */
export function decide(toolName, toolInput = {}, { graphExists = existsSync(GRAPH_PATH) } = {}) {
  if (!graphExists) return null; // nothing to orient against -- do not nag
  if (toolName === 'Bash') {
    return isRawSearch(toolInput.command) ? emit(BASH_REMINDER) : null;
  }
  if (toolName === 'Read' || toolName === 'Glob') {
    return targetsSourceFile(toolInput.file_path, toolInput.pattern, toolInput.path)
      ? emit(READ_REMINDER)
      : null;
  }
  return null;
}

function main() {
  let raw = '';
  process.stdin.on('data', c => (raw += c));
  process.stdin.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      process.exit(0); // malformed payload must never block a tool call
    }
    const out = decide(payload?.tool_name, payload?.tool_input);
    if (out) process.stdout.write(JSON.stringify(out));
  });
}

if (process.argv[1]?.endsWith('graphify-pointer.mjs')) main();