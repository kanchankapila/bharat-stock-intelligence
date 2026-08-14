#!/bin/bash
# SessionStart hook — make CLAUDE.md's "Definition of done" actually runnable.
#
# The four checks that gate a task here (`npx tsc --noEmit`, `npx vitest run`,
# `python -m pytest src/server/__tests__/ src/server/tests/`, `npm run schema:drift`)
# all need dependencies that a FRESH REMOTE CONTAINER DOES NOT HAVE. Measured
# 2026-08-13 on a running Claude-Code-on-the-web session for this repo: no
# node_modules, no backend-python/venv, no pytest/pandas/numpy. Every cloud session
# was therefore structurally incapable of running any of them — which, given that
# `recurring-bugs.md`'s single most-repeated failure is claiming "done" without the
# check having run, is the worst possible environment for this codebase.
#
# Two branches, deliberately doing different things:
#
#   remote (CLAUDE_CODE_REMOTE=true) — INSTALL. Mirrors .github/workflows/ci.yml's
#     python-tests job exactly (backend-python/requirements.txt minus the CUDA torch
#     line, plus CPU torch from PyTorch's own index) so that a green local run means
#     the same thing CI means. Container state is cached after the hook completes,
#     so this is a once-per-container cost, not once-per-session.
#
#   local — CHECK ONLY, never install. A dev box already has its venv, pm2, Postgres
#     on :5433 and Redis. What it can silently lack is the .env wiring, and this
#     repo has a documented bug class for exactly that: a hand-run script without
#     `import 'dotenv/config'` talks to SQLite instead of production Postgres "and
#     will happily print convincing numbers" (recurring-bugs.md, Environment & deploy).
#     So the local branch asserts, reports, and touches nothing.
#
# Never exits non-zero. A hook that bricks the session on a transient network failure
# is worse than the problem it solves. But it also never claims success it did not
# achieve — on failure it prints an explicit DO-NOT-TRUST banner, because a silent
# skip path stamped as success is this repo's most-recurring bug class (5 instances
# in one file), and a dependency installer is not exempt from its own rule.

set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}" || exit 0

MARKER_DIR=".claude/.session-start"
mkdir -p "$MARKER_DIR" 2>/dev/null || true

say() { printf '%s\n' "$*"; }

# ─── local: assert, don't install ─────────────────────────────────────────────
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  say "[session-start] local environment — checking, not installing."
  problems=0

  [ -d node_modules ] || { say "  ! node_modules missing — run: npm install"; problems=$((problems+1)); }

  if [ -d backend-python/venv ]; then
    say "  ✓ backend-python/venv present (PYTHON_PATH production uses)"
  else
    say "  ! backend-python/venv missing — the Python engines will run under the wrong interpreter."
    problems=$((problems+1))
  fi

  if [ -f .env ]; then
    if grep -qE '^\s*USE_POSTGRES\s*=\s*true' .env; then
      say "  ✓ .env sets USE_POSTGRES=true"
    else
      say "  ! .env does NOT set USE_POSTGRES=true — db_compat/dbAsync will silently use SQLite,"
      say "    not production Postgres, and any number you measure will be from the wrong database."
      problems=$((problems+1))
    fi
  else
    say "  ! no .env — every hand-run script will fall back to SQLite (see recurring-bugs.md)."
    problems=$((problems+1))
  fi

  pg_port="$(grep -E '^\s*POSTGRES_PORT\s*=' .env 2>/dev/null | head -1 | cut -d= -f2 | tr -d '[:space:]')"
  pg_port="${pg_port:-5433}"
  if command -v pg_isready >/dev/null 2>&1; then
    if pg_isready -h 127.0.0.1 -p "$pg_port" -q 2>/dev/null; then
      say "  ✓ Postgres reachable on 127.0.0.1:$pg_port"
    else
      say "  ! Postgres NOT reachable on 127.0.0.1:$pg_port — start it: docker compose up -d timescaledb"
      problems=$((problems+1))
    fi
  fi

  if [ "$problems" -gt 0 ]; then
    say "[session-start] $problems issue(s) above. Verification commands may not measure what you think."
  else
    say "[session-start] local environment looks wired correctly."
  fi
  exit 0
fi

# ─── remote: install ──────────────────────────────────────────────────────────
say "[session-start] remote container — installing dependencies so the Definition of done can run."

node_ok=0
py_ok=0

# Node ------------------------------------------------------------------------
# `npm install`, not `npm ci`: the container image is cached after this hook
# completes, and install reuses that cache where ci would wipe node_modules first.
if [ -d node_modules ] && [ -f "$MARKER_DIR/npm.ok" ] \
   && [ "$MARKER_DIR/npm.ok" -nt package-lock.json ]; then
  say "  ✓ node_modules present and newer than package-lock.json — skipping npm install"
  node_ok=1
else
  say "  … npm install"
  if npm install --no-audit --no-fund >/dev/null 2>&1; then
    touch "$MARKER_DIR/npm.ok"; node_ok=1
    say "  ✓ npm install complete"
  else
    say "  ✗ npm install FAILED"
  fi
fi

# Python ----------------------------------------------------------------------
# Pinned backend-python/requirements.txt is the file CI installs, so a green run
# here means what a green CI run means. The root requirements.txt is unpinned and
# is NOT used for this reason.
REQ="backend-python/requirements.txt"
req_hash="$( (sha256sum "$REQ" 2>/dev/null || shasum -a 256 "$REQ" 2>/dev/null) | cut -c1-16)"

if [ -f "$MARKER_DIR/py-$req_hash.ok" ]; then
  say "  ✓ python deps already installed for this requirements hash — skipping"
  py_ok=1
else
  # uv resolves and installs this dependency set far faster than pip; fall back
  # cleanly if it is unavailable rather than making it a hard requirement.
  PIP_INSTALL="python3 -m pip install --quiet"
  if python3 -m pip install --quiet uv >/dev/null 2>&1 && python3 -m uv --version >/dev/null 2>&1; then
    PIP_INSTALL="python3 -m uv pip install --system --quiet"
    say "  … using uv"
  fi

  # Prefer the CPU torch wheel so a GPU-less container doesn't carry several GB of
  # unusable nvidia-* libraries.
  #
  # ORDER MATTERS: installing the requirements file before CPU torch does NOT
  # produce a CPU build. `transformers` and `sentence-transformers` both depend
  # on torch, so the requirements install would already resolve the default
  # (CUDA) build, and a CPU install that followed would find the requirement
  # satisfied and do nothing. Measured 2026-08-13 with `uv pip install
  # --dry-run`: the CPU index resolves 0 nvidia/cuda packages,
  # `sentence-transformers==5.5.1` off the default index resolves 18.
  # Installing CPU torch FIRST is what makes it the build everything else
  # resolves against — same fix, and same reasoning, as ci.yml's
  # python-tests job.
  #
  # But treat the CPU index as OPTIONAL, not required. Some sandboxes reach PyPI
  # (pypi.org and files.pythonhosted.org are on the agent proxy's noProxy list)
  # while download.pytorch.org is a policy denial — measured here as a 403 on
  # CONNECT. Making CPU torch a hard prerequisite would turn a disk optimisation
  # into a total install failure in exactly that environment.
  tmp_req="$(mktemp)"
  grep -v '^torch' "$REQ" > "$tmp_req"

  $PIP_INSTALL torch --index-url https://download.pytorch.org/whl/cpu >/dev/null 2>&1 || true

  # Report what is actually installed, not what the command above intended. That
  # step exits 0 in two very different situations — it really fetched the CPU
  # wheel, or torch was already present (from a previous run, or as a transitive
  # dependency) so the requirement was satisfied without the index being touched
  # at all. Trusting its exit code prints "CPU build" over a CUDA install. A step
  # that reports success without checking what it produced is the failure mode
  # recurring-bugs.md records more often than any other; an installer gets no
  # exemption from it.
  torch_ver="$(python3 -c 'import torch; print(torch.__version__)' 2>/dev/null)"
  case "${torch_ver:-none}" in
    none)   say "  … torch not yet present; it will resolve as a dependency below" ;;
    *+cpu)  say "  ✓ torch $torch_ver — CPU build, no CUDA libraries" ;;
    *)      say "  ! torch $torch_ver — CUDA build (CPU index unreachable or torch pre-existing)."
            say "    Functionally fine, but carries ~16 nvidia-* packages this container cannot use." ;;
  esac

  if $PIP_INSTALL -r "$tmp_req" >/dev/null 2>&1; then
    touch "$MARKER_DIR/py-$req_hash.ok"; py_ok=1
    say "  ✓ python deps installed from $REQ (the pinned file CI uses)"
  else
    say "  ✗ python dependency install FAILED"
  fi
  rm -f "$tmp_req"
fi

# Report ----------------------------------------------------------------------
if [ "$node_ok" = 1 ] && [ "$py_ok" = 1 ]; then
  say ""
  say "[session-start] ready. Definition-of-done commands available:"
  say "    npx tsc --noEmit"
  say "    npx vitest run"
  say "    python -m pytest src/server/__tests__/ src/server/tests/"
  say "    npm run schema:drift          (needs a reachable POSTGRES_URL)"
  say ""
  say "  No Postgres/Redis/Ollama runs in this container. Anything needing a live DB —"
  say "  schema:drift, the live_datasource tests, any 'query the result back' verification"
  say "  CLAUDE.md asks for — cannot run here. Say so rather than reporting it as done."
else
  say ""
  say "  ============================================================"
  say "  DEPENDENCY INSTALL INCOMPLETE — node_ok=$node_ok py_ok=$py_ok"
  say "  The Definition-of-done checks CANNOT be run in this session."
  say "  Do not report a task as done, and do not describe any check as"
  say "  passing, on the basis of a suite that never executed."
  say "  ============================================================"
fi

exit 0
