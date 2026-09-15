// SessionStart wrapper: run .claude/hooks/session-start.sh under a bash that can actually find
// this repository.
//
// Why this exists. .claude/settings.json used to declare the hook as
//   bash "$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.sh"
// which is Windows-hostile in three compounding ways, all measured on the dev box:
//   1. `bash` on PATH resolved to WSL's bash.exe (C:\Windows\System32\bash.exe), which cannot
//      open a Windows path: "/bin/bash: d:\Github\...\session-start.sh: No such file or
//      directory", exit 127 -- the hook never ran.
//   2. When it did start (Git Bash, or WSL with a resolvable path), the script's own
//      `cd "$CLAUDE_PROJECT_DIR" || exit 0` hit the same Windows path, failed, and exited 0 --
//      so the entire local-environment check was a silent no-op. That check is where the
//      Definition-of-done prerequisites AND the memory/graphify orientation hints are surfaced.
//   3. The file shipped CRLF through a Windows checkout, so bash rejected it outright
//      (".sh" is now pinned to LF in .gitattributes).
//
// What this does instead: find a bash that works (Git Bash first on Windows), run the script by
// RELATIVE path with cwd = repo root -- both Git Bash and WSL inherit the Windows cwd as their
// own working directory -- and drop a Windows-shaped CLAUDE_PROJECT_DIR so the script's own
// `dirname "$0"/../..` fallback resolves the root. It never exits non-zero: a hook that bricks
// the session is worse than the problem it reports (same rule the .sh follows).

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = '.claude/hooks/session-start.sh';

/** True for `d:\...` / `C:/...` — a path the POSIX bash the script runs under cannot use. */
export function isWindowsStylePath(p) {
  return typeof p === 'string' && /^[a-zA-Z]:[\\/]/.test(p);
}

/** Ordered bash candidates. Git Bash handles Windows cwd + LF scripts; 'bash' is right on POSIX. */
export function bashCandidates(env = process.env, platform = process.platform) {
  const candidates = [];
  if (platform === 'win32') {
    const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
    candidates.push(`${programFiles}\\Git\\bin\\bash.exe`);
    if (env['ProgramFiles(x86)']) candidates.push(`${env['ProgramFiles(x86)']}\\Git\\bin\\bash.exe`);
  }
  candidates.push('bash');
  return candidates;
}

/** First candidate that exists (absolute paths are checked; bare 'bash' is left to PATH). */
export function pickBash(env = process.env, platform = process.platform, exists = existsSync) {
  return bashCandidates(env, platform).find(c => !c.includes('\\') || exists(c)) ?? null;
}

/** Environment for the child: a Windows-shaped CLAUDE_PROJECT_DIR is worse than none at all. */
export function envForBash(env = process.env) {
  const out = { ...env };
  if (isWindowsStylePath(out.CLAUDE_PROJECT_DIR)) delete out.CLAUDE_PROJECT_DIR;
  return out;
}

export function run({ env = process.env, platform = process.platform, exists = existsSync, spawn = spawnSync } = {}) {
  const bash = pickBash(env, platform, exists);
  if (!bash) {
    process.stderr.write(
      '[session-start] no usable bash found (looked for Git Bash, then bash on PATH) — the ' +
        'environment/Definition-of-done checks did NOT run. Install Git Bash or run the script ' +
        `manually: bash ${SCRIPT}\n`
    );
    return 0; // never brick the session
  }

  const result = spawn(bash, [SCRIPT], {
    cwd: REPO_ROOT,
    env: envForBash(env),
    stdio: 'inherit',
    shell: false,
  });

  if (result.error) {
    process.stderr.write(
      `[session-start] could not start ${bash} (${result.error.message}) — the environment/` +
        `Definition-of-done checks did NOT run. Run it manually: bash ${SCRIPT}\n`
    );
    return 0;
  }
  if (result.status === 127) {
    process.stderr.write(
      `[session-start] ${bash} exited 127 (script not found) — the environment/Definition-of-done ` +
        `checks did NOT run. Run it manually: bash ${SCRIPT}\n`
    );
    return 0;
  }
  return result.status ?? 0;
}

if (process.argv[1]?.endsWith('run-session-start.mjs')) {
  process.exit(run());
}