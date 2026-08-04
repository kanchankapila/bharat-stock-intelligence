"""
FastAPI entry point for the Bharat Stock Intelligence Python engine cluster.

All heavy engines live in src/server/ (the canonical location). This file:
  1. Adds src/server to sys.path so every engine can import db_compat, sql_translate, etc.
  2. Exposes HTTP endpoints the Node.js server calls via pythonApi.ts.

Port: PYTHON_PORT env var (default 8002).
"""
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import sys
import os
import asyncio
import logging
from logging.handlers import TimedRotatingFileHandler
from concurrent.futures import ThreadPoolExecutor

_executor = ThreadPoolExecutor(max_workers=4)

async def run_in_thread(fn, *args, **kwargs):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(_executor, lambda: fn(*args, **kwargs))

# ── Path setup ────────────────────────────────────────────────────────────────
# Canonical engine directory — all Python engines live here.
_here = os.path.dirname(os.path.abspath(__file__))
_project_root = os.path.abspath(os.path.join(_here, ".."))
_src_server = os.path.join(_project_root, "src", "server")

# Ensure src/server is importable (db_compat, sql_translate, ml_ensemble, etc.)
if _src_server not in sys.path:
    sys.path.insert(0, _src_server)
# Also add project root so local scripts can find each other
if _project_root not in sys.path:
    sys.path.insert(0, _project_root)
# The `app` package (pcr_engine, portfolio_analytics) lives alongside this file, not under
# src/server or project root -- os.chdir() below moves CWD away from here, so the '' sys.path
# entry no longer resolves it; this dir must be added explicitly.
if _here not in sys.path:
    sys.path.insert(0, _here)

# Always run with the project root as CWD so relative paths in engines resolve correctly.
os.chdir(_project_root)

# ── Load .env ─────────────────────────────────────────────────────────────────
# Must happen BEFORE any db_compat import so the correct DB engine is selected.
_env_path = os.path.join(_project_root, ".env")
if os.path.exists(_env_path):
    with open(_env_path, "r", encoding="utf-8") as _ef:
        for _line in _ef:
            _line = _line.strip()
            if not _line or _line.startswith("#") or "=" not in _line:
                continue
            _k, _, _v = _line.partition("=")
            os.environ.setdefault(_k.strip(), _v.strip().strip('"').strip("'"))

# ── Windows console encoding fix ─────────────────────────────────────────────
# Prevents UnicodeEncodeError on ₹, →, etc. when running under pm2 / cmd.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(title="Bharat Stock Intelligence — AI & Quant Engine")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Logging ───────────────────────────────────────────────────────────────────
log_dir = os.path.join(_project_root, "logs")
os.makedirs(log_dir, exist_ok=True)

logger = logging.getLogger("PythonAPI")
logger.setLevel(logging.INFO)
if not logger.handlers:
    _fmt = logging.Formatter("%(asctime)s - %(name)s - %(levelname)s - %(message)s")
    _ch = logging.StreamHandler()
    _ch.setFormatter(_fmt)
    logger.addHandler(_ch)
    _fh = TimedRotatingFileHandler(
        os.path.join(log_dir, "fastapi.log"), when="midnight", interval=1, backupCount=14
    )
    _fh.setFormatter(_fmt)
    logger.addHandler(_fh)


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error(f"Unhandled exception on {request.url}: {exc}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={"message": "Internal Server Error", "details": str(exc)},
    )


# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/health")
def health_check():
    return {"status": "ok", "service": "Bharat Stock Intelligence FastAPI"}


# ── Backtester ────────────────────────────────────────────────────────────────
# Uses the canonical src/server/backtester.py (full version with slippage + commissions).

from backtester import run_backtest, BacktestRequest, run_walk_forward_optimize, WalkForwardRequest  # type: ignore

@app.post("/api/v1/backtest")
def api_run_backtest(req: BacktestRequest):
    return run_backtest(req)

@app.post("/api/v1/walk-forward-optimize")
def api_walk_forward_optimize(req: WalkForwardRequest):
    return run_walk_forward_optimize(req)


# ── TradingView bridge ────────────────────────────────────────────────────────

from tv_bridge import get_ta, get_ideas, get_screener  # type: ignore


class TvTaRequest(BaseModel):
    symbol: str
    exchange: str = "NSE"


@app.post("/api/v1/tv/ta")
def api_tv_ta(req: TvTaRequest):
    return get_ta(req.symbol, req.exchange)


@app.get("/api/v1/tv/screener")
def api_tv_screener():
    return get_screener()


# ── Early Hours Predictor ─────────────────────────────────────────────────────

class EarlySpotterRequest(BaseModel):
    date: str = None


@app.post("/api/v1/early_spotter")
def api_run_early_spotter(req: EarlySpotterRequest):
    try:
        import early_hours_predictor  # type: ignore
        candidates = early_hours_predictor.run_predictor(req.date)
        return {"success": True, "date": req.date, "candidates": candidates}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Strategy Optimizer ────────────────────────────────────────────────────────

from strategy_optimizer import run_optimizer, OptimizeRequest  # type: ignore


@app.post("/api/v1/optimize")
def api_run_optimizer(req: OptimizeRequest):
    return run_optimizer(req)


# ── AlphaQuant Scoring Engine ─────────────────────────────────────────────────

from scoring_engine import run_scoring, ScoringRequest  # type: ignore


@app.post("/api/v1/score")
def api_run_scoring(req: ScoringRequest):
    return run_scoring(req)


# ── PCR Engine ────────────────────────────────────────────────────────────────

from app.pcr_engine import run_pcr_fetch, get_latest_pcr, PcrRequest  # type: ignore


@app.post("/api/v1/options/pcr")
def api_fetch_pcr(req: PcrRequest):
    return run_pcr_fetch(req)


@app.get("/api/v1/options/pcr")
def api_get_pcr():
    return get_latest_pcr()


# ── Portfolio Analytics ────────────────────────────────────────────────────────

from app.portfolio_analytics import analyze_portfolio, PortfolioRequest  # type: ignore


@app.post("/api/v1/portfolio/analyze")
def api_portfolio_analyze(req: PortfolioRequest):
    return analyze_portfolio(req)


# ── Risk Metrics Engine ───────────────────────────────────────────────────────

class RiskMetricsRequest(BaseModel):
    symbol: str = None   # None = run all symbols
    window_days: int = 252


@app.post("/api/v1/risk_metrics")
async def api_risk_metrics(req: RiskMetricsRequest):
    try:
        import risk_metrics_engine  # type: ignore
        result = await run_in_thread(risk_metrics_engine.run, symbol=req.symbol, window_days=req.window_days)
        return {"status": "success", "result": result}
    except Exception as e:
        logger.error(f"Risk metrics error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ── Multi-Factor Scorer ────────────────────────────────────────────────────────

class MultiFactorRequest(BaseModel):
    force_recompute: bool = False


@app.post("/api/v1/multi_factor_score")
async def api_multi_factor_score(req: MultiFactorRequest):
    try:
        import multi_factor_scorer  # type: ignore
        result = await run_in_thread(multi_factor_scorer.run, force=req.force_recompute)
        return {"status": "success", "result": result}
    except Exception as e:
        logger.error(f"Multi-factor scoring error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ── ML Orchestration Endpoints ────────────────────────────────────────────────

@app.post("/api/score-pending")
async def score_pending():
    """Triggers ML Ensemble Scoring via the canonical src/server/ml_ensemble.py."""
    try:
        import ml_ensemble  # type: ignore — resolved from src/server via sys.path
        logger.info("Starting ml_ensemble.run(do_train=False, do_score=True)")
        await run_in_thread(ml_ensemble.run, do_train=False, do_score=True)
        logger.info("Finished ml_ensemble.run")
        return {"status": "success"}
    except Exception as e:
        logger.error(f"Error in score_pending: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/train-dl")
async def train_dl():
    """Triggers DL Trainer."""
    try:
        import dl_engine  # type: ignore
        logger.info("Starting dl_engine.train_lstm()")
        await run_in_thread(dl_engine.train_lstm, version=1)
        logger.info("Finished dl_engine.train_lstm()")
        return {"status": "success"}
    except Exception as e:
        logger.error(f"Error in train_dl: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/resolve-outcomes")
async def resolve_outcomes_endpoint(horizon: int = 15):
    """Triggers Outcome Resolver for a specific horizon."""
    try:
        import outcome_resolver  # type: ignore
        logger.info(f"Starting outcome_resolver (horizon={horizon})")
        await run_in_thread(outcome_resolver.run, horizon_days=horizon)
        logger.info("Finished outcome_resolver")
        return {"status": "success"}
    except Exception as e:
        logger.error(f"Error in resolve_outcomes: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/infer-dl")
async def infer_dl():
    """Triggers DL Inference."""
    try:
        import dl_engine  # type: ignore
        logger.info("Starting dl_engine.run_inference()")
        await run_in_thread(dl_engine.run_inference)
        logger.info("Finished dl_engine.run_inference()")
        return {"status": "success"}
    except Exception as e:
        logger.error(f"Error in infer_dl: {e}")
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PYTHON_PORT", 8002))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
