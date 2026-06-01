import os
import sys
import logging
from fastapi import FastAPI, BackgroundTasks, HTTPException
import uvicorn

# Ensure the server directory is in path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

import ml_ensemble
import dl_trainer
import outcome_resolver
import dl_engine

logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")
logger = logging.getLogger("PythonAPI")

app = FastAPI(title="Bharat Stock Intelligence - ML Orchestration API")

@app.post("/api/score-pending")
async def score_pending():
    """Triggers ML Ensemble Scoring"""
    try:
        logger.info("Starting ml_ensemble.score_pending()")
        ml_ensemble.score_pending()
        logger.info("Finished ml_ensemble.score_pending()")
        return {"status": "success"}
    except Exception as e:
        logger.error(f"Error in score_pending: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/train-dl")
async def train_dl():
    """Triggers DL Trainer"""
    try:
        logger.info("Starting dl_engine.train_lstm()")
        dl_engine.train_lstm(version=1)
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
        outcome_resolver.run(horizon_days=horizon)
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
        dl_engine.run_inference()
        logger.info("Finished dl_engine.run_inference()")
        return {"status": "success"}
    except Exception as e:
        logger.error(f"Error in infer_dl: {e}")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    logger.info(f"Starting Python API on port {port}...")
    uvicorn.run("python_api:app", host="127.0.0.1", port=port, reload=False)
