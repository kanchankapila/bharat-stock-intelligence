"""
Chatbot FastAPI server. Started via:
    npm run chatbot      (uses backend-python/venv)
Or directly:
    backend-python/venv/Scripts/python.exe src/server/chatbot/app.py
"""
import json
import logging
import os
import sys
import asyncio
from contextlib import asynccontextmanager

# Make src/server/chatbot importable as a package
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from langchain_core.messages import HumanMessage

logging.basicConfig(level=logging.INFO, format="[chatbot] %(message)s")
logger = logging.getLogger(__name__)

DB_PATH = os.getenv("DB_PATH", "database.sqlite")
CHATBOT_PORT = int(os.getenv("CHATBOT_PORT", "8001"))
ALLOWED_ORIGIN = os.getenv("ALLOWED_ORIGIN", "http://localhost:3000")

_graph = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _graph
    logger.info("Starting up: building LangGraph agent...")
    try:
        from agent import build_graph
        _graph = build_graph(db_path=DB_PATH)
        logger.info("LangGraph agent ready")
    except Exception as e:
        logger.error(f"Failed to build agent: {e}", exc_info=True)

    # Run ingest if chroma_store is empty
    try:
        from ingest import run_full_ingest
        chroma_dir = os.getenv("CHROMA_PERSIST_DIR", "src/server/chatbot/chroma_store")
        if not os.path.exists(chroma_dir) or not os.listdir(chroma_dir):
            logger.info("ChromaDB empty — running initial ingest...")
            result = await asyncio.to_thread(run_full_ingest, DB_PATH)
            logger.info(f"Ingest complete: {result}")
        else:
            logger.info("ChromaDB already populated — skipping ingest")
    except Exception as e:
        logger.warning(f"Ingest skipped: {e}")

    yield
    logger.info("Shutting down chatbot server")


app = FastAPI(title="Bharat Stock AI Chatbot", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[ALLOWED_ORIGIN, "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatRequest(BaseModel):
    message: str
    session_id: str
    history: list[dict] = []


class ChatResponse(BaseModel):
    answer: str
    sources: list[str] = []


@app.get("/health")
async def health():
    from llm import get_llm
    try:
        llm = get_llm()
        llm_type = type(llm).__name__
    except Exception:
        llm_type = "unavailable"
    return {"status": "ok", "llm": llm_type, "graph_ready": _graph is not None}


@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    if _graph is None:
        raise HTTPException(status_code=503, detail="Agent not ready")
    config = {"configurable": {"thread_id": req.session_id}}
    try:
        result = await asyncio.to_thread(
            _graph.invoke,
            {
                "messages": [HumanMessage(content=req.message)],
                "intent": "",
                "stock_symbol": None,
                "retrieved_context": "",
                "sources": [],
            },
            config,
        )
        ai_msg = result["messages"][-1]
        return ChatResponse(answer=ai_msg.content, sources=result.get("sources", []))
    except Exception as e:
        logger.error(f"Chat error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/chat/stream")
async def chat_stream(req: ChatRequest):
    """SSE streaming endpoint — tokens sent as 'data: {"token": "..."}\n\n'."""
    if _graph is None:
        raise HTTPException(status_code=503, detail="Agent not ready")
    config = {"configurable": {"thread_id": req.session_id}}

    async def token_generator():
        try:
            async for event in _graph.astream_events(
                {
                    "messages": [HumanMessage(content=req.message)],
                    "intent": "",
                    "stock_symbol": None,
                    "retrieved_context": "",
                    "sources": [],
                },
                config=config,
                version="v2",
            ):
                kind = event.get("event", "")
                if kind == "on_chat_model_stream":
                    node = event.get("metadata", {}).get("langgraph_node", "")
                    if node == "synthesize_answer":
                        chunk = event["data"].get("chunk")
                        if chunk and hasattr(chunk, "content") and chunk.content:
                            payload = json.dumps({"token": chunk.content})
                            yield f"data: {payload}\n\n"
        except Exception as e:
            logger.error(f"Stream error: {e}")
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
        finally:
            yield "data: [DONE]\n\n"

    return StreamingResponse(token_generator(), media_type="text/event-stream")


@app.post("/ingest")
async def trigger_ingest():
    """Re-run ChromaDB ingest (called by nightly BullMQ job)."""
    try:
        from ingest import run_full_ingest
        result = await asyncio.to_thread(run_full_ingest, DB_PATH)
        return {"status": "ok", **result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    uvicorn.run("app:app", host="0.0.0.0", port=CHATBOT_PORT, reload=False)
