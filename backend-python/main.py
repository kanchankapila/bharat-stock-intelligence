from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import sys
import os

_here = os.path.dirname(os.path.abspath(__file__))
# Ensure app package is importable regardless of cwd
if _here not in sys.path:
    sys.path.insert(0, _here)
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

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8002, reload=False)
