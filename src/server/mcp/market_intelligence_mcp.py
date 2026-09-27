"""
Bharat Stock Intelligence — Model Context Protocol (MCP) Server.

Exposes structured market intelligence, stock scoring, pipeline health, RAG search,
and autonomous agent triggers for AI co-pilots and agents without giving raw
unstructured SQL execution rights.
"""

import json
import os
import re
import sys
import subprocess
import urllib.request
import urllib.error
from typing import Any, Dict, List, Optional

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Review guard (2026-09-13): MCP tool arguments reach subprocess argv and file paths, and the
# callers are LLM agents. Only plain identifiers are accepted wherever a name becomes a path
# segment or a CLI flag: a name like '../x' must never resolve outside src/server, and a value
# starting with '-' must never smuggle extra flags into the child process.
_IDENT_RE = re.compile(r"^[A-Za-z0-9_]+$")


def _require_identifier(value: Any, what: str) -> Optional[str]:
    """Returns an error string when `value` is not a plain identifier, else None."""
    if not isinstance(value, str) or not _IDENT_RE.match(value):
        return f"Invalid {what}: must match [A-Za-z0-9_]+"
    return None

from db_compat import connect, query_all, query_one
from semantic_evidence import get_decision_evidence, get_entity_graph, ontology_context
from semantic_identity import resolve_identifier

# Import TV Local client
try:
    from tv_local_client import TVLocalMCP, analyze_symbol as tv_analyze_symbol
    TV_LOCAL_AVAILABLE = True
except ImportError as e:
    TV_LOCAL_AVAILABLE = False
    TV_LOCAL_IMPORT_ERROR = str(e)


def get_top_conviction_picks(limit: int = 10, min_score: float = 60.0) -> List[Dict[str, Any]]:
    """Returns top conviction stock recommendations from unified_recommendations."""
    conn = connect()
    try:
        rows = conn.execute(
            """
            SELECT symbol, unified_score, classification, conviction_level,
                   target_1 AS target_price, stop_loss, generated_at
            FROM unified_recommendations
            WHERE unified_score >= ?
              AND POSITION('BUY' IN UPPER(COALESCE(classification, ''))) > 0
            ORDER BY unified_score DESC
            LIMIT ?
            """,
            [min_score, limit],
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def analyze_stock_risk(symbol: str) -> Dict[str, Any]:
    """Retrieves risk score breakdown, volatility metrics, and score details for a given symbol."""
    conn = connect()
    try:
        score_row = conn.execute(
            "SELECT * FROM stock_scores WHERE symbol = ?", [symbol]
        ).fetchone()
        tech_row = conn.execute(
            "SELECT symbol, date, volume_ratio, win_probability, calibrated_win_probability, call_wall_dist_pct, put_wall_dist_pct FROM technical_signals WHERE symbol = ? ORDER BY date DESC LIMIT 1",
            [symbol],
        ).fetchone()

        return {
            "symbol": symbol,
            "stock_scores": dict(score_row) if score_row else None,
            "technical_signals": dict(tech_row) if tech_row else None,
        }
    finally:
        conn.close()


def get_ontology_context(question: str, max_chars: int = 2500) -> Dict[str, Any]:
    """Return deterministic semantic context and guardrails for an agent."""
    return ontology_context(question, max_chars=max_chars)


def get_semantic_decision_evidence(symbol: str, decision: Optional[str] = None) -> Dict[str, Any]:
    """Read the append-only decision evidence bundle without executing market code."""
    return get_decision_evidence(symbol, decision=decision)


def inspect_ingestion_health() -> Dict[str, Any]:
    """Queries pipeline health, recent data quality checks, job heartbeats, and DLQ errors."""
    conn = connect()
    try:
        heartbeats = conn.execute(
            "SELECT job_name, last_status, last_success_at, last_error FROM job_heartbeat "
            "ORDER BY last_run_at DESC NULLS LAST LIMIT 15"
        ).fetchall()
        dlq_summary = conn.execute(
            "SELECT fetcher_name, COUNT(*) as count FROM data_ingestion_dlq WHERE status = 'NEW' GROUP BY fetcher_name"
        ).fetchall()
        dq_fails = conn.execute(
            "SELECT check_id, status, detail, checked_at FROM data_quality_history WHERE status != 'PASS' ORDER BY checked_at DESC LIMIT 10"
        ).fetchall()

        return {
            "heartbeats": [dict(r) for r in heartbeats],
            "dlq_new_counts": [dict(r) for r in dlq_summary],
            "data_quality_issues": [dict(r) for r in dq_fails],
        }
    finally:
        conn.close()


def run_fetcher(fetcher_name: str, symbols: Optional[List[str]] = None, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Triggers a specific fetcher by name."""
    err = _require_identifier(fetcher_name, "fetcher_name")
    if err:
        return {"error": err, "success": False}
    server_dir = os.path.join(os.path.dirname(__file__), "..")
    fetcher_path = os.path.join(server_dir, f"{fetcher_name}.py")
    if not os.path.exists(fetcher_path):
        return {"error": f"Fetcher not found: {fetcher_name}.py", "success": False}

    args = []
    if symbols:
        args.extend(["--symbols", ",".join(symbols)])
    if params:
        for k, v in params.items():
            perr = _require_identifier(k, f"param name {k!r}")
            if perr:
                return {"error": perr, "success": False}
            args.extend([f"--{k}", str(v)])

    try:
        env = os.environ.copy()
        env["PYTHONPATH"] = server_dir
        env["PYTHONUNBUFFERED"] = "1"

        result = subprocess.run(
            [sys.executable, fetcher_path] + args,
            capture_output=True,
            text=True,
            timeout=3600,
            env=env,
            cwd=server_dir
        )
        return {
            "fetcher": fetcher_name,
            "exit_code": result.returncode,
            "stdout": result.stdout[-5000:] if result.stdout else "",
            "stderr": result.stderr[-5000:] if result.stderr else "",
            "success": result.returncode == 0
        }
    except subprocess.TimeoutExpired:
        return {"error": f"Fetcher {fetcher_name} timed out", "success": False}
    except Exception as e:
        return {"error": str(e), "success": False}


def list_fetchers() -> List[Dict[str, Any]]:
    """Lists all available fetchers with docstrings."""
    server_dir = os.path.join(os.path.dirname(__file__), "..")
    fetchers = []
    for f in os.listdir(server_dir):
        if f.endswith("_fetcher.py"):
            name = f[:-3]
            doc = ""
            try:
                with open(os.path.join(server_dir, f), "r", encoding="utf-8", errors="ignore") as fp:
                    head = fp.read(500)
                    if '"""' in head:
                        doc = head.split('"""')[1].strip().split('\n')[0]
            except Exception:
                pass
            fetchers.append({"name": name, "file": f, "description": doc})
    return sorted(fetchers, key=lambda x: x["name"])


def get_fetcher_status(fetcher_name: Optional[str] = None) -> List[Dict[str, Any]]:
    """Gets recent run status from job_heartbeat."""
    conn = connect()
    try:
        if fetcher_name:
            rows = conn.execute(
                "SELECT job_name, last_status, last_success_at, last_error, last_run_at FROM job_heartbeat "
                "WHERE job_name = ? ORDER BY last_run_at DESC NULLS LAST LIMIT 1",
                [fetcher_name]
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT job_name, last_status, last_success_at, last_error, last_run_at FROM job_heartbeat "
                "WHERE job_name LIKE '%fetcher%' OR job_name LIKE '%fetch%' "
                "ORDER BY last_run_at DESC NULLS LAST LIMIT 50"
            ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def requeue_dlq(fetcher_name: Optional[str] = None) -> Dict[str, Any]:
    """Removed 2026-09-13 (review M2): this used to relabel data_ingestion_dlq rows
    NEW -> RETRYING and report {"requeued": N}. Nothing consumes either status --
    base_fetcher.py only ever INSERTs 'NEW', worker_service.py's /ingestion/dlq only
    reads -- and payload_sample is truncated to 2000 chars, so the failed payloads
    cannot be reconstructed for a real re-run. A relabel that reports work it did not
    do is exactly recurring-bugs.md's "success that wrote nothing" class. Re-run a
    failed fetch with run_fetcher instead."""
    return {
"error": ("requeue_dlq is retired: the DLQ table keeps no reconstructable "
                  "payload and nothing consumes its status values. Re-run the fetcher "
                  "via run_fetcher instead."),
        "success": False,
    }


def query_market_rag(query_text: str, k: int = 5) -> Dict[str, Any]:
    """Queries ChromaDB / LangGraph RAG chatbot API (port 8001) for market intel & concalls."""
    port = int(os.getenv("CHATBOT_PORT", "8001"))
    url = f"http://127.0.0.1:{port}/chat"
    payload = json.dumps({"message": query_text, "stream": False}).encode("utf-8")
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return {
                "response": data.get("response", data),
                "sources": data.get("sources", []),
                "retrieval_semantics": "unstructured_context_not_decision_evidence",
                "success": True,
            }
    except Exception as e:
        # Fallback to direct DB query on concalls & filings
        conn = connect()
        try:
            concalls = conn.execute(
                "SELECT symbol, summary, key_takeaways, concall_date FROM concall_takeaways "
                "WHERE summary ILIKE ? OR key_takeaways ILIKE ? ORDER BY concall_date DESC LIMIT ?",
                [f"%{query_text}%", f"%{query_text}%", k]
            ).fetchall()
            return {
                "response": [dict(r) for r in concalls],
                "fallback": True,
                "error": str(e),
                "success": len(concalls) > 0
            }
        except Exception as db_err:
            return {"error": f"RAG failed: {e}; DB fallback failed: {db_err}", "success": False}
        finally:
            conn.close()


def run_alphaquant_backtest(factor: str, start_date: str = "2023-01-01", top_k: int = 50, purged: bool = True) -> Dict[str, Any]:
    """Runs parameterized factor backtest via factor_backtest.py."""
    err = _require_identifier(factor, "factor")
    if err:
        return {"error": err, "success": False}
    if not isinstance(start_date, str) or not re.match(r"^\d{4}-\d{2}-\d{2}$", start_date):
        return {"error": "Invalid start_date: must be YYYY-MM-DD", "success": False}
    try:
        top_k = int(top_k)
    except (TypeError, ValueError):
        return {"error": "Invalid top_k: must be an integer", "success": False}
    server_dir = os.path.join(os.path.dirname(__file__), "..")
    script = os.path.join(server_dir, "factor_backtest.py")
    if not os.path.exists(script):
        return {"error": "factor_backtest.py not found", "success": False}

    args = [sys.executable, script, "--factor", factor, "--start", start_date, "--top-k", str(top_k)]
    if purged:
        args.append("--allow-provisional")

    env = os.environ.copy()
    env["PYTHONPATH"] = server_dir
    try:
        res = subprocess.run(args, capture_output=True, text=True, timeout=900, env=env, cwd=server_dir)
        return {
            "factor": factor,
            "exit_code": res.returncode,
            "stdout": res.stdout[-4000:] if res.stdout else "",
            "stderr": res.stderr[-2000:] if res.stderr else "",
            "success": res.returncode == 0
        }
    except Exception as e:
        return {"error": str(e), "success": False}


def run_agent_role(agent_name: str) -> Dict[str, Any]:
    """Runs an autonomous agent role (data_scientist, strategist, auditor, optimizer)."""
    valid_agents = {
        "data_scientist": "agents/data_scientist_agent.py",
        "strategist": "agents/strategist_agent.py",
        "auditor": "agents/auditor_agent.py",
        "optimizer": "agents/optimizer_agent.py"
    }
    if agent_name not in valid_agents:
        return {"error": f"Invalid agent name. Choose from: {list(valid_agents.keys())}", "success": False}

    server_dir = os.path.join(os.path.dirname(__file__), "..")
    script = os.path.join(server_dir, valid_agents[agent_name])
    env = os.environ.copy()
    env["PYTHONPATH"] = server_dir

    try:
        res = subprocess.run([sys.executable, script], capture_output=True, text=True, timeout=2400, env=env, cwd=server_dir)
        return {
            "agent": agent_name,
            "exit_code": res.returncode,
            "stdout": res.stdout[-4000:] if res.stdout else "",
            "stderr": res.stderr[-2000:] if res.stderr else "",
            "success": res.returncode == 0
        }
    except Exception as e:
        return {"error": str(e), "success": False}


def handle_mcp_request(tool_name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
    """Dispatches tool execution requests from LLM agents."""
    if tool_name == "get_ontology_context":
        return {"result": get_ontology_context(
            str(arguments.get("question", "market data")),
            int(arguments.get("max_chars", 2500)),
        )}
    if tool_name == "get_decision_evidence":
        return {"result": get_semantic_decision_evidence(
            str(arguments.get("symbol", "")),
            arguments.get("decision"),
        )}
    if tool_name == "get_entity_graph":
        symbol = str(arguments.get("symbol", "")).upper().strip()
        result = get_entity_graph(
            symbol,
            limit=int(arguments.get("limit", 100)),
            as_of=arguments.get("as_of"),
        )
        return {"result": result}
    if tool_name == "resolve_instrument":
        return {"result": resolve_identifier(
            str(arguments.get("identifier", "")),
            arguments.get("provider"),
        )}
    if tool_name == "get_top_conviction_picks":
        limit = arguments.get("limit", 10)
        min_score = arguments.get("min_score", 60.0)
        return {"result": get_top_conviction_picks(limit, min_score)}
    elif tool_name == "analyze_stock_risk":
        symbol = arguments.get("symbol", "")
        return {"result": analyze_stock_risk(symbol)}
    elif tool_name == "inspect_ingestion_health":
        return {"result": inspect_ingestion_health()}
    elif tool_name == "run_fetcher":
        fetcher_name = arguments.get("fetcher_name", "")
        symbols = arguments.get("symbols")
        params = arguments.get("params")
        return {"result": run_fetcher(fetcher_name, symbols, params)}
    elif tool_name == "list_fetchers":
        return {"result": list_fetchers()}
    elif tool_name == "get_fetcher_status":
        fetcher_name = arguments.get("fetcher_name")
        return {"result": get_fetcher_status(fetcher_name)}
    elif tool_name == "query_market_rag":
        query_text = arguments.get("query_text", "")
        k = arguments.get("k", 5)
        return {"result": query_market_rag(query_text, k)}
    elif tool_name == "run_alphaquant_backtest":
        factor = arguments.get("factor", "value_book_to_price")
        start_date = arguments.get("start_date", "2023-01-01")
        top_k = arguments.get("top_k", 50)
        purged = arguments.get("purged", True)
        return {"result": run_alphaquant_backtest(factor, start_date, top_k, purged)}
    elif tool_name == "run_agent_role":
        agent_name = arguments.get("agent_name", "")
        return {"result": run_agent_role(agent_name)}
    elif tool_name == "analyze_tv_chart":
        if not TV_LOCAL_AVAILABLE:
            return {"error": f"TV Local client not available: {TV_LOCAL_IMPORT_ERROR}"}
        symbol = arguments.get("symbol", "NSE:RELIANCE")
        return {"result": tv_analyze_symbol(symbol)}
    elif tool_name == "tv_health_check":
        if not TV_LOCAL_AVAILABLE:
            return {"error": f"TV Local client not available: {TV_LOCAL_IMPORT_ERROR}"}
        tv = TVLocalMCP()
        tv.start()
        try:
            return {"result": tv.health_check()}
        finally:
            tv.close()
    else:
        return {"error": f"Unknown tool: {tool_name}"}


DECISION_READ_ONLY_TOOLS = frozenset({
    "get_ontology_context",
    "get_decision_evidence",
    "get_entity_graph",
    "resolve_instrument",
    "get_top_conviction_picks",
    "analyze_stock_risk",
    "inspect_ingestion_health",
    "get_fetcher_status",
    "query_market_rag",
})


def handle_read_only_mcp_request(tool_name: str, arguments: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Dispatch only bounded, read-only market-intelligence tools.

    Operational tools such as run_fetcher, requeue_dlq, backtests and agent
    execution intentionally do not belong to the decision-agent trust boundary.
    """
    if tool_name not in DECISION_READ_ONLY_TOOLS:
        return {
            "error": f"tool {tool_name!r} is not read-only; use the operations MCP surface",
            "allowed_tools": sorted(DECISION_READ_ONLY_TOOLS),
        }
    return handle_mcp_request(tool_name, arguments or {})


# name -> (description, inputSchema). Mirrors the elif chain in handle_mcp_request(); every
# tool_name accepted there must have an entry here, or a client can never discover/call it.
_TOOL_SCHEMAS: Dict[str, Dict[str, Any]] = {
    "get_ontology_context": {
        "description": "Free-text semantic context lookup over the platform's ontology.",
        "inputSchema": {"type": "object", "properties": {
            "question": {"type": "string"}, "max_chars": {"type": "integer"}}},
    },
    "get_decision_evidence": {
        "description": "Evidence backing a specific stock decision/recommendation.",
        "inputSchema": {"type": "object", "properties": {
            "symbol": {"type": "string"}, "decision": {"type": "string"}}, "required": ["symbol"]},
    },
    "get_entity_graph": {
        "description": "Entity relationship graph around a symbol (peers, sector, ownership).",
        "inputSchema": {"type": "object", "properties": {
            "symbol": {"type": "string"}, "limit": {"type": "integer"}, "as_of": {"type": "string"}},
            "required": ["symbol"]},
    },
    "resolve_instrument": {
        "description": "Resolve a free-text/provider identifier to the canonical NSE symbol.",
        "inputSchema": {"type": "object", "properties": {
            "identifier": {"type": "string"}, "provider": {"type": "string"}}, "required": ["identifier"]},
    },
    "get_top_conviction_picks": {
        "description": "Top BUY-classified stocks from unified_recommendations by unified_score.",
        "inputSchema": {"type": "object", "properties": {
            "limit": {"type": "integer"}, "min_score": {"type": "number"}}},
    },
    "analyze_stock_risk": {
        "description": "Risk profile for one symbol.",
        "inputSchema": {"type": "object", "properties": {"symbol": {"type": "string"}}, "required": ["symbol"]},
    },
    "inspect_ingestion_health": {
        "description": "Job heartbeats, DLQ depth, and open data-quality issues.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    "run_fetcher": {
        "description": "Trigger a named data fetcher, optionally scoped to symbols.",
        "inputSchema": {"type": "object", "properties": {
            "fetcher_name": {"type": "string"},
            "symbols": {"type": "array", "items": {"type": "string"}},
            "params": {"type": "object"}}, "required": ["fetcher_name"]},
    },
    "list_fetchers": {
        "description": "List every registered data fetcher.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    "get_fetcher_status": {
        "description": "Last-run status for one fetcher, or all fetchers when omitted.",
        "inputSchema": {"type": "object", "properties": {"fetcher_name": {"type": "string"}}},
    },
    "query_market_rag": {
        "description": "Semantic search over the market-news/research RAG index.",
        "inputSchema": {"type": "object", "properties": {
            "query_text": {"type": "string"}, "k": {"type": "integer"}}, "required": ["query_text"]},
    },
    "run_alphaquant_backtest": {
        "description": "Run an AlphaQuant factor backtest.",
        "inputSchema": {"type": "object", "properties": {
            "factor": {"type": "string"}, "start_date": {"type": "string"},
            "top_k": {"type": "integer"}, "purged": {"type": "boolean"}}},
    },
    "run_agent_role": {
        "description": "Invoke a named autonomous agent role.",
        "inputSchema": {"type": "object", "properties": {"agent_name": {"type": "string"}}, "required": ["agent_name"]},
    },
    "analyze_tv_chart": {
        "description": "TradingView-local technical chart analysis for a symbol.",
        "inputSchema": {"type": "object", "properties": {"symbol": {"type": "string"}}},
    },
    "tv_health_check": {
        "description": "Health check for the TradingView-local client.",
        "inputSchema": {"type": "object", "properties": {}},
    },
}


def _send_message(message: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, default=str) + "\n")
    sys.stdout.flush()


def _dispatch_rpc(method: str, params: Dict[str, Any], *, read_only: bool = False) -> Any:
    """Returns the JSON-RPC ``result`` payload for one request; raises for an unknown method
    (caller turns that into a JSON-RPC error response). ``read_only`` selects the dispatcher AND
    filters ``tools/list``, so a decision-agent client never even sees an operational tool as an
    option (AF-20260927-02: the read-only boundary must hold at both discovery and dispatch)."""
    if method == "initialize":
        return {
            "protocolVersion": params.get("protocolVersion", "2026-07-28"),
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "bharat-intelligence", "version": "1.0.0"},
        }
    if method == "tools/list":
        return {"tools": [
            {"name": name, "description": schema["description"], "inputSchema": schema["inputSchema"]}
            for name, schema in _TOOL_SCHEMAS.items()
            if not read_only or name in DECISION_READ_ONLY_TOOLS
        ]}
    if method == "tools/call":
        tool_name = params.get("name", "")
        arguments = params.get("arguments") or {}
        dispatch = handle_read_only_mcp_request if read_only else handle_mcp_request
        try:
            result = dispatch(tool_name, arguments)
        except Exception as exc:  # a tool's own bug must not take the whole server down
            return {"content": [{"type": "text", "text": f"tool {tool_name!r} raised: {exc}"}], "isError": True}
        return {"content": [{"type": "text", "text": json.dumps(result, default=str)}],
                "isError": bool(isinstance(result, dict) and result.get("error"))}
    raise ValueError(f"Unknown method: {method}")


def run_stdio_server(read_only: bool = False) -> None:
    """Newline-delimited JSON-RPC 2.0 loop over stdin/stdout — the wire format
    ``mcp.client.stdio.stdio_client`` speaks. No ``mcp`` SDK import here: this file's own
    package name (``mcp``, so ``-m mcp.market_intelligence_mcp`` can find it) shadows the real
    SDK package once PYTHONPATH puts src/server ahead of site-packages, so importing
    ``mcp.server``/``mcp.types`` from inside this module would resolve back to this same
    package and fail. Hand-rolling the JSON-RPC framing (verified against mcp==2.0.0's own
    ``mcp.types`` wire shapes) sidesteps that collision entirely.

    ``read_only=True`` is the ONLY entry point a decision agent may be handed (AF-20260927-02):
    it restricts both ``tools/list`` and ``tools/call`` to ``DECISION_READ_ONLY_TOOLS``. The
    default (``False``) serves the full operations surface, including ``run_fetcher`` and
    ``run_agent_role``, and is acceptable only for a locally spawned stdio child whose parent
    process is itself the trust boundary — never expose it over a network transport."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        msg_id = message.get("id")
        method = message.get("method", "")
        params = message.get("params") or {}
        if method in ("notifications/initialized", "notifications/cancelled"):
            continue  # notifications carry no id and expect no response
        try:
            result = _dispatch_rpc(method, params, read_only=read_only)
        except Exception as exc:
            if msg_id is not None:
                _send_message({"jsonrpc": "2.0", "id": msg_id,
                                "error": {"code": -32601, "message": str(exc)}})
            continue
        if msg_id is not None:
            _send_message({"jsonrpc": "2.0", "id": msg_id, "result": result})


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] != "--read-only":
        tool = sys.argv[1]
        args = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
        print(json.dumps(handle_mcp_request(tool, args), indent=2, default=str))
    else:
        run_stdio_server(read_only=(len(sys.argv) > 1 and sys.argv[1] == "--read-only"))
