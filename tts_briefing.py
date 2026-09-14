#!/usr/bin/env python3
"""
Bharat Stock Intelligence — Pre/Post Market TTS Briefing Generator
Runs as Hermes Cron job, generates audio briefing, posts to Telegram as voice note.
"""
import os
import sys
import json
import asyncio
import subprocess
from datetime import datetime, timedelta
from pathlib import Path

# Load the repo .env before any db_compat import: this script runs as a Hermes cron job,
# outside pm2's env block, so without this neither POSTGRES_URL nor the Telegram
# credentials would be set. Same KEY=VALUE subset the register-*.sh scripts source.
_ROOT = Path(__file__).resolve().parent
_env_file = _ROOT / ".env"
if _env_file.exists():
    for _line in _env_file.read_text(encoding="utf-8").splitlines():
        _line = _line.strip()
        if not _line or _line.startswith("#") or "=" not in _line:
            continue
        _key, _, _val = _line.partition("=")
        os.environ.setdefault(_key.strip(), _val.strip())

# Add project to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from db_compat import connect

def get_market_breadth():
    """Get market breadth data for briefing."""
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT metric_name, metric_value, metric_date FROM market_breadth "
            "WHERE metric_date = (SELECT MAX(metric_date) FROM market_breadth) "
            "AND metric_name IN ('pct_above_200dma', 'pct_above_50dma', 'adv_decline_ratio', 'net_new_highs_52w')"
        ).fetchall()
        return {r['metric_name']: r['metric_value'] for r in rows}
    finally:
        conn.close()

def get_fii_dii_flow():
    """Get latest FII/DII net flows."""
    conn = connect()
    try:
        row = conn.execute(
            "SELECT fii_net_equity, dii_net_equity, date FROM fii_dii_history "
            "ORDER BY date DESC LIMIT 1"
        ).fetchone()
        return dict(row) if row else {}
    finally:
        conn.close()

def get_top_picks(limit=5):
    """Get top conviction picks."""
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT symbol, unified_score, recommendation_action, conviction_level, target_price, stop_loss "
            "FROM unified_recommendations "
            "WHERE unified_score >= 65 AND recommendation_action LIKE 'BUY%' "
            "ORDER BY unified_score DESC LIMIT ?",
            [limit]
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()

def get_overnight_macro():
    """Get overnight macro moves."""
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT symbol, close FROM macro_asset_prices "
            "WHERE symbol IN ('USDINR', 'CRUDE_OIL', 'GOLD', 'US10Y', 'VIX', 'GIFT_NIFTY') "
            "AND date = (SELECT MAX(date) FROM macro_asset_prices)"
        ).fetchall()
        return {r['symbol']: r['close'] for r in rows}
    finally:
        conn.close()

def get_regime():
    """Get current market regime."""
    conn = connect()
    try:
        row = conn.execute(
            "SELECT regime, confidence FROM regime_labels "
            "ORDER BY date DESC LIMIT 1"
        ).fetchone()
        return dict(row) if row else {"regime": "UNKNOWN", "confidence": 0}
    finally:
        conn.close()

def generate_briefing_script(briefing_type="pre_market"):
    """Generate natural language briefing script for TTS."""
    breadth = get_market_breadth()
    fii_dii = get_fii_dii_flow()
    picks = get_top_picks()
    macro = get_overnight_macro()
    regime = get_regime()
    
    now = datetime.now()
    date_str = now.strftime("%A, %B %d")
    time_str = now.strftime("%I:%M %p")
    
    if briefing_type == "pre_market":
        script = f"Bharat Stock Intelligence. {date_str} pre-market briefing at {time_str}. "
        
        # Regime
        script += f"Market regime is {regime['regime']} with {regime.get('confidence', 0):.0f}% confidence. "
        
        # Breadth
        if breadth:
            pct_200 = breadth.get('pct_above_200dma', 0)
            pct_50 = breadth.get('pct_above_50dma', 0)
            ad_ratio = breadth.get('adv_decline_ratio', 1)
            script += f"Breadth: {pct_200:.0f}% above 200 DMA, {pct_50:.0f}% above 50 DMA. Advance-decline ratio {ad_ratio:.2f}. "
        
        # FII/DII
        if fii_dii:
            fii = fii_dii.get('fii_net_equity', 0) / 1e7  # crores
            dii = fii_dii.get('dii_net_equity', 0) / 1e7
            script += f"Yesterday FIIs {'bought' if fii > 0 else 'sold'} {abs(fii):.0f} crore, DIIs {'bought' if dii > 0 else 'sold'} {abs(dii):.0f} crore. "
        
        # Overnight macro
        if macro:
            usdinr = macro.get('USDINR')
            crude = macro.get('CRUDE_OIL')
            gold = macro.get('GOLD')
            vix = macro.get('VIX')
            gift = macro.get('GIFT_NIFTY')
            parts = []
            if usdinr: parts.append(f"Rupee at {usdinr:.2f}")
            if crude: parts.append(f"Crude {crude:.0f}")
            if gold: parts.append(f"Gold {gold:.0f}")
            if vix: parts.append(f"VIX {vix:.1f}")
            if gift: parts.append(f"Gift Nifty {gift:.0f}")
            if parts: script += f"Overnight: {', '.join(parts)}. "
        
        # Top picks
        if picks:
            script += "Top conviction picks: "
            for i, p in enumerate(picks[:3]):
                script += f"{p['symbol']} at {p['unified_score']:.0f} score, target {p['target_price']:.0f}, stop {p['stop_loss']:.0f}. "
        
        script += "Full dashboard available on Hermes desktop. Trade with discipline."
        
    else:  # post_market
        script = f"Bharat Stock Intelligence. {date_str} post-market summary at {time_str}. "
        
        # Get day's performance
        conn = connect()
        try:
            row = conn.execute(
                "SELECT close, change_pct FROM stock_ohlcv "
                "WHERE symbol = 'NIFTY50' AND date = (SELECT MAX(date) FROM stock_ohlcv WHERE symbol = 'NIFTY50')"
            ).fetchone()
            if row:
                script += f"Nifty closed at {row['close']:.0f}, {row['change_pct']:+.2f}%. "
        finally:
            conn.close()
        
        # FII/DII
        if fii_dii:
            fii = fii_dii.get('fii_net_equity', 0) / 1e7
            dii = fii_dii.get('dii_net_equity', 0) / 1e7
            script += f"Today FIIs {'bought' if fii > 0 else 'sold'} {abs(fii):.0f} crore, DIIs {'bought' if dii > 0 else 'sold'} {abs(dii):.0f} crore. "
        
        # Breadth
        if breadth:
            net_highs = breadth.get('net_new_highs_52w', 0)
            script += f"Net 52-week highs: {net_highs:+.0f}. "
        
        # Top performers (from mover_snapshots)
        conn = connect()
        try:
            rows = conn.execute(
                "SELECT symbol, pct_change FROM mover_snapshots "
                "WHERE list_type = 'top_gainers' AND date = (SELECT MAX(date) FROM mover_snapshots) "
                "ORDER BY pct_change DESC LIMIT 3"
            ).fetchall()
            if rows:
                script += "Top gainers: " + ", ".join([f"{r['symbol']} {r['pct_change']:+.1f}%" for r in rows]) + ". "
        finally:
            conn.close()
        
        script += "Review tomorrow's pre-market briefing at 8:30 AM. Good evening."
    
    return script

def generate_audio(script, output_path, voice="en-US-AriaNeural"):
    """Generate audio using Edge TTS (free, high quality)."""
    try:
        # Use edge-tts if available
        cmd = ["edge-tts", "--voice", voice, "--text", script, "--write-media", output_path]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if result.returncode == 0:
            return True, output_path
    except FileNotFoundError:
        pass
    
    # Fallback: use Python TTS libraries
    try:
        import pyttsx3
        engine = pyttsx3.init()
        engine.setProperty('rate', 180)
        engine.setProperty('volume', 0.9)
        engine.save_to_file(script, output_path)
        engine.runAndWait()
        return True, output_path
    except Exception as e:
        return False, str(e)

def send_telegram_voice(audio_path, chat_id, caption=""):
    """Send voice note to Telegram."""
    bot_token = os.getenv("TELEGRAM_BOT_TOKEN")
    if not bot_token:
        return False, "TELEGRAM_BOT_TOKEN not set"
    if not chat_id:
        # No fake fallback: a placeholder chat id would silently deliver the voice note
        # to a chat that does not exist and read as success-shaped silence.
        return False, "TELEGRAM_CHAT_ID not set"
    
    try:
        import requests
        url = f"https://api.telegram.org/bot{bot_token}/sendVoice"
        with open(audio_path, 'rb') as f:
            files = {'voice': f}
            data = {'chat_id': chat_id, 'caption': caption}
            resp = requests.post(url, files=files, data=data, timeout=30)
            return resp.ok, resp.text
    except Exception as e:
        return False, str(e)

async def main():
    briefing_type = sys.argv[1] if len(sys.argv) > 1 else "pre_market"
    chat_id = os.getenv("TELEGRAM_CHAT_ID", "").strip()
    if not chat_id:
        print("ERROR: TELEGRAM_CHAT_ID is not set — set it in .env (same value telegramService.ts uses).", file=sys.stderr)
        return 1
    
    # Generate script
    script = generate_briefing_script(briefing_type)
    print(f"Generated {briefing_type} briefing ({len(script)} chars)")
    print(script[:200] + "...")
    
    # Generate audio
    output_dir = Path(os.getenv("TEMP", "/tmp")) / "bharat_briefings"
    output_dir.mkdir(exist_ok=True)
    audio_file = output_dir / f"{briefing_type}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.mp3"
    
    success, result = generate_audio(script, str(audio_file))
    if not success:
        print(f"TTS failed: {result}")
        return 1
    
    print(f"Audio generated: {audio_file}")
    
    # Send to Telegram
    caption = f"🎙️ Bharat Intelligence — {briefing_type.replace('_', ' ').title()} Briefing — {datetime.now().strftime('%b %d, %I:%M %p')}"
    success, resp = send_telegram_voice(str(audio_file), chat_id, caption)
    if success:
        print("✅ Voice note sent to Telegram")
    else:
        print(f"❌ Telegram send failed: {resp}")
    
    # Cleanup old files (>7 days)
    for f in output_dir.glob("*.mp3"):
        if f.stat().st_mtime < (datetime.now() - timedelta(days=7)).timestamp():
            f.unlink()
    
    return 0

if __name__ == "__main__":
    sys.exit(asyncio.run(main()))