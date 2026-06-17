from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import sys
import os
import asyncio
from concurrent.futures import ThreadPoolExecutor

_executor = ThreadPoolExecutor(max_workers=4)

async def run_in_thread(fn, *args, **kwargs):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(_executor, lambda: fn(*args, **kwargs))

_here = os.path.dirname(os.path.abspath(__file__))
# Ensure app package is importable regardless of cwd
if _here not in sys.path:
    sys.path.insert(0, _here)
# Add src/server to path so we can import ML orchestration scripts
src_server_path = os.path.abspath(os.path.join(_here, "..", "src", "server"))
if src_server_path not in sys.path:
    sys.path.append(src_server_path)
# Resolve database.sqlite relative to project root, not launch dir
os.chdir(os.path.join(_here, ".."))

app = FastAPI(title="Bharat Stock Intelligence - AI & Quant Engine")

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allows all origins
    allow_credentials=True,
    allow_methods=["*"],  # Allows all methods
    allow_headers=["*"],  # Allows all headers
)

@app.get("/health")
def health_check():
    return {"status": "ok", "service": "Bharat Stock Intelligence FastAPI"}

# Import routers/functions
from app.backtester import run_backtest, BacktestRequest

@app.post("/api/v1/backtest")
def api_run_backtest(req: BacktestRequest):
    return run_backtest(req)

from app.tv_bridge import get_ta, get_ideas, get_screener

class TvTaRequest(BaseModel):
    symbol: str
    exchange: str = "NSE"

from app.strategy_optimizer import run_optimizer, OptimizeRequest

@app.post("/api/v1/optimize")
def api_run_optimizer(req: OptimizeRequest):
    return run_optimizer(req)

from app.scoring_engine import run_scoring, ScoringRequest

@app.post("/api/v1/score")
def api_run_scoring(req: ScoringRequest):
    return run_scoring(req)

from app.technical_analysis_engine import run_ta_engine

@app.post("/api/v1/ta_engine")
def api_run_ta_engine():
    return run_ta_engine()

from app.pcr_engine import run_pcr_fetch, get_latest_pcr, PcrRequest

@app.post("/api/v1/options/pcr")
def api_fetch_pcr(req: PcrRequest):
    return run_pcr_fetch(req)

@app.get("/api/v1/options/pcr")
def api_get_pcr():
    return get_latest_pcr()

from app.portfolio_analytics import analyze_portfolio, PortfolioRequest

@app.post("/api/v1/portfolio/analyze")
def api_portfolio_analyze(req: PortfolioRequest):
    return analyze_portfolio(req)

@app.post("/api/v1/tv/ta")
def api_tv_ta(req: TvTaRequest):
    return get_ta(req.symbol, req.exchange)

@app.get("/api/v1/tv/screener")
def api_tv_screener():
    return get_screener()

# --- ML Orchestration Endpoints ---
import logging
from fastapi import HTTPException
import ml_ensemble
import dl_engine
import outcome_resolver

logger = logging.getLogger("PythonAPI")

@app.post("/api/score-pending")
async def score_pending():
    """Triggers ML Ensemble Scoring"""
    try:
        logger.info("Starting ml_ensemble.run(do_train=False, do_score=True)")
        await run_in_thread(ml_ensemble.run, do_train=False, do_score=True)
        logger.info("Finished ml_ensemble.run")
        return {"status": "success"}
    except Exception as e:
        logger.error(f"Error in score_pending: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/train-dl")
async def train_dl():
    """Triggers DL Trainer"""
    try:
        logger.info("Starting dl_engine.train_lstm()")
        await run_in_thread(dl_engine.train_lstm, version=1)
        logger.info("Finished dl_engine.train_lstm()")
        return {"status": "success"}
    except Exception as e:
        logger.error(f"Error in train_dl: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/resolve-outcomes")
async def resolve_outcomes(horizon: int):
    """Triggers Outcome Resolver for a specific horizon"""
    try:
        logger.info(f"Starting outcome_resolver (horizon={horizon})")
        await run_in_thread(outcome_resolver.run, horizon_days=horizon)
        logger.info("Finished outcome_resolver")
        return {"status": "success"}
    except Exception as e:
        logger.error(f"Error in outcome_resolver: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/infer-dl")
async def infer_dl():
    """Triggers DL Inference"""
    try:
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
