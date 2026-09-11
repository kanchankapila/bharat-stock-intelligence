"""Per-job memory ceiling for every runPython child, loaded automatically at interpreter start.

pythonRunner.ts puts this directory on the child's PYTHONPATH; Python imports `sitecustomize`
from sys.path during startup, so no script has to opt in. With BHARAT_PY_MEM_LIMIT_MB set, the
process puts itself in a Windows Job Object whose JOB_MEMORY limit caps the committed memory of
the whole process tree (grandchildren inherit the job), so a runaway fails its own job with a
MemoryError instead of exhausting host commit.

Why: dl_trainer.py, a runPython child of bharat-server that pm2's max_memory_restart never sees,
reached 38-52.7GB of commit on this 24GB host (2026-09-06..09-11) and killed the WSL2 VM -- and
the database with it -- three times.

Fails OPEN: nothing here may stop a script from running, and Python reports a raised exception
here as "Error in sitecustomize" on stderr for every job, so everything is caught.
"""
import os
import sys

_LIMIT_ENV = "BHARAT_PY_MEM_LIMIT_MB"
_PEAK_ENV = "BHARAT_PY_PEAK_FILE"


def _install():
    import ctypes
    import ctypes.wintypes as wt

    limit_mb = int(os.environ.get(_LIMIT_ENV) or 0)
    if limit_mb <= 0:
        return

    class _Basic(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong),
                    ("PerJobUserTimeLimit", ctypes.c_longlong),
                    ("LimitFlags", wt.DWORD),
                    ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t),
                    ("ActiveProcessLimit", wt.DWORD),
                    ("Affinity", ctypes.c_size_t),
                    ("PriorityClass", wt.DWORD),
                    ("SchedulingClass", wt.DWORD)]

    class _Extended(ctypes.Structure):
        _fields_ = [("Basic", _Basic),
                    ("IoInfo", ctypes.c_ulonglong * 6),
                    ("ProcessMemoryLimit", ctypes.c_size_t),
                    ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t),
                    ("PeakJobMemoryUsed", ctypes.c_size_t)]

    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateJobObjectW.restype = wt.HANDLE
    k32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wt.LPCWSTR]
    k32.GetCurrentProcess.restype = wt.HANDLE
    k32.SetInformationJobObject.argtypes = [wt.HANDLE, ctypes.c_int, ctypes.c_void_p, wt.DWORD]
    k32.AssignProcessToJobObject.argtypes = [wt.HANDLE, wt.HANDLE]
    k32.QueryInformationJobObject.argtypes = [wt.HANDLE, ctypes.c_int, ctypes.c_void_p,
                                              wt.DWORD, ctypes.c_void_p]
    extended_limit_information = 9
    job_object_limit_job_memory = 0x200

    job = k32.CreateJobObjectW(None, None)
    if not job:
        raise OSError(ctypes.get_last_error(), "CreateJobObjectW")
    info = _Extended()
    info.Basic.LimitFlags = job_object_limit_job_memory
    info.JobMemoryLimit = limit_mb * 1024 * 1024
    if not k32.SetInformationJobObject(job, extended_limit_information,
                                       ctypes.byref(info), ctypes.sizeof(info)):
        raise OSError(ctypes.get_last_error(), "SetInformationJobObject")
    if not k32.AssignProcessToJobObject(job, k32.GetCurrentProcess()):
        raise OSError(ctypes.get_last_error(), "AssignProcessToJobObject")
    peak_file = os.environ.get(_PEAK_ENV)
    # Descendants inherit the job (and so count against this ceiling) without these; left in
    # place, each would build a redundant nested job and write its own smaller peak over ours.
    os.environ.pop(_LIMIT_ENV, None)
    os.environ.pop(_PEAK_ENV, None)
    if not peak_file:
        return

    def _write_peak():
        try:
            import json
            q = _Extended()
            k32.QueryInformationJobObject(job, extended_limit_information,
                                          ctypes.byref(q), ctypes.sizeof(q), None)
            with open(peak_file, "w", encoding="utf-8") as f:
                json.dump({"peak_mb": q.PeakJobMemoryUsed // (1024 * 1024),
                           "limit_mb": limit_mb}, f)
        except Exception:
            pass

    import atexit
    atexit.register(_write_peak)


if sys.platform == "win32":
    try:
        _install()
    except Exception as exc:
        print(f"[py-memory-guard] ceiling not applied: {exc!r}", file=sys.stderr)
