"""
Hermetic tests for mcp_client.py — the stdlib MCP JSON-RPC stdio client.

Uses a fake MCP server script (a ~40-line python file speaking the same newline-JSON
protocol) so the transport is exercised end-to-end — handshake, banner tolerance, tool
calls, timeouts, stderr flooding, process teardown — with zero network and zero DB,
per CLAUDE.md's unit-lane rules. The timeout test pins the 2026-09-01 live-failure fix:
a wedged server must raise McpError, never block forever.
"""

import os
import sys
import time

import pytest

SERVER_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, SERVER_DIR)

from mcp_client import McpError, McpStdioClient  # noqa: E402

FAKE_SERVER = r'''
import json, sys, time
mode = sys.argv[1] if len(sys.argv) > 1 else "ok"
for raw in sys.stdin:
    line = raw.strip()
    if not line.startswith("{"):
        continue
    try:
        msg = json.loads(line)
    except json.JSONDecodeError:
        continue
    rid, method = msg.get("id"), msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": rid, "result": {
            "protocolVersion": "2024-11-05", "capabilities": {},
            "serverInfo": {"name": "fake", "version": "0"}}}), flush=True)
    elif method == "notifications/initialized":
        pass
    elif method == "tools/list":
        if mode == "banner":
            print("WELCOME TO FAKE MCP SERVER v0", flush=True)
            print("loading 42 tools...", flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": rid, "result": {"tools": [
            {"name": "echo", "description": "echo back"}]}}), flush=True)
    elif method == "tools/call":
        if mode == "sleep":
            time.sleep(60)          # wedged server: never replies
            continue
        if mode == "stderr_flood":
            sys.stderr.write("x" * 200000 + "\n")
            sys.stderr.flush()
        if mode == "iserror":
            print(json.dumps({"jsonrpc": "2.0", "id": rid, "result": {
                "isError": True,
                "content": [{"type": "text", "text": "no data for symbol"}]}}), flush=True)
            continue
        print(json.dumps({"jsonrpc": "2.0", "id": rid, "result": {
            "content": [{"type": "text", "text": "echo-ok"}]}}), flush=True)
'''


def _make_client(tmp_path, mode: str, **kwargs) -> McpStdioClient:
    script = tmp_path / "fake_mcp_server.py"
    script.write_text(FAKE_SERVER, encoding="utf-8")
    return McpStdioClient([sys.executable, str(script), mode], **kwargs)


class TestMcpStdioClient:
    def test_roundtrip_banner_tolerance_and_context_manager(self, tmp_path):
        with _make_client(tmp_path, "banner") as mcp:
            tools = mcp.list_tools()
            assert [t["name"] for t in tools] == ["echo"]
            assert mcp.call_tool("echo", {"x": 1}) == "echo-ok"

    def test_wedged_server_times_out_instead_of_hanging_forever(self, tmp_path):
        t0 = time.monotonic()
        with pytest.raises(McpError, match="timed out"):
            with _make_client(tmp_path, "sleep", call_timeout=1.5) as mcp:
                mcp.call_tool("echo", {})
        assert time.monotonic() - t0 < 15  # bounded, not the old infinite readline

    def test_iserror_envelope_raises_mcp_error(self, tmp_path):
        with _make_client(tmp_path, "iserror") as mcp:
            with pytest.raises(McpError, match="isError"):
                mcp.call_tool("echo", {})

    def test_stderr_flood_cannot_deadlock_the_channel(self, tmp_path):
        # pre-fix behavior: 200KB of stderr fills the OS pipe buffer -> child blocks
        with _make_client(tmp_path, "stderr_flood") as mcp:
            assert mcp.call_tool("echo", {}) == "echo-ok"

    def test_close_terminates_the_child_process(self, tmp_path):
        mcp = _make_client(tmp_path, "ok")
        mcp.start()
        proc = mcp._proc
        assert proc is not None and proc.poll() is None
        mcp.close()
        assert mcp._proc is None
        assert proc.poll() is not None
        mcp.close()  # idempotent

    def test_dead_server_stdout_close_raises_immediately(self, tmp_path):
        mcp = _make_client(tmp_path, "ok")
        mcp.start()
        mcp._proc.kill()
        mcp._proc.wait(timeout=5)
        # Which message fires is platform-dependent: the broken stdin write (EINVAL
        # -> "stdin closed") usually wins on Windows, the reader-thread EOF
        # ("stdout closed") on Unix — either way it must be an immediate McpError.
        with pytest.raises(McpError, match=r"(stdout closed|stdin closed)"):
            mcp.call_tool("echo", {})
        mcp.close()

