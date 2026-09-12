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


def get_top_conviction_picks(limit: int = 10, min_score: float = 60.0) -> List[Dict[str, Any]]:
    """Returns top conviction stock recommendations from unified_recommendations."""
    conn = connect()
    try:
        rows = conn.execute(
            """
            SELECT symbol, unified_score, recommendation_action, conviction_level, target_price, stop_loss, generated_at
            FROM unified_recommendations
            WHERE unified_score >= ? AND recommendation_action LIKE 'BUY%'
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
            return {"response": data.get("response", data), "success": True}
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
    else:
        return {"error": f"Unknown tool: {tool_name}"}


if __name__ == "__main__":
    if len(sys.argv) > 1:
        tool = sys.argv[1]
        args = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
        print(json.dumps(handle_mcp_request(tool, args), indent=2, default=str))
