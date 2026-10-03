"""
Scheduler entry point for the path-based unified_signals status resolver.

The implementation stays in scripts/resolve_stuck_unified_signals.py (it predates this wrapper
and its docstring is the reason the method is trusted). It could not be scheduled directly
because `runPython` resolves script names against src/server/ only, so nothing could ever invoke
it — which is why 106,980 unified_signals rows sat ACTIVE with no path-based resolver running at
all (AF-20261001-03).

This module exists purely so the job queue has a name it can spawn. It execs the real script
as __main__ with argv untouched, so the manual invocation documented in that file
(`python scripts/resolve_stuck_unified_signals.py --apply`) keeps working unchanged.
"""

import os
import runpy

_HERE = os.path.dirname(os.path.abspath(__file__))
_TARGET = os.path.abspath(os.path.join(_HERE, '..', '..', 'scripts', 'resolve_stuck_unified_signals.py'))

if not os.path.exists(_TARGET):
    raise SystemExit(f"stuck-signal resolver implementation not found at {_TARGET}")

# run_path (not import) so the target's own `if __name__ == "__main__"` block runs and its
# argparse reads the flags this process was spawned with.
runpy.run_path(_TARGET, run_name="__main__")
