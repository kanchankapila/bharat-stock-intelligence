import { execFile } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

// Anchor to this module's location, NOT process.cwd(): a server accidentally started
// from a .claude worktree copy would otherwise resolve the venv inside the worktree,
// which dies with ENOENT once the worktree is cleaned up (took out ml-daily-ops for
// a week in July 2026). Worktrees never contain a venv, so if this module itself is
// running from one, strip the worktree segment to reach the real repo's venv.
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
// Scripts exist in a worktree, the venv does not — so PY_DIR keeps the worktree
// path while the interpreter falls back to the real repo's venv.
const SCRIPT_ROOT = path.resolve(MODULE_DIR, '..', '..');
const REPO_ROOT = SCRIPT_ROOT.replace(/[\\/]\.claude[\\/]worktrees[\\/][^\\/]+$/, '');

const execFileAsync = promisify(execFile);

// Limit concurrent Python subprocesses to avoid starving the Node event loop
let _runningPython = 0;
const _pythonQueue: Array<() => void> = [];
const MAX_PYTHON_CONCURRENT = 5;

function acquirePythonSlot(): Promise<void> {
  return new Promise(resolve => {
    if (_runningPython < MAX_PYTHON_CONCURRENT) {
      _runningPython++;
      resolve();
    } else {
      _pythonQueue.push(() => { _runningPython++; resolve(); });
    }
  });
}

function releasePythonSlot(): void {
  const next = _pythonQueue.shift();
  if (next) {
    next();
  } else {
    _runningPython--;
  }
}

export const PYTHON = process.env.PYTHON_PATH
  ? (path.isAbsolute(process.env.PYTHON_PATH)
      ? process.env.PYTHON_PATH
      : path.resolve(REPO_ROOT, process.env.PYTHON_PATH))
  : (
    process.platform === 'win32'
      ? path.resolve(REPO_ROOT, 'backend-python', 'venv', 'Scripts', 'python.exe')
      : path.resolve(REPO_ROOT, 'backend-python', 'venv', 'bin', 'python')
  );

export const PY_DIR = path.resolve(SCRIPT_ROOT, 'src', 'server');

import log from './logger';

export interface PythonResult {
  stdout: string;
  stderr: string;
}

export async function runPython(
  script: string,
  args: string[] = [],
  timeoutMs = 5 * 60_000,
): Promise<PythonResult> {
  await acquirePythonSlot();
  let stdout = '';
  let stderr = '';
  let didThrow = false;
  try {
    const result = await execFileAsync(
      PYTHON,
      [path.join(PY_DIR, script), ...args],
      {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        // Force UTF-8 I/O so Python scripts printing non-ASCII (→ ≥ ₹ etc.)
        // don't crash on Windows CP1252 console encoding
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
      },
    );
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error: any) {
    stdout = error.stdout || '';
    // execFile sets killed=true + a signal when the `timeout` option fires. A killed
    // process often hasn't written anything to stderr yet, so error.stderr is '' (falsy)
    // and this used to fall through to error.message -- just "Command failed: <cmd>",
    // with no indication it was a timeout at all (screener_performance.py's growing
    // dataset started tripping its 45-min budget and every failure looked identical to
    // a code crash with an empty message).
    stderr = (error.killed || error.signal)
      ? `Timed out after ${timeoutMs}ms (killed by ${error.signal || 'timeout'}). ` +
        (error.stderr || 'No stderr captured before the process was killed.')
      : (error.stderr || error.message || String(error));
    didThrow = true;
    // Callers overwhelmingly log only `(e as Error).message`, which for a timeout is the
    // bare "Command failed: <cmd>" — indistinguishable from a code crash. Surface the
    // timeout detail (and any captured stderr) on .message so every .catch and the job
    // heartbeat/monitor records reflect what actually happened.
    if (error.killed || error.signal) error.message = stderr;
    throw error;
  } finally {
    releasePythonSlot();
    if (stdout) {
      log.info(`[PY] ${script} execution completed`, {
        script,
        args,
        outputSnippet: stdout.slice(0, 300),
      });
    }
    if (stderr) {
      if (didThrow) {
        log.error(`[PY] ${script} encountered an error`, {
          script,
          args,
          stderrSnippet: stderr.slice(0, 300),
          fullStderr: stderr,
        });
      } else {
        log.warn(`[PY] ${script} finished successfully with warnings/stderr output`, {
          script,
          args,
          stderrSnippet: stderr.slice(0, 300),
          fullStderr: stderr,
        });
      }
    }
  }
  return { stdout, stderr };
}
