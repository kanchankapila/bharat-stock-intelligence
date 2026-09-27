#!/usr/bin/env python3
"""
Persistent MCP client for tv-local (TradingView MCP).
Maintains a single connection to avoid spawn/timeout overhead.
"""

import json
import asyncio
import subprocess
import os
import sys
from typing import Dict, Any, Optional

class TVLocalMCPClient:
    def __init__(self, server_path: str = None):
        if server_path is None:
            server_path = os.path.expanduser("~/.hermes/tradingview-mcp/src/server.js")
        self.server_path = server_path
        self.process: Optional[asyncio.subprocess.Process] = None
        self.request_id = 0
        self._initialized = False
    
    async def start(self):
        """Start the MCP server process."""
        if self.process and self.process.returncode is None:
            return
        
        self.process = await asyncio.create_subprocess_exec(
            "node", self.server_path,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=os.path.dirname(self.server_path)
        )
        
        # Wait for startup message
        await asyncio.sleep(1)
        
        # Initialize MCP connection
        await self._send_request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "clientInfo": {"name": "bharat-client", "version": "1.0.0"}
        })
        self._initialized = True
    
    async def _send_request(self, method: str, params: Dict[str, Any] = None) -> Dict[str, Any]:
        """Send a JSON-RPC request and wait for response."""
        if not self._initialized:
            await self.start()
        
        self.request_id += 1
        request = {
            "jsonrpc": "2.0",
            "id": self.request_id,
            "method": method,
            "params": params or {}
        }
        
        # Send request
        request_line = json.dumps(request) + "\n"
        self.process.stdin.write(request_line.encode())
        await self.process.stdin.drain()
        
        # Read response
        response_line = await self.process.stdout.readline()
        if not response_line:
            raise Exception("Server closed connection")
        
        response = json.loads(response_line.decode().strip())
        
        if "error" in response:
            raise Exception(f"MCP Error: {response['error']}")
        
        return response.get("result", {})
    
    async def call_tool(self, name: str, arguments: Dict[str, Any] = None) -> Dict[str, Any]:
        """Call an MCP tool."""
        result = await self._send_request("tools/call", {
            "name": name,
            "arguments": arguments or {}
        })
        
        # Parse the text content from MCP response
        if isinstance(result, dict) and "content" in result:
            for content in result["content"]:
                if content.get("type") == "text":
                    try:
                        return json.loads(content["text"])
                    except json.JSONDecodeError:
                        return {"raw_text": content["text"]}
        return result
    
    async def list_tools(self) -> list:
        """List available tools."""
        result = await self._send_request("tools/list")
        return result.get("tools", [])
    
    async def health_check(self) -> Dict[str, Any]:
        return await self.call_tool("tv_health_check")
    
    async def launch(self) -> Dict[str, Any]:
        return await self.call_tool("tv_launch")
    
    async def get_chart_state(self) -> Dict[str, Any]:
        return await self.call_tool("chart_get_state")
    
    async def set_symbol(self, symbol: str) -> Dict[str, Any]:
        return await self.call_tool("chart_set_symbol", {"symbol": symbol})
    
    async def add_indicator(self, indicator: str) -> Dict[str, Any]:
        return await self.call_tool("chart_manage_indicator", {"action": "add", "indicator": indicator})
    
    async def get_study_values(self) -> Dict[str, Any]:
        return await self.call_tool("data_get_study_values")
    
    async def get_quote(self, symbol: str) -> Dict[str, Any]:
        return await self.call_tool("quote_get", {"symbol": symbol})
    
    async def get_ohlcv(self, summary: bool = True) -> Dict[str, Any]:
        return await self.call_tool("data_get_ohlcv", {"summary": summary})
    
    async def search_indicator(self, query: str) -> Dict[str, Any]:
        return await self.call_tool("indicator_search", {"query": query})
    
    async def screenshot(self, region: str = "chart") -> Dict[str, Any]:
        return await self.call_tool("capture_screenshot", {"region": region})
    
    async def close(self):
        if self.process:
            self.process.terminate()
            await self.process.wait()


# Sync wrapper for easy use
class TVLocalMCP:
    """Synchronous wrapper for the async client."""
    
    def __init__(self):
        self._client = TVLocalMCPClient()
        self._loop = None
    
    def _get_loop(self):
        if self._loop is None or self._loop.is_closed():
            self._loop = asyncio.new_event_loop()
            asyncio.set_event_loop(self._loop)
        return self._loop
    
    def _run(self, coro):
        loop = self._get_loop()
        return loop.run_until_complete(coro)
    
    def start(self):
        self._run(self._client.start())
    
    def health_check(self):
        self._run(self._client.health_check())
    
    def launch(self):
        return self._run(self._client.launch())
    
    def get_chart_state(self):
        return self._run(self._client.get_chart_state())
    
    def set_symbol(self, symbol: str):
        return self._run(self._client.set_symbol(symbol))
    
    def add_indicator(self, indicator: str):
        return self._run(self._client.add_indicator(indicator))
    
    def get_study_values(self):
        return self._run(self._client.get_study_values())
    
    def get_quote(self, symbol: str):
        return self._run(self._client.get_quote(symbol))
    
    def get_ohlcv(self, summary: bool = True):
        return self._run(self._client.get_ohlcv(summary))
    
    def search_indicator(self, query: str):
        return self._run(self._client.search_indicator(query))
    
    def screenshot(self, region: str = "chart"):
        return self._run(self._client.screenshot(region))
    
    def list_tools(self):
        return self._run(self._client.list_tools())
    
    def close(self):
        if self._client.process:
            self._run(self._client.close())


# Quick functions for common workflows
def analyze_symbol(symbol: str = "NSE:RELIANCE") -> Dict[str, Any]:
    """Full chart analysis for a symbol."""
    tv = TVLocalMCP()
    tv.start()
    
    try:
        # Set symbol
        tv.set_symbol(symbol)
        
        # Add standard indicators
        tv.add_indicator("Relative Strength Index")
        tv.add_indicator("Moving Average Convergence Divergence")
        tv.add_indicator("Bollinger Bands")
        
        # Get data
        state = tv.get_chart_state()
        studies = tv.get_study_values()
        quote = tv.get_quote(symbol)
        ohlcv = tv.get_ohlcv(summary=True)
        
        return {
            "symbol": symbol,
            "chart_state": state,
            "indicators": studies,
            "quote": quote,
            "ohlcv_summary": ohlcv
        }
    finally:
        tv.close()


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1:
        symbol = sys.argv[1]
    else:
        symbol = "NSE:RELIANCE"
    
    result = analyze_symbol(symbol)
    print(json.dumps(result, indent=2, default=str))