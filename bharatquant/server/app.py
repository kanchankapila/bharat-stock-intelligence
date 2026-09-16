"""BharatQuant Desk FastAPI application."""
import logging
import time

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from bharatquant.server.db import init_pool
from bharatquant.server.config import ist_now, market_session, DEFAULT_CAPITAL, RISK_PER_TRADE
from bharatquant.server.engines import assemble

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

app = FastAPI(title="BharatQuant Desk", version="1.0.0")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.on_event("startup")
def _startup():
    init_pool()


@app.get("/api/health")
def health():
    return {"status": "ok", "time": ist_now().isoformat(), "session": market_session()}


@app.get("/api/board")
def board(refresh: bool = Query(False)):
    import traceback
    t0 = time.time()
    try:
        data = assemble.run_all(force=refresh)
        data["elapsed_s"] = round(time.time() - t0, 2)
        return data
    except Exception as e:
        return {"error": str(e), "trace": traceback.format_exc(), "elapsed_s": round(time.time() - t0, 2)}


@app.get("/api/stock/{symbol}")
def stock(symbol: str):
    import traceback
    try:
        symbol = symbol.upper().strip()
        data = assemble.stock_detail(symbol)
        if not data.get("found"):
            raise HTTPException(404, f"Symbol {symbol} not found")
        return data
    except HTTPException:
        raise
    except Exception as e:
        return {"error": str(e), "trace": traceback.format_exc()}


@app.get("/api/search")
def search(q: str = Query("", min_length=1), limit: int = Query(12, le=25)):
    import traceback
    try:
        q = q.strip().upper()
        univ = loaders.universe()
        if q:
            univ = univ[univ["symbol"].str.contains(q, regex=False) |
                      univ["name"].str.upper().str.contains(q, regex=False)]
        return {"results": [{"symbol": r["symbol"], "name": r["name"], "sector": r.get("sector")}
                            for _, r in univ.head(50).iterrows()]}
    except Exception as e:
        return {"error": str(e), "trace": traceback.format_exc()}


@app.get("/api/delivery")
def delivery():
    from ..data import loaders as ld
    d = ld.delivery_recent(15)
    if len(d) == 0:
        return {"results": []}
    last = d["date"].max()
    top = d[d["date"] == last].nlargest(10, "delivery_pct")
    return {"date": str(last), "results": top.to_dict("records")}


@app.get("/api/market")
def market():
    from ..data import loaders as ld
    idx = ld.daily_index("NIFTY50", 120)
    nifty = []
    if len(idx):
        for _, r in idx.iterrows():
            nifty.append({"date": str(r["date"].date()), "close": float(r["close"]),
                          "high": float(r["high"]), "low": float(r["low"])})
    fii = ld.fii_dii(20)
    return {"nifty": nifty,
            "fii": fii.to_dict("records"),
            "regime": assemble._regime(),
            "breadth": assemble._breadth()}