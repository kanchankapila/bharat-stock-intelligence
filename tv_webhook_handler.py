"""
Bharat Stock Intelligence — TradingView Webhook Handler
Receives TradingView alerts, validates against quant model risk gates, executes if approved.
Add to: src/server/router.ts as a new tRPC endpoint or standalone FastAPI endpoint.
"""
from fastapi import FastAPI, Request, HTTPException, Header
from pydantic import BaseModel, Field
from typing import Optional, Literal
import os
import sys
import json
import hmac
import hashlib
import httpx
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from db_compat import connect

app = FastAPI(title="Bharat TV Webhook Handler")

# ─── Models ───
class TVAlert(BaseModel):
    symbol: str = Field(..., description="NSE symbol e.g. RELIANCE")
    action: Literal["BUY", "SELL", "CLOSE_LONG", "CLOSE_SHORT"]
    price: Optional[float] = None
    timeframe: str = "15m"
    strategy: str = "tv_alert"
    comment: str = ""
    # Risk params (optional, override defaults)
    stop_loss_pct: Optional[float] = None
    target_pct: Optional[float] = None
    position_size_pct: Optional[float] = None

class TVWebhookPayload(BaseModel):
    alert: TVAlert
    # Security: timestamp to prevent replay
    timestamp: int
    # Optional: passphrase for additional auth
    passphrase: Optional[str] = None

# ─── Config ───
WEBHOOK_SECRET = os.getenv("TV_WEBHOOK_SECRET", "").encode()
TV_PASSPHRASE = os.getenv("TV_PASSPHRASE", "")

# ─── Helpers ───
def verify_signature(payload: bytes, signature: str) -> bool:
    """Verify HMAC-SHA256 signature from TradingView.

    Fails CLOSED (2026-09-13 review): with no TV_WEBHOOK_SECRET configured this used to
    return True -- an endpoint that can trigger trade execution accepted UNSIGNED payloads
    whenever the env var was missing. A missing secret must reject, never trust."""
    if not WEBHOOK_SECRET:
        print("[tv-webhook] TV_WEBHOOK_SECRET is not configured -- rejecting request "
              "(signature verification cannot run)", file=sys.stderr)
        return False
    expected = hmac.new(WEBHOOK_SECRET, payload, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)

def get_quant_risk_params(symbol: str) -> dict:
    """Fetch calibrated risk params from quant model."""
    conn = connect()
    try:
        row = conn.execute(
            "SELECT calibrated_win_probability, win_probability, atr_14, close, "
            "call_wall_dist_pct, put_wall_dist_pct, iv_rank, hv_20d "
            "FROM technical_signals WHERE symbol = ? ORDER BY date DESC LIMIT 1",
            [symbol]
        ).fetchone()
        if not row:
            return {}
        r = dict(row)
        win_prob = r.get('calibrated_win_probability') or r.get('win_probability') or 0.5
        atr = r.get('atr_14') or r.get('close', 0) * 0.02
        close = r.get('close', 0)
        
        # Dynamic stop: 2.5x ATR or 3% whichever is wider
        atr_stop = atr * 2.5
        pct_stop = close * 0.03
        stop_distance = max(atr_stop, pct_stop)
        
        # Dynamic target: 2:1 reward:risk minimum, capped by call wall
        target_distance = stop_distance * 2
        call_wall = r.get('call_wall_dist_pct')
        if call_wall and call_wall > 0:
            wall_distance = close * call_wall / 100
            target_distance = min(target_distance, wall_distance * 0.9)
        
        return {
            "win_probability": win_prob,
            "stop_distance": stop_distance,
            "target_distance": target_distance,
            "atr": atr,
            "close": close
        }
    finally:
        conn.close()

def check_risk_gates(symbol: str, action: str, params: dict) -> tuple[bool, str]:
    """Enforce quant model risk gates before execution."""
    # Gate 1: Minimum win probability
    min_win_prob = float(os.getenv("MIN_WIN_PROB", "0.52"))
    if params.get("win_probability", 0) < min_win_prob:
        return False, f"Win probability {params.get('win_probability', 0):.2%} below threshold {min_win_prob:.0%}"
    
    # Gate 2: Regime check
    conn = connect()
    try:
        row = conn.execute(
            "SELECT regime FROM regime_labels ORDER BY date DESC LIMIT 1"
        ).fetchone()
        regime = row['regime'] if row else "UNKNOWN"
        
        # Don't take new longs in HIGH_VOL regime
        if action == "BUY" and regime == "HIGH_VOL":
            return False, f"Blocked: HIGH_VOL regime, no new longs"
        
        # Don't take shorts in LOW_VOL without strong signal
        if action == "SELL" and regime == "LOW_VOL":
            if params.get("win_probability", 0) < 0.60:
                return False, f"Blocked: LOW_VOL regime requires >60% win prob for shorts"
    finally:
        conn.close()
    
    # Gate 3: Position size limit
    max_position = float(os.getenv("MAX_POSITION_PCT", "0.05"))  # 5% of portfolio
    if params.get("position_size_pct", 0) > max_position:
        return False, f"Position size {params.get('position_size_pct', 0):.1%} exceeds max {max_position:.1%}"
    
    # Gate 4: No duplicate positions
    conn = connect()
    try:
        existing = conn.execute(
            "SELECT 1 FROM active_positions WHERE symbol = ? AND status = 'OPEN'",
            [symbol]
        ).fetchone()
        if existing and action in ("BUY", "SELL"):
            return False, f"Already have open position in {symbol}"
    finally:
        conn.close()
    
    return True, "All gates passed"

def execute_via_alphaquant(alert: TVAlert, risk_params: dict) -> dict:
    """Forward validated alert to AlphaQuant for execution."""
    alphaquant_url = os.getenv("ALPHAQUANT_URL", "http://127.0.0.1:8002")
    
    payload = {
        "symbol": alert.symbol,
        "action": alert.action,
        "price": alert.price or risk_params.get("close"),
        "stop_loss": risk_params["close"] - risk_params["stop_distance"] if alert.action == "BUY" 
                     else risk_params["close"] + risk_params["stop_distance"],
        "target": risk_params["close"] + risk_params["target_distance"] if alert.action == "BUY"
                  else risk_params["close"] - risk_params["target_distance"],
        "position_size_pct": alert.position_size_pct or 0.03,
        "strategy": alert.strategy,
        "comment": alert.comment,
        "metadata": {
            "source": "tradingview",
            "win_prob": risk_params.get("win_probability"),
            "timeframe": alert.timeframe
        }
    }
    
    try:
        with httpx.Client(timeout=30) as client:
            resp = client.post(f"{alphaquant_url}/execute", json=payload)
            return {"success": resp.is_success, "data": resp.json()}
    except Exception as e:
        return {"success": False, "error": str(e)}

# ─── Endpoints ───
@app.post("/webhook/tradingview")
async def tradingview_webhook(
    request: Request,
    x_tv_signature: Optional[str] = Header(None, alias="X-TradingView-Signature"),
    x_tv_timestamp: Optional[str] = Header(None, alias="X-TradingView-Timestamp")
):
    """Main TradingView webhook endpoint."""
    # Read raw body for signature verification
    body = await request.body()
    
    # Verify HMAC signature -- REQUIRED. The old shape only verified when the caller
    # volunteered the header, so an attacker could bypass auth by simply omitting it
    # (2026-09-13 review, H3).
    if not x_tv_signature:
        raise HTTPException(401, "Missing X-TradingView-Signature header")
    if not verify_signature(body, x_tv_signature):
        raise HTTPException(401, "Invalid signature")
    
    # Parse payload
    try:
        payload = TVWebhookPayload.model_validate_json(body)
    except Exception as e:
        raise HTTPException(400, f"Invalid payload: {e}")
    
    # Verify passphrase
    if TV_PASSPHRASE and payload.passphrase != TV_PASSPHRASE:
        raise HTTPException(401, "Invalid passphrase")
    
    # Verify timestamp (prevent replay > 5 min old)
    now = int(datetime.now().timestamp())
    if abs(now - payload.timestamp) > 300:
        raise HTTPException(401, "Stale request")
    
    alert = payload.alert
    
    # Get quant risk parameters
    risk_params = get_quant_risk_params(alert.symbol)
    if not risk_params:
        raise HTTPException(404, f"No quant data for {alert.symbol}")
    
    # Check risk gates
    gate_passed, gate_msg = check_risk_gates(alert.symbol, alert.action, {
        "win_probability": risk_params["win_probability"],
        "position_size_pct": alert.position_size_pct or 0.03
    })
    
    if not gate_passed:
        # Log rejection
        conn = connect()
        try:
            conn.execute(
                "INSERT INTO tv_webhook_log (symbol, action, status, message, payload, created_at) "
                "VALUES (?, ?, 'REJECTED', ?, ?, NOW())",
                [alert.symbol, alert.action, gate_msg, json.dumps(alert.model_dump())]
            )
            conn.commit()
        finally:
            conn.close()
        
        return {"status": "rejected", "reason": gate_msg}
    
    # Execute via AlphaQuant
    result = execute_via_alphaquant(alert, risk_params)
    
    # Log result
    conn = connect()
    try:
        conn.execute(
            "INSERT INTO tv_webhook_log (symbol, action, status, message, payload, result, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, NOW())",
            [
                alert.symbol, alert.action,
                "EXECUTED" if result.get("success") else "FAILED",
                gate_msg,
                json.dumps(alert.model_dump()),
                json.dumps(result)
            ]
        )
        conn.commit()
    finally:
        conn.close()
    
    return {"status": "executed" if result.get("success") else "failed", "result": result}

@app.get("/health")
async def health():
    return {"status": "ok", "service": "bharat-tv-webhook"}

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("TV_WEBHOOK_PORT", "8003"))
    uvicorn.run(app, host="0.0.0.0", port=port)