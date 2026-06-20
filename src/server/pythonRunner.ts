import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

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

export interface PythonResult {
  stdout: string;
  stderr: string;
}

export async function runPython(
  script: string,
  args: string[] = [],
  timeoutMs = 5 * 60_000,
): Promise<PythonResult> {
  const { stdout, stderr } = await execFileAsync(
    PYTHON,
    [path.join(PY_DIR, script), ...args],
    { timeout: timeoutMs, maxBuffer: 100 * 1024 * 1024 },
  );
  if (stdout) console.log(`[PY] ${script}:`, stdout.slice(0, 300));
  if (stderr) console.warn(`[PY] ${script} stderr:`, stderr.slice(0, 300));
  return { stdout, stderr };
}
