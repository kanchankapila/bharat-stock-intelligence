import { execFile, spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

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

// Limit concurrent Python subprocesses to avoid starving the Node event loop
let _runningPython = 0;
const _pythonQueue: Array<() => void> = [];
const MAX_PYTHON_CONCURRENT = 5;
// If a slot leaks (observed 2026-07-21: a killed subprocess whose inherited stdio handle
// never closed, so execFile's promisified callback never fired even though the OS process
// was already gone) an unbounded wait here silently deadlocks every Python-backed job app-wide
// -- ml-daily-ops and everything behind it queued for 4h+ with zero log output until the outer
// job timeout eventually fired. Bound the wait so a leak degrades to a loud per-call failure
// instead of a silent freeze.
const SLOT_WAIT_TIMEOUT_MS = 20 * 60_000;

function acquirePythonSlot(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (_runningPython < MAX_PYTHON_CONCURRENT) {
      _runningPython++;
      resolve();
      return;
    }
    const entry = () => {
      clearTimeout(timer);
      _runningPython++;
      resolve();
    };
    const timer = setTimeout(() => {
      const idx = _pythonQueue.indexOf(entry);
      if (idx !== -1) _pythonQueue.splice(idx, 1);
      reject(new Error(
        `Timed out after ${SLOT_WAIT_TIMEOUT_MS}ms waiting for a Python subprocess slot ` +
        `(${_runningPython}/${MAX_PYTHON_CONCURRENT} running, ${_pythonQueue.length} queued ahead) ` +
        `-- a slot has likely leaked.`
      ));
    }, SLOT_WAIT_TIMEOUT_MS);
    _pythonQueue.push(entry);
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

const MAX_BUFFER = 4 * 1024 * 1024;
// How long to wait after a kill signal before giving up on the process exiting
// cleanly and force-settling anyway. Needed because a Python script that spawned
// its own subprocess (multiprocessing, subprocess.Popen) leaves a grandchild
// holding the stdout/stderr pipe handles open -- killing the immediate python.exe
// doesn't close those pipes, so a plain execFile()-style wait for the streams to
// end can hang forever even though the process we meant to kill is long gone.
const KILL_GRACE_MS = 15_000;

function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    // /T kills the whole process tree, not just the immediate child -- plain
    // child.kill() (or execFile's own timeout handling) only signals python.exe
    // itself and leaves any grandchild it spawned running and holding the pipes open.
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => { /* best-effort */ });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // process group already gone
    }
  }
}

export async function runPython(
  script: string,
  args: string[] = [],
  timeoutMs = 5 * 60_000,
): Promise<PythonResult> {
  await acquirePythonSlot();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releasePythonSlot();
  };

  let stdout = '';
  let stderr = '';
  let didThrow = false;
  try {
    const result = await new Promise<PythonResult>((resolve, reject) => {
      const child = spawn(
        PYTHON,
        [path.join(PY_DIR, script), ...args],
        {
          windowsHide: true,
          // Force UTF-8 I/O so Python scripts printing non-ASCII (→ ≥ ₹ etc.)
          // don't crash on Windows CP1252 console encoding
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
        },
      );

      let out = '';
      let err = '';
      let settled = false;
      let timedOut = false;
      let bufferExceeded = false;
      let killTimer: NodeJS.Timeout | undefined;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(softTimer);
        if (killTimer) clearTimeout(killTimer);
        fn();
      };

      const killForBufferOverflow = () => {
        if (bufferExceeded || timedOut) return;
        bufferExceeded = true;
        if (child.pid) killProcessTree(child.pid);
        killTimer = setTimeout(() => {
          settle(() => reject(Object.assign(
            new Error(`stdout/stderr maxBuffer (${MAX_BUFFER} bytes) exceeded`),
            { stdout: out, stderr: err },
          )));
        }, KILL_GRACE_MS);
      };

      child.stdout.on('data', (chunk) => {
        if (out.length < MAX_BUFFER) out += chunk.toString();
        else killForBufferOverflow();
      });
      child.stderr.on('data', (chunk) => {
        if (err.length < MAX_BUFFER) err += chunk.toString();
        else killForBufferOverflow();
      });

      child.on('error', (spawnErr) => {
        settle(() => reject(Object.assign(spawnErr, { stdout: out, stderr: err })));
      });

      child.on('close', (code) => {
        settle(() => {
          if (timedOut) {
            reject(Object.assign(new Error(
              `Timed out after ${timeoutMs}ms (killed by timeout). ` +
              (err || 'No stderr captured before the process was killed.')
            ), { killed: true, signal: 'SIGTERM', stdout: out, stderr: err }));
          } else if (bufferExceeded) {
            reject(Object.assign(
              new Error(`stdout/stderr maxBuffer (${MAX_BUFFER} bytes) exceeded`),
              { stdout: out, stderr: err },
            ));
          } else if (code === 0) {
            resolve({ stdout: out, stderr: err });
          } else {
            reject(Object.assign(
              new Error(err || `Command failed with exit code ${code}`),
              { stdout: out, stderr: err, code },
            ));
          }
        });
      });

      const softTimer = setTimeout(() => {
        timedOut = true;
        if (child.pid) killProcessTree(child.pid);
        // Guarantee this promise settles even if 'close' never fires -- this is
        // the leak observed 2026-07-21: a killed python.exe whose grandchild kept
        // the stdio pipe open meant 'close' never came, so the slot was never
        // released and every future Python job queued forever behind it.
        killTimer = setTimeout(() => {
          settle(() => reject(Object.assign(new Error(
            `Timed out after ${timeoutMs}ms and process tree did not exit within ` +
            `${KILL_GRACE_MS}ms of being killed (likely an orphaned grandchild holding ` +
            `the output pipe open). ` + (err || 'No stderr captured before the process was killed.')
          ), { killed: true, signal: 'SIGKILL', stdout: out, stderr: err })));
        }, KILL_GRACE_MS);
      }, timeoutMs);
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error: any) {
    stdout = error.stdout || '';
    // A killed process often hasn't written anything to stderr yet, so error.stderr
    // is '' (falsy) and this used to fall through to error.message -- just
    // "Command failed: <cmd>", with no indication it was a timeout at all
    // (screener_performance.py's growing dataset started tripping its 45-min budget
    // and every failure looked identical to a code crash with an empty message).
    stderr = (error.killed || error.signal)
      ? (error.message && error.message.startsWith('Timed out')
          ? error.message
          : `Timed out after ${timeoutMs}ms (killed by ${error.signal || 'timeout'}). ` +
            (error.stderr || 'No stderr captured before the process was killed.'))
      : (error.stderr || error.message || String(error));
    didThrow = true;
    // Callers overwhelmingly log only `(e as Error).message`, which for a timeout is the
    // bare "Command failed: <cmd>" — indistinguishable from a code crash. Surface the
    // timeout detail (and any captured stderr) on .message so every .catch and the job
    // heartbeat/monitor records reflect what actually happened.
    if (error.killed || error.signal) error.message = stderr;
    throw error;
  } finally {
    release();
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
