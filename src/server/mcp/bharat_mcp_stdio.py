#!/usr/bin/env python3
"""Stdio launcher for the Bharat market-intelligence MCP surface.

The wire protocol lives in ``market_intelligence_mcp.run_stdio_server`` (hand-rolled
newline-delimited JSON-RPC, no ``mcp`` SDK). This file only fixes ``sys.path`` so it can be
started from any working directory. It exists so a client config can name a stable script path.

Default (no args): serves ``handle_mcp_request`` -- the full operations surface, including
``run_fetcher`` and ``run_alphaquant_backtest``. That is acceptable for a locally spawned stdio
child whose parent is the trust boundary; never expose it over a network transport.

``--read-only``: a decision agent must be handed THIS mode instead (AF-20260927-02) -- it
restricts both ``tools/list`` and ``tools/call`` to ``DECISION_READ_ONLY_TOOLS``, so an
autonomous agent's client config can point at this same stable script path and never even see
``run_fetcher``/``run_agent_role``/backtests as options.
"""

import os
import sys

_MCP_DIR = os.path.dirname(os.path.abspath(__file__))
_SERVER_DIR = os.path.dirname(_MCP_DIR)
for _p in (_MCP_DIR, _SERVER_DIR):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from market_intelligence_mcp import run_stdio_server  # noqa: E402

if __name__ == "__main__":
    run_stdio_server(read_only=(len(sys.argv) > 1 and sys.argv[1] == "--read-only"))
