# Early torch initialization to avoid Windows C10/CUDA DLL collision (WinError 1114)
try:
    import torch
except Exception:
    pass

import asyncio
import polars as pl
import os
import sys
import logging
from concurrent.futures import ThreadPoolExecutor
from fastapi import FastAPI, HTTPException
import uvicorn

# Ensure the server directory is in path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

import ml_ensemble
import outcome_resolver
import dl_engine

logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")
logger = logging.getLogger("PythonAPI")

app = FastAPI(title="Bharat Stock Intelligence - ML Orchestration API")

# The engine calls below block for minutes. Inline in async handlers they freeze the event
# loop for the whole service — health probes time out, and the Node client's own timeout then
# fires its runPython fallback while the HTTP run is still going (double-running the same
# job). Offload to a threadpool, same pattern as backend-python/main.py's run_in_thread.
_executor = ThreadPoolExecutor(max_workers=4)


async def run_in_thread(fn, *args, **kwargs):
    """Run a blocking function in the thread pool without blocking the event loop."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(_executor, lambda: fn(*args, **kwargs))

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
async def resolve_outcomes(horizon: int = 15):
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
    port = int(os.environ.get("PYTHON_API_PORT", 8000))
    logger.info(f"Starting Python API on port {port}...")
    uvicorn.run("python_api:app", host="127.0.0.1", port=port, reload=False)

