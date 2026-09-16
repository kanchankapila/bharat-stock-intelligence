import { execFile, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { classifyStderr } from './jobSweep';

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

/**
 * Human-readable causes for abnormal process exit codes.
 *
 * A process killed by the OS writes NOTHING to stdout or stderr, so the `reason` built below
 * fell through to a bare `Command failed with exit code 3221225794` -- a magic number that reads
 * exactly like a Python crash and sends the next reader hunting a bug in the script. Live case
 * 2026-09-10: a planned Windows Update restart (TrustedInstaller, confirmed via System event log
 * 1074 at 02:06 IST) tore down the in-flight ml-weekly-retrain children, and the only record was
 * `exit_policy.py encountered an error ... exit code 1073807364` /
 * `ml_ensemble.py ... exit code 3221225794`, with `fullStderr` holding nothing but that same
 * sentence. Same family as this file's own `err || out` fix: a failure with no recoverable reason.
 *
 * Windows returns NTSTATUS values as unsigned exit codes; the shutdown-related ones matter most
 * here because they mean "the host killed this", not "the script failed".
 */
const ABNORMAL_EXIT_CODES: Record<number, string> = {
  1073807364: 'DBG_TERMINATE_PROCESS (0x40010004) — the OS terminated the process, typically console/session teardown during a host shutdown or restart',
  3221225786: 'STATUS_CONTROL_C_EXIT (0xC000013A) — the console was closed or Ctrl+C was delivered',
  3221225794: 'STATUS_DLL_INIT_FAILED (0xC0000142) — the process could not initialize its DLLs, typically a host shutdown already in progress, or exhausted memory/desktop heap',
  3221225781: 'STATUS_DLL_NOT_FOUND (0xC0000135) — a required DLL is missing (environment/dependency problem, not a script bug)',
  3221225477: 'STATUS_ACCESS_VIOLATION (0xC0000005) — native crash inside a compiled extension',
  3221225725: 'STATUS_STACK_OVERFLOW (0xC00000FD) — native stack overflow',
  3221226356: 'STATUS_HEAP_CORRUPTION (0xC0000374) — heap corruption detected',
  3221266689: 'STATUS_STACK_BUFFER_OVERRUN (0xC0000409) — fail-fast / stack buffer overrun',
  137: 'SIGKILL (128+9) — killed by the OS, typically the out-of-memory killer',
  143: 'SIGTERM (128+15) — terminated by a signal',
};

/** Codes meaning "the host/OS killed this process" — the script itself did not fail. */
const HOST_TEARDOWN_EXIT_CODES = new Set([1073807364, 3221225786, 3221225794]);

/**
 * NTSTATUS exits reach Node as either the unsigned value the table above is keyed on
 * (3221225477) or its signed 32-bit twin (-1073741819), depending on how the code crosses the
 * child-process boundary. Normalizing first means one table serves both; without it a signed
 * code decodes to '' and is then dropped from the message entirely (AF-20260911-14).
 */
export function normalizeExitCode(code: number | null | undefined): number | null {
  if (code === null || code === undefined || !Number.isFinite(code)) return null;
  return code < 0 ? code >>> 0 : code;
}

/** '' for ordinary codes (1, 2, ...) so the common failure path's message is unchanged. */
export function describeExitCode(code: number | null | undefined): string {
  const c = normalizeExitCode(code);
  if (c === null) return '';
  return ABNORMAL_EXIT_CODES[c] ?? '';
}

export function isHostTeardownExit(code: number | null | undefined): boolean {
  const c = normalizeExitCode(code);
  return c !== null && HOST_TEARDOWN_EXIT_CODES.has(c);
}

/**
 * An exit code worth printing verbatim. 0/1/2 are the ordinary "the script decided to fail"
 * codes whose message shape must not change (repo-doctor and jobSweep group log signatures on
 * it); anything else is a magic number a reader cannot recover from the text otherwise.
 */
function isAbnormalExitCode(c: number | null): c is number {
  return c !== null && c > 2;
}

/**
 * Builds the failure message for a non-zero exit. Extracted from the 'close' handler so the
 * ordering and the never-drop-the-code guarantee are directly testable.
 *
 * AF-20260911-14: ml-ensemble-train was recorded 'failed' twice with an "error" that was only a
 * stdout tail ending '[Ensemble] Done.' — it had trained, registered model_id=327 and scored 326
 * signals, then exited non-zero at interpreter teardown. The code was unlisted, so `decoded` was
 * '' and `.filter(Boolean)` removed the number along with it, leaving nothing to diagnose from.
 */
export function buildFailureReason(opts: {
  code: number | null | undefined;
  stderr?: string | null;
  stdout?: string | null;
  peakMemMb?: number;
  memLimitMb?: number;
}): string {
  const { stderr, stdout, peakMemMb } = opts;
  const memLimitMb = opts.memLimitMb ?? 0;
  const code = normalizeExitCode(opts.code);
  const err = stderr ?? '';
  const out = stdout ?? '';
  const errTail = err ? err.slice(-500) : '';
  const outTail = out ? out.slice(-500) : '';
  const decoded = describeExitCode(code);
  // A single oversized allocation fails well below the peak, so the stderr signature counts as
  // well as a peak near the ceiling. Assert the ceiling only when the peak reached it: a shape
  // bug asking for terabytes also raises MemoryError at a low peak, and blaming the ceiling
  // there would send the reader off to raise the limit.
  const atCeiling = memLimitMb > 0 && peakMemMb !== undefined && peakMemMb >= 0.9 * memLimitMb;
  const oom = OOM_STDERR.test(err);
  return [
    atCeiling && `MEMORY CEILING: the job's process tree peaked at ${peakMemMb}MB against its ` +
      `${memLimitMb}MB per-job ceiling (PY_CHILD_MEM_LIMIT_MB) and was refused further ` +
      `memory -- a runaway this job contained instead of the host.`,
    !atCeiling && oom && `MemoryError (peak ${peakMemMb ?? '?'}MB of a ${memLimitMb || 'no'}MB ` +
      `ceiling) -- well below the ceiling, so look at the allocation, not the limit.`,
    decoded && `${isHostTeardownExit(code) ? 'HOST/OS TERMINATION' : 'ABNORMAL EXIT'}: ${decoded}`,
    // Never let the raw number vanish. `decoded` covers only codes someone has already met;
    // an unlisted one is exactly the case that needs the number most.
    isAbnormalExitCode(code) && !decoded && `ABNORMAL EXIT: exit code ${code} ` +
      `(0x${code.toString(16).toUpperCase()}) — not a code this runner has seen before; the ` +
      `script's own output (if any) follows.`,
    isAbnormalExitCode(code) && decoded && `exit code ${code}`,
    errTail && `stderr: ${errTail}`,
    outTail && `stdout: ${outTail}`,
  ].filter(Boolean).join('\n') || `Command failed with exit code ${opts.code}`;
}

// Limit concurrent Python subprocesses to avoid starving the Node event loop
let _runningPython = 0;
const _pythonQueue: Array<() => void> = [];
const MAX_PYTHON_CONCURRENT = 5;

// ─── Host-wide memory budget (AF-20260912-13) ─────────────────────────────────────
// MAX_PYTHON_CONCURRENT is a COUNT. PY_CHILD_MEM_LIMIT_MB (below) is PER PROCESS TREE. Neither
// is a host budget, and the gap between them took the box down on 2026-09-12: strategy_optimizer.py
// peaked at 16,870MB while dl_trainer.py held 13,500MB -- each individually legal against the
// 20GB per-tree ceiling, jointly 30.4GB on a 23.5GB host. Commit reached 94.3% of 82GB with
// 339MB available and 102,856 pages/sec. queues.ts asserted the opposite in a comment ('caps
// global Python concurrency at 5, so this can't oversubscribe the box'); that assertion was the bug.
//
// So admission is now weighted: a job is admitted only while the sum of the EXPECTED peaks of
// everything already running, plus its own, fits HOST_PY_BUDGET_MB.
//
// Two escape hatches, both deliberate:
//  - A job whose own weight exceeds the whole budget MUST still run, or the queue deadlocks and
//    every Python-backed job on the platform stops. It is admitted when nothing else is running,
//    i.e. it gets the box to itself. That is the correct handling for a 16GB trainer anyway.
//  - An unknown script gets DEFAULT_SCRIPT_PEAK_MB rather than 0, so a newly added script cannot
//    silently weigh nothing. 600MB is the measured median of the 23 scripts under 900MB.
//
// Weights are MEASURED, not estimated -- every value below is the max observed `peakMemMb` in
// logs/app-2026-09-*.log, which pythonRunner logs on every run (AF-20260911-12). Re-derive with:
//   grep -ho 'peakMemMb\":[0-9]*' logs/app-*.log   (paired with the \"script\" field)
// A weight that is too LOW re-opens this bug; too HIGH only costs serialisation. Round up.
const DEFAULT_SCRIPT_PEAK_MB = 600;
const SCRIPT_PEAK_MB: Record<string, number> = {
  // strategy_optimizer.py has no logged peakMemMb yet (no completed run in the retained window);
  // 16870 is the live Win32_Process PeakPageFileUsage read taken during the 2026-09-12 incident.
  'strategy_optimizer.py': 16870,
  'dl_trainer.py': 13820,
  'ml_ensemble.py': 7088,
  'finstack_cashflow_fetcher.py': 4148,
  'ohlcv_adjust.py': 4005,
  'finbert_news_sentiment.py': 3563,
  'factor_edge.py': 2413,
  'extra_endpoints_fetcher.py': 2398,
  'mover_screener_fetcher.py': 1452,
  'confluence_ml_engine.py': 1340,
  'performance_tracker.py': 1304,
  'backtester.py': 1169,
};

/** Expected peak MB for a script path/name. Exported for the guard test. */
export function scriptWeightMb(script: string): number {
  const base = script.replace(/\\/g, '/').split('/').pop() ?? script;
  return SCRIPT_PEAK_MB[base] ?? DEFAULT_SCRIPT_PEAK_MB;
}

// A full host-wide byte budget was considered and REJECTED as the admission rule: with strict
// FIFO a 16GB trainer at the head blocks every small job behind it, and with first-fit the
// trainer starves instead -- either way the loser hits SLOT_WAIT_TIMEOUT_MS (3 min) and FAILS.
// Trading one memory bug for a mass job-failure bug is not a fix.
//
// What actually caused the incident is narrower and needs a narrower rule: TWO HEAVY jobs ran
// at once. So heavy jobs are serialised against EACH OTHER and nothing else changes. Small jobs
// never touch this lock, so their behaviour is bit-identical to before -- no starvation, no new
// timeout surface, and no deadlock (the lock has exactly one holder).
//
// 8192MB splits the measured population cleanly: strategy_optimizer 16,870 and dl_trainer 13,820
// are heavy; the next largest script on the platform is ml_ensemble at 7,088, and two of those
// plus the services still fit. 0 disables the heavy lock. Read per call so a .env change applies
// after a restart without a code change.
function heavyThresholdMb(): number {
  const raw = process.env.PY_HEAVY_THRESHOLD_MB;
  if (raw === undefined || raw === '') return 8192;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 8192;
}

/** True when a script is heavy enough to require the exclusive heavy slot. */
export function isHeavyScript(script: string): boolean {
  const t = heavyThresholdMb();
  return t > 0 && scriptWeightMb(script) >= t;
}

// The exclusive heavy slot. A heavy job waits here for however long the incumbent heavy job
// takes -- dl_trainer ran 4h on 2026-09-12 -- so this wait is deliberately NOT bounded by
// SLOT_WAIT_TIMEOUT_MS, which exists to surface a leaked COUNT slot in 3 min. Bounding it at
// 3 min would fail every heavy job that correctly waited its turn.
let _heavyRunning: string | null = null;
const _heavyQueue: Array<() => void> = [];

export function acquireHeavySlot(script: string): Promise<void> {
  return new Promise((resolve) => {
    if (_heavyRunning === null) {
      _heavyRunning = script;
      resolve();
      return;
    }
    console.warn(
      `[PY-HEAVY] ${script} (~${scriptWeightMb(script)}MB expected peak) is waiting: ` +
      `${_heavyRunning} holds the exclusive heavy slot. Serialising them is deliberate -- ` +
      `running both concurrently is what exhausted host commit on 2026-09-12 (AF-20260912-13).`,
    );
    _heavyQueue.push(() => { _heavyRunning = script; resolve(); });
  });
}

export function releaseHeavySlot(): void {
  _heavyRunning = null;
  const next = _heavyQueue.shift();
  if (next) next();
}

/** Exposed for tests/diagnostics. */
export function getHeavySlotState(): { running: string | null; queued: number; thresholdMb: number } {
  return { running: _heavyRunning, queued: _heavyQueue.length, thresholdMb: heavyThresholdMb() };
}

/** Force-reset the heavy slot (tests only). */
export function resetHeavySlot(): void {
  _heavyRunning = null;
  _heavyQueue.length = 0;
}// If a slot leaks (observed 2026-07-21: a killed subprocess whose inherited stdio handle
// never closed, so execFile's promisified callback never fired even though the OS process
// was already gone) an unbounded wait here silently deadlocks every Python-backed job app-wide
// -- ml-daily-ops and everything behind it queued for 4h+ with zero log output until the outer
// job timeout eventually fired. Bound the wait so a leak degrades to a loud per-call failure
// instead of a silent freeze.
//
// Root cause: grandchildren spawned by daily_ml_update.py (subprocess.run) and
// feature_engineering.py (ProcessPoolExecutor) inherited Node's stdio pipe endpoints.
// When Node killed the parent python.exe via taskkill /T /F the grandchildren survived
// and kept those endpoints open, so the pipe's 'close' event never fired in Node.
// Fixed in those Python scripts by redirecting stdio to DEVNULL + CREATE_NO_WINDOW.
// This shorter timeout (3 min vs old 20 min) + the periodic watchdog below are a
// belt-and-suspenders safety net if any other script introduces the same pattern.
const SLOT_WAIT_TIMEOUT_MS = 3 * 60_000;  // 3 min — fail fast so queue drains quickly

// ─── Slot watchdog ────────────────────────────────────────────────────────────
// If _runningPython stays > MAX_PYTHON_CONCURRENT for longer than the maximum possible
// script lifetime, every slot holder must have leaked. Reset the counter so jobs can
// proceed without a full server restart.
// Longest configured timeout across all runPython() call sites is 90 min (lockDuration);
// add KILL_GRACE_MS (15 s) + generous buffer → 100 min.
const MAX_SLOT_AGE_MS = 100 * 60_000;
let _overLimitSince: number | null = null;

function _slotHealthWatchdog(): void {
  const now = Date.now();
  if (_runningPython > MAX_PYTHON_CONCURRENT) {
    if (_overLimitSince === null) {
      _overLimitSince = now;
    } else if (now - _overLimitSince > MAX_SLOT_AGE_MS) {
      // Been stuck for longer than any script could legitimately run — force-reset.
      console.error(
        `[PY-WATCHDOG] _runningPython=${_runningPython} has exceeded MAX_PYTHON_CONCURRENT=${MAX_PYTHON_CONCURRENT} ` +
        `for >${Math.round((now - _overLimitSince) / 60_000)}min — slot leak confirmed. ` +
        `Resetting counter to 0 and draining ${_pythonQueue.length} queued waiters.`
      );
      _runningPython = 0;
      _overLimitSince = null;
      // Drain the queue: release up to MAX_PYTHON_CONCURRENT waiters immediately.
      while (_pythonQueue.length > 0 && _runningPython < MAX_PYTHON_CONCURRENT) {
        const next = _pythonQueue.shift();
        if (next) next();
      }
    }
  } else {
    _overLimitSince = null;
  }
}

// Start the watchdog (every 5 min). unref() so it doesn't block process exit.
setInterval(_slotHealthWatchdog, 5 * 60_000).unref?.();

/** Expose current slot state for diagnostics / tests. */
export function getPythonSlotState(): { running: number; queued: number; max: number } {
  return { running: _runningPython, queued: _pythonQueue.length, max: MAX_PYTHON_CONCURRENT };
}

/** Force-reset the slot counter (use only in tests or after confirmed leak). */
export function resetPythonSlots(): void {
  _runningPython = 0;
  _overLimitSince = null;
}


/** Exposed for tests only -- production callers go through runPython(). */
export function acquirePythonSlot(_script = ''): Promise<void> {
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

/** Exposed for tests only -- production callers go through runPython(). */
export function releasePythonSlot(_script = ''): void {
  // Always decrement for the finishing holder first. If a waiter is queued,
  // handing them the slot re-increments via entry() -- net zero (transfer).
  // Previously this branch skipped the decrement on handoff, so every transfer
  // under queue contention leaked +1 permanently; with 5 concurrent slots and
  // 40+ Python jobs firing every few minutes, the queue was rarely empty, so
  // the counter drifted past MAX_PYTHON_CONCURRENT within minutes of every
  // watchdog reset instead of only after a genuine subprocess leak.
  _runningPython--;
  const next = _pythonQueue.shift();
  if (next) {
    next();
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

// ─── Per-job memory ceiling ───────────────────────────────────────────────────
// Children get pyboot/ on PYTHONPATH; its sitecustomize.py puts the whole process tree in a
// Windows Job Object capped at PY_CHILD_MEM_LIMIT_MB of committed memory. pm2's
// max_memory_restart watches bharat-server only, never these children -- dl_trainer.py reached
// 38-52.7GB of commit on this 24GB host (2026-09-06..09-11) and killed the WSL2 VM, and the
// database with it, three times. OBSERVE-FIRST: no heavy job's legitimate peak had been measured
// when this landed (dl_trainer's post-fix peak is only estimated at ~8-10GB), so the default is
// set to bite only on a genuine runaway -- 20GB stops the 38-52.7GB case with host commit to spare
// -- while every run logs peakMemMb. Tighten it from those logged peaks (AF-20260911-12), not from
// estimates: a ceiling below a job's real peak turns a working job into a guaranteed MemoryError.
// It is per job tree, not per host: 5 slots can still sum past RAM.
// 0 disables it. Read per call so a .env change applies after a restart without a code change.
const PYBOOT_DIR = path.resolve(PY_DIR, 'pyboot');
const DEFAULT_CHILD_MEM_LIMIT_MB = 20_480;
let _peakFileSeq = 0;

function childMemLimitMb(): number {
  const raw = process.env.PY_CHILD_MEM_LIMIT_MB;
  if (raw === undefined || raw.trim() === '') return DEFAULT_CHILD_MEM_LIMIT_MB;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_CHILD_MEM_LIMIT_MB;
}

/** Read (and delete) the child's peak-commit record; undefined if it never wrote one. */
function takePeakMemMb(file: string): number | undefined {
  try {
    const peak = JSON.parse(fs.readFileSync(file, 'utf8')).peak_mb;
    return typeof peak === 'number' ? peak : undefined;
  } catch {
    return undefined;
  } finally {
    try { fs.rmSync(file, { force: true }); } catch { /* best-effort */ }
  }
}

const OOM_STDERR = /MemoryError|Unable to allocate|not enough memory/;

import log from './logger';

export interface PythonResult {
  stdout: string;
  stderr: string;
  /** Peak committed memory of the job's whole process tree, when the ceiling was active. */
  peakMemMb?: number;
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
  // Heavy jobs take the exclusive heavy slot BEFORE the count slot, and in that order on
  // purpose: holding a count slot while waiting for the heavy slot would occupy 1 of only 5
  // count slots for the entire wait (hours), throttling every unrelated fetcher behind it.
  const heavy = isHeavyScript(script);
  if (heavy) await acquireHeavySlot(script);
  try {
    await acquirePythonSlot(script);
  } catch (e) {
    // The count slot timed out. Give the heavy slot back or it leaks forever and every
    // later heavy job waits on a holder that is not running.
    if (heavy) releaseHeavySlot();
    throw e;
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releasePythonSlot(script);
    if (heavy) releaseHeavySlot();
  };

  let stdout = '';
  let stderr = '';
  let peakMemMb: number | undefined;
  let didThrow = false;
  const memLimitMb = childMemLimitMb();
  const peakFile = path.join(os.tmpdir(), `bsi-py-peak-${process.pid}-${++_peakFileSeq}.json`);
  try {
    const result = await new Promise<PythonResult>((resolve, reject) => {
      const child = spawn(
        PYTHON,
        [path.join(PY_DIR, script), ...args],
        {
          windowsHide: true,
          env: {
            ...process.env,
            // Force UTF-8 I/O so Python scripts printing non-ASCII (→ ≥ ₹ etc.)
            // don't crash on Windows CP1252 console encoding
            PYTHONIOENCODING: 'utf-8',
            PYTHONUNBUFFERED: '1',
            PYTHONPATH: [PYBOOT_DIR, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
            BHARAT_PY_MEM_LIMIT_MB: String(memLimitMb),
            BHARAT_PY_PEAK_FILE: peakFile,
          },
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
        peakMemMb = takePeakMemMb(peakFile);
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
            resolve({ stdout: out, stderr: err, peakMemMb });
          } else {
            // A script can sys.exit(1) after printing its failure reason to stdout
            // (e.g. mc_broker_reco_fetcher.py's "0 recos fetched" guard, dl_trainer.py's
            // `[TRAINER] Done: {...'error'...}` line) rather than stderr -- include the stdout
            // tail so the reason isn't lost behind a bare "Command failed with exit code 1".
            //
            // `err || out` was WRONG and hid a real failure (found 2026-08-30): any script that
            // imports torch writes UserWarnings to stderr on every single run, so `err` is
            // effectively never empty for the ML scripts, the `||` short-circuits, and the stdout
            // tail carrying the ACTUAL error is discarded. Live case: dl-retrain-weekly's make-up
            // run failed with a recorded reason consisting of nothing but two torch warnings
            // ('expandable_segments not supported', 'PYTORCH_CUDA_ALLOC_CONF is deprecated') --
            // no error text at all, in the job history OR the heartbeat. Concatenate both streams
            // instead of choosing one: stderr is where a traceback lands, stdout is where a
            // deliberate sys.exit(1) guard prints its reason, and a failing run can use either.
            const reason = buildFailureReason({ code, stderr: err, stdout: out, peakMemMb, memLimitMb });
            reject(Object.assign(new Error(reason), { stdout: out, stderr: err, code }));
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
    // The kill paths settle without 'close', so the record may still be on disk.
    if (peakMemMb === undefined) peakMemMb = takePeakMemMb(peakFile);
    if (stdout) {
      log.info(`[PY] ${script} execution completed`, {
        script,
        args,
        peakMemMb,
        outputSnippet: stdout.slice(0, 300),
      });
    }
    if (!stdout && !stderr && peakMemMb !== undefined) {
      log.info(`[PY] ${script} completed`, { script, args, peakMemMb });
    }
    if (stderr) {
      if (didThrow) {
        log.error(`[PY] ${script} encountered an error`, {
          script,
          args,
          peakMemMb,
          stderrSnippet: stderr.slice(0, 300),
          fullStderr: stderr,
        });
      } else {
        // A script that EXITED 0 has succeeded; non-empty stderr does not contradict that.
        // Measured against the live pm2 log 2026-09-05: of 154 warn lines, ~40 were
        // "[PY] <script> finished successfully with warnings" where the stderr was a
        // transformers GPU efficiency hint or scrapy's own INFO: progress lines -- i.e. the
        // dominant "warning" in this platform's logs was not a warning at all, and that noise
        // floor is most of what makes the Telegram digest look alarming. classifyStderr is
        // reused from jobSweep.ts rather than reimplemented here, so there is exactly one
        // definition of what counts as benign (and it is negative-controlled: a traceback
        // underneath benign chatter still classifies as a real error).
        const cls = classifyStderr(stderr);
        const line = `[PY] ${script} finished successfully (stderr: ${cls})`;
        const meta = { script, args, peakMemMb, stderrClass: cls, stderrSnippet: stderr.slice(0, 300), fullStderr: stderr };
        if (cls === 'real_error') log.warn(line, meta);
        else log.info(line, meta);
      }
    }
  }
  return { stdout, stderr, peakMemMb };
}
