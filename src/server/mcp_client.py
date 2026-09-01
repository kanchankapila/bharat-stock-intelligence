#!/usr/bin/env python3
"""
Minimal MCP (Model Context Protocol) stdio client — stdlib only.

Why this exists: DalalOS's and FinStack's REST surfaces are plan-gated or absent, but BOTH
ship MCP servers that work. This module speaks the MCP JSON-RPC 2.0 protocol over stdio so
scheduled fetchers in this repo can call MCP tools directly — spawning the same server
command the interactive Claude config uses (e.g. `python -m finstack.server`), performing
the initialize handshake, listing tools, and calling them. One long-lived server process
per fetcher run; each tool call is one JSON-RPC round-trip.

Protocol notes (matches the official MCP python SDK's stdio transport):
  - messages are newline-delimited JSON on the child's stdout, one object per line;
    servers may emit non-JSON banner/log lines, which we skip
  - handshake: client -> initialize request, server -> result, client -> initialized
    notification (no id, no reply expected)
  - responses are correlated by integer `id`; notifications have no id and are ignored
  - tools/call result: {content: [{type: "text", text: ...}], isError?: bool}

Usage as a library:
    with McpStdioClient(["python", "-m", "finstack.server"]) as mcp:
        tools = mcp.list_tools()
        result = mcp.call_tool("cash_flow", {"symbol": "INFY", "quarterly": True})

Usage as a CLI (debugging / tool inventory):
    python mcp_client.py --list-tools
    python mcp_client.py --call cash_flow --args '{"symbol": "INFY", "quarterly": true}'
    python mcp_client.py --server-cmd "python -m finstack.server" --list-tools
"""

import argparse
import json
import os
import subprocess
import sys

# Default matches the user's own mcpServers entry for finstack (stdio, system python).
DEFAULT_SERVER_CMD = ["python", "-m", "finstack.server"]

INITIALIZE_TIMEOUT_SEC = 30
CALL_TIMEOUT_SEC = 120

PROTOCOL_VERSION = "2024-11-05"


class McpError(RuntimeError):
    """Raised when the server replies with an error or an unparseable message."""


def build_initialize_request(req_id: int) -> dict:
    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "method": "initialize",
        "params": {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "bharat-intel", "version": "1.0"},
        },
    }


def build_initialized_notification() -> dict:
    return {"jsonrpc": "2.0", "method": "notifications/initialized"}


def build_tools_list_request(req_id: int) -> dict:
    return {"jsonrpc": "2.0", "id": req_id, "method": "tools/list"}


def build_tools_call_request(req_id: int, name: str, arguments: dict | None) -> dict:
    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "method": "tools/call",
        "params": {"name": name, "arguments": arguments or {}},
    }


def extract_result_text(response: dict) -> str:
    """Pull the concatenated text payload out of a tools/call result envelope."""
    if "error" in response and response["error"]:
        raise McpError(f"JSON-RPC error: {response['error']}")
    result = response.get("result") or {}
    if result.get("isError"):
        raise McpError(f"tool reported isError: {result.get('content')}")
    chunks = [
        block.get("text", "")
        for block in (result.get("content") or [])
        if isinstance(block, dict) and block.get("type") == "text"
    ]
    return "\n".join(chunks)


class McpStdioClient:
    """Spawn an MCP server as a subprocess and speak JSON-RPC 2.0 over its stdio."""

    def __init__(self, cmd: list[str] | None = None):
        cmd = cmd or os.environ.get("MCP_SERVER_CMD", "").split() or list(DEFAULT_SERVER_CMD)
        self._cmd = cmd.split() if isinstance(cmd, str) else list(cmd)
        self._proc: subprocess.Popen | None = None
        self._next_id = 1

    # -- process lifecycle ---------------------------------------------------

    def __enter__(self) -> "McpStdioClient":
        self.start()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def start(self) -> None:
        if self._proc is not None:
            return
        # stderr pipes to OUR stderr (never the JSON channel); text mode, line buffered.
        self._proc = subprocess.Popen(
            self._cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        self._initialize()

    def close(self) -> None:
        if self._proc is None:
            return
        try:
            if self._proc.stdin:
                self._proc.stdin.close()
            self._proc.terminate()
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._proc.kill()
                self._proc.wait(timeout=5)
        except Exception:
            pass
        self._proc = None

    # -- protocol ------------------------------------------------------------

    def _send(self, message: dict) -> None:
        assert self._proc is not None and self._proc.stdin is not None
        self._proc.stdin.write(json.dumps(message, separators=(",", ":")) + "\n")
        self._proc.stdin.flush()

    def _recv_until_id(self, want_id: int) -> dict:
        """Read stdout lines until the response with `want_id` arrives. Notifications and
        responses to other requests are skipped. Non-JSON lines (banners) are ignored.
        A wedged server is bounded by the fetcher's own BullMQ budget, not here."""
        assert self._proc is not None and self._proc.stdout is not None
        while True:
            line = self._proc.stdout.readline()
            if not line:
                raise McpError(
                    f"server stdout closed while waiting for response id={want_id} "
                    f"(rc={self._proc.poll()})"
                )
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(msg, dict) and msg.get("id") == want_id:
                return msg

    def _request(self, builder, **kwargs) -> dict:
        self.start()
        req_id = self._next_id
        self._next_id += 1
        self._send(builder(req_id, **kwargs))
        return self._recv_until_id(req_id)

    def _initialize(self) -> dict:
        resp = self._request(build_initialize_request)
        if "error" in resp and resp["error"]:
            raise McpError(f"initialize failed: {resp['error']}")
        self._send(build_initialized_notification())
        return resp.get("result") or {}

    # -- public API ----------------------------------------------------------

    def list_tools(self) -> list[dict]:
        resp = self._request(build_tools_list_request)
        return (resp.get("result") or {}).get("tools") or []

    def call_tool(self, name: str, arguments: dict | None = None) -> str:
        """Call a tool, returning its concatenated text content. Raises McpError on
        transport/protocol errors AND on isError envelopes — callers who want the raw
        envelope (e.g. finstack's {"error": true, "message": ...} business errors) use
        call_tool_raw instead."""
        return extract_result_text(
            self._request(build_tools_call_request, name=name, arguments=arguments)
        )

    def call_tool_raw(self, name: str, arguments: dict | None = None) -> dict:
        return self._request(build_tools_call_request, name=name, arguments=arguments)


def main() -> int:
    parser = argparse.ArgumentParser(description="Call tools on an MCP stdio server")
    parser.add_argument("--server-cmd", default=None,
                        help="server command as a string, e.g. 'python -m finstack.server'")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--list-tools", action="store_true")
    group.add_argument("--call", metavar="TOOL")
    parser.add_argument("--args", default="{}", help="JSON object of tool arguments")
    parsed = parser.parse_args()

    cmd = parsed.server_cmd.split() if parsed.server_cmd else None
    with McpStdioClient(cmd) as mcp:
        if parsed.list_tools:
            for tool in mcp.list_tools():
                desc = (tool.get("description") or "").splitlines()[0][:100]
                print(f"{tool.get('name')}: {desc}")
        else:
            print(mcp.call_tool(parsed.call, json.loads(parsed.args)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
