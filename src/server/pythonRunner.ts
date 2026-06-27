import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';

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
      : path.resolve(process.cwd(), process.env.PYTHON_PATH))
  : (
    process.platform === 'win32'
      ? path.resolve(process.cwd(), 'backend-python', 'venv', 'Scripts', 'python.exe')
      : path.resolve(process.cwd(), 'backend-python', 'venv', 'bin', 'python')
  );

export const PY_DIR = path.resolve(process.cwd(), 'src', 'server');

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
  try {
    const result = await execFileAsync(
      PYTHON,
      [path.join(PY_DIR, script), ...args],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
    );
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error: any) {
    stdout = error.stdout || '';
    stderr = error.stderr || error.message || String(error);
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
      log.error(`[PY] ${script} encountered an error or stderr output`, {
        script,
        args,
        stderrSnippet: stderr.slice(0, 300),
        fullStderr: stderr,
      });
    }
  }
  return { stdout, stderr };
}
