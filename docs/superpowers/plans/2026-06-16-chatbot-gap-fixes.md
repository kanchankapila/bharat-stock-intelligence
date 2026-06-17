# Chatbot Gap Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix five high-priority chatbot issues: streaming sector bug, BullMQ scoring failure investigation, daily briefing intent, unified_recommendations in stock_detail, and ChromaDB ingest using the wrong news table.

**Architecture:** All changes are confined to the Python chatbot layer (`src/server/chatbot/`). No TypeScript or frontend changes. The agent loop is `classify_intent → execute_tools → synthesize_answer`; new intents slot into `execute_tools`'s dispatch and new tools go into `market_tool.py` or `ingest.py`.

**Tech Stack:** Python 3.11, FastAPI, LangGraph, SQLite (via `sqlite3`), ChromaDB, SentenceTransformers.

---

## File Map

| File | What changes |
|---|---|
| `src/server/chatbot/app.py` | Task 1: add `"sector": None` to streaming state |
| `src/server/chatbot/tools/market_tool.py` | Tasks 3 & 4: add `get_daily_briefing()` and `get_unified_recommendation()` |
| `src/server/chatbot/agent.py` | Tasks 3 & 4: wire new intent + new tool calls into dispatch |
| `src/server/chatbot/ingest.py` | Task 5: swap `ingest_news_articles` to read from `news_sentiment_items` |
| `src/server/queues.ts` (read-only) | Task 2: investigation only — no code changes expected |

---

## Task 1: Fix streaming state — missing `"sector": None`

**Files:**
- Modify: `src/server/chatbot/app.py:127-148`

The `/chat` endpoint (line 105) passes `"sector": None` in its state dict. The `/chat/stream` endpoint's `token_generator()` (line 127) does not. This means any sector-filtered query sent via SSE silently skips all sector filtering in `execute_tools`.

- [ ] **Step 1: Edit `app.py` — add `"sector": None` to streaming state**

In `src/server/chatbot/app.py`, locate the `token_generator()` function. The state dict passed to `_graph.astream_events()` currently reads:
```python
{
    "messages": [HumanMessage(content=req.message)],
    "intent": "",
    "stock_symbol": None,
    "retrieved_context": "",
    "sources": [],
}
```
Change it to:
```python
{
    "messages": [HumanMessage(content=req.message)],
    "intent": "",
    "stock_symbol": None,
    "sector": None,
    "retrieved_context": "",
    "sources": [],
}
```

- [ ] **Step 2: Verify by diffing against the `/chat` endpoint**

The two state dicts — one at line ~107 (inside `chat()`) and the one inside `token_generator()` — must now be identical. Visually confirm the keys match:
```
messages, intent, stock_symbol, sector, retrieved_context, sources
```

- [ ] **Step 3: Commit**

```bash
git add src/server/chatbot/app.py
git commit -m "fix(chatbot): add missing sector field to SSE streaming state"
```

---

## Task 2: Investigate BullMQ stock-scoring silent failure

**Files:**
- Read: `src/server/queues.ts` (investigation only)
- Read: `src/server/scoringService.ts` (already read)

The `stock_scores` table is 13 days stale despite a BullMQ cron job (`'0 13 * * 1-5'`). The job uses `syncAndScore()` which calls Trendlyne + MoneyControl + ETNow screener syncs before `recalculateScores()`. Likely causes: Redis not running (BullMQ never fires), screener network timeouts causing silent failures, or `removeOnFail: 3` pruning the failure record.

- [ ] **Step 1: Check if Redis is up**

```powershell
redis-cli ping
```
Expected: `PONG`. If you get `Could not connect`, Redis is down — BullMQ repeatable jobs never fire. In that case, start Redis and the app will re-register the job on next startup. Skip to Step 4.

- [ ] **Step 2: Check the BullMQ job state in Redis**

```powershell
redis-cli keys "bull:stock-scoring:*" | head -20
```
Look for `bull:stock-scoring:failed:*` keys. If they exist:
```powershell
redis-cli hgetall "bull:stock-scoring:failed:<job-id>"
```
The `failedReason` field will show the actual error message.

- [ ] **Step 3: Check repeatable job registration**

```powershell
redis-cli zrange "bull:stock-scoring:repeat" 0 -1
```
If empty, the repeatable job was never registered (BullMQ init failed silently). Fix: restart the app server so `initQueues()` re-runs.

- [ ] **Step 4: Manually trigger scoring via the tRPC endpoint**

Open a browser or curl to: `POST http://localhost:3000/api/trpc/triggerStockScoring`

Or from the app UI: Settings → Trigger Scoring. Check the server console for output. If it prints errors from Trendlyne/MoneyControl/ETNow, those network calls are the root cause.

- [ ] **Step 5: Verify `stock_scores` updated**

```powershell
$PY = Get-Content "graphify-out/.graphify_python"
& $PY -c "import sqlite3; c=sqlite3.connect('database.sqlite'); print(c.execute('SELECT MAX(updated_at) FROM stock_scores').fetchone())"
```
Expected: today's date. If yesterday or older, scoring ran but `updated_at` wasn't updated — check `recalculateScores()` in `scoringService.ts` for silent exception swallowing.

- [ ] **Step 6: Document findings**

Add a one-line note at the bottom of `CLAUDE.md` under "Recent session notes" describing the root cause found. No code change needed for this task unless a specific fix is identified during investigation.

---

## Task 3: Add `daily_briefing` intent + `get_daily_briefing()` tool

**Files:**
- Modify: `src/server/chatbot/tools/market_tool.py` — add `get_daily_briefing()`
- Modify: `src/server/chatbot/agent.py` — add `daily_briefing` intent, import, dispatch

`daily_research_reports` has these columns: `report_date`, `report_type` (`PRE_MARKET`/`POST_CLOSE`), `status`, `market_regime`, `sentiment_score`, `fii_net_5d`, `top_picks_json`, `report_json`, `ai_blurbs_json`.

- [ ] **Step 1: Add `get_daily_briefing()` to `market_tool.py`**

Append this function to the end of `src/server/chatbot/tools/market_tool.py`:

```python
# ─── Daily Research Briefing ──────────────────────────────────────────────────

def get_daily_briefing(db_path: str = DB_PATH) -> dict:
    """
    Today's pre-market and post-close research reports.
    Source: daily_research_reports (generated by research-premarket-repeatable and
    research-postclose-repeatable BullMQ jobs).
    Returns top picks, avoid list, sector rankings, AI blurbs, and regime context.
    """
    db = _connect(db_path)
    result: dict = {}

    try:
        today = datetime.now().strftime("%Y-%m-%d")
        rows = db.execute(
            "SELECT report_date, report_type, status, generated_at, "
            "market_regime, sentiment_score, fii_net_5d, "
            "top_picks_json, report_json, ai_blurbs_json "
            "FROM daily_research_reports "
            "WHERE report_date = ? AND status = 'READY' "
            "ORDER BY report_type DESC",
            (today,),
        ).fetchall()

        if not rows:
            # Fall back to most recent available report (in case today not yet generated)
            rows = db.execute(
                "SELECT report_date, report_type, status, generated_at, "
                "market_regime, sentiment_score, fii_net_5d, "
                "top_picks_json, report_json, ai_blurbs_json "
                "FROM daily_research_reports "
                "WHERE status = 'READY' "
                "ORDER BY report_date DESC, report_type DESC LIMIT 2",
            ).fetchall()

        for row in rows:
            rtype = row["report_type"]
            entry: dict = {
                "report_date": row["report_date"],
                "report_type": rtype,
                "generated_at": row["generated_at"],
                "market_regime": row["market_regime"],
                "sentiment_score": row["sentiment_score"],
                "fii_net_5d": row["fii_net_5d"],
            }

            try:
                entry["top_picks"] = json.loads(row["top_picks_json"] or "[]")[:10]
            except Exception:
                entry["top_picks"] = []

            try:
                report = json.loads(row["report_json"] or "{}")
                entry["executive_summary"] = report.get("executive_summary", "")
                entry["avoid_list"] = report.get("avoid_list", [])[:10]
                entry["sector_rankings"] = report.get("sector_rankings", [])
                entry["key_themes"] = report.get("key_themes", [])
            except Exception:
                pass

            try:
                entry["ai_blurbs"] = json.loads(row["ai_blurbs_json"] or "[]")[:5]
            except Exception:
                entry["ai_blurbs"] = []

            result[rtype] = entry

    except Exception as e:
        result["error"] = str(e)

    db.close()
    return result
```

- [ ] **Step 2: Add `daily_briefing` to `INTENT_PROMPT` in `agent.py`**

In `src/server/chatbot/agent.py`, find the `INTENT_PROMPT` string (line 53). Add one line to the `Intents:` list after `market_overview`:

```
- daily_briefing: today's top stock picks, morning brief, daily report, what to buy today, platform's top picks, pre-market brief, post-close report
```

The full intents block should now read:
```
Intents:
- stock_detail: a specific stock's profile, price, fundamentals, technicals, signals, news
- fundamental_filter: screen/find stocks by fundamental criteria (PE, ROE, undervalued, quality, etc.)
- screener_lookup: stocks in a named screener, strategy or theme
- news_sentiment: news, events, sentiment about a stock, sector, or the market
- earnings_upcoming: upcoming results/earnings announcements, quarterly results calendar
- market_overview: market mood, regime, sentiment, FII/DII flows, macro moves, indices, overall market direction
- daily_briefing: today's top stock picks, morning brief, daily report, what to buy today, platform's top picks, pre-market brief, post-close report
- sector_analysis: sector performance, sector rotation, which sector is outperforming/underperforming
- signal_performance: signal accuracy, win rates, how good are the signals, platform performance metrics
- general: comparisons, open-ended analysis, anything else
```

- [ ] **Step 3: Import `get_daily_briefing` in `agent.py`**

In `src/server/chatbot/agent.py`, find the `from tools.market_tool import (` block (lines 20-24). Add `get_daily_briefing` to the import list:

```python
from tools.market_tool import (
    get_market_pulse, get_top_confluence_stocks, get_stock_signals,
    get_fii_dii_sentiment, get_sector_momentum, get_signal_accuracy,
    get_live_news_sentiment, get_daily_briefing,
)
```

- [ ] **Step 4: Wire `daily_briefing` dispatch in `execute_tools()`**

In `src/server/chatbot/agent.py`, find the `# ── signal_performance ──` block (around line 280). Insert the `daily_briefing` handler immediately before it:

```python
    # ── daily_briefing ────────────────────────────────────────────────────────
    elif intent == "daily_briefing":
        briefing = get_daily_briefing(db_path=db_path)
        if briefing and not briefing.get("error"):
            add("Today's Research Briefing (Pre-Market + Post-Close)", briefing, "sql:daily_research_reports")
        else:
            # Fall back to top confluence stocks when no report ready yet
            top = get_top_confluence_stocks(min_confluence=75, limit=15, db_path=db_path)
            if top:
                add("Top Conviction Stocks (no daily report yet — using confluence)", top, "sql:confluence_signals")
            pulse = get_market_pulse(db_path=db_path)
            add("Market Pulse", pulse, "sql:market_regimes+sentiment")
```

- [ ] **Step 5: Test by querying the chatbot**

Start the chatbot server (or it should already be running):
```powershell
npm run chatbot
```
Then send a test query:
```powershell
curl -X POST http://localhost:8001/chat `
  -H "Content-Type: application/json" `
  -d '{"message": "What are today top picks?", "session_id": "test-001"}'
```
Expected: JSON response with `answer` containing stock picks from `daily_research_reports`, or confluence stocks if no report is ready. The intent in the log should be `daily_briefing`.

- [ ] **Step 6: Commit**

```bash
git add src/server/chatbot/tools/market_tool.py src/server/chatbot/agent.py
git commit -m "feat(chatbot): add daily_briefing intent with get_daily_briefing() tool"
```

---

## Task 4: Add `unified_recommendations` to `stock_detail` dispatch

**Files:**
- Modify: `src/server/chatbot/tools/market_tool.py` — add `get_unified_recommendation()`
- Modify: `src/server/chatbot/agent.py` — import + add to `stock_detail` block

`unified_recommendations` schema (migration 033): `symbol`, `computed_at`, `regime`, `unified_score`, `conviction_level`, `screener_stock_score`, `ml_score`, `confluence_score`, `technical_score`, `dl_score`, `avg_engine_track_record`, `bullish_screener_count`, `bearish_screener_count`, `screener_names_json`, `fundamental_score`, `entry_zone_low`, `entry_zone_high`, `stop_loss`, `target_1`, `target_2`, `target_3`, `risk_reward`, `timeframe`, `sector`, `trade_reasoning`.

This is the most complete per-stock table with multi-engine consensus and today's entry/target/SL data — it should supplement (not replace) the stale `stock_scores` data already fetched by `get_stock_fundamentals()`.

- [ ] **Step 1: Add `get_unified_recommendation()` to `market_tool.py`**

Append this function to the end of `src/server/chatbot/tools/market_tool.py` (after `get_daily_briefing()`):

```python
# ─── Unified Recommendation ───────────────────────────────────────────────────

def get_unified_recommendation(symbol: str, db_path: str = DB_PATH) -> dict | None:
    """
    Latest multi-engine consensus recommendation for a stock.
    Source: unified_recommendations (updated daily by unified-ranker-daily-repeatable job).
    Includes: unified_score, conviction_level, ML/DL/confluence/technical sub-scores,
    entry/target/SL zones, risk_reward, trade_reasoning.
    Falls back to None if the symbol has no entry.
    """
    db = _connect(db_path)
    try:
        row = db.execute(
            """SELECT symbol, computed_at, regime, unified_score, conviction_level,
                      screener_stock_score, ml_score, confluence_score,
                      technical_score, dl_score, avg_engine_track_record,
                      bullish_screener_count, bearish_screener_count,
                      screener_names_json, fundamental_score,
                      entry_zone_low, entry_zone_high, stop_loss,
                      target_1, target_2, target_3, risk_reward,
                      timeframe, sector, trade_reasoning
               FROM unified_recommendations
               WHERE symbol = ?
               ORDER BY computed_at DESC LIMIT 1""",
            (symbol.upper(),),
        ).fetchone()

        if not row:
            db.close()
            return None

        d = dict(row)
        try:
            d["screener_names"] = json.loads(d.pop("screener_names_json") or "[]")[:8]
        except Exception:
            d.pop("screener_names_json", None)

        db.close()
        return d
    except Exception:
        db.close()
        return None
```

- [ ] **Step 2: Import `get_unified_recommendation` in `agent.py`**

Update the `from tools.market_tool import (` block to add `get_unified_recommendation`:

```python
from tools.market_tool import (
    get_market_pulse, get_top_confluence_stocks, get_stock_signals,
    get_fii_dii_sentiment, get_sector_momentum, get_signal_accuracy,
    get_live_news_sentiment, get_daily_briefing, get_unified_recommendation,
)
```

- [ ] **Step 3: Add `get_unified_recommendation` call inside the `stock_detail` block in `execute_tools()`**

In `src/server/chatbot/agent.py`, find the `# ── stock_detail ──` block (around line 154). After the `quant` call (around line 173), add the unified recommendation fetch:

```python
        unified = get_unified_recommendation(symbol, db_path=db_path)
        if unified:
            add("Unified Multi-Engine Recommendation (today)", unified, "sql:unified_recommendations")
```

The stock_detail block should now look like this (showing the last few lines of the block):

```python
        quant = get_quant_scores(symbol=symbol, db_path=db_path)
        if quant:
            add("Quant Scores", quant[0], "sql:quant_scores")

        unified = get_unified_recommendation(symbol, db_path=db_path)
        if unified:
            add("Unified Multi-Engine Recommendation (today)", unified, "sql:unified_recommendations")

        # Web only if stock missing from DB, news thin, or query is time-sensitive
        news_count = news.get("total", 0) if isinstance(news, dict) else 0
```

- [ ] **Step 4: Also update the SYSTEM_PROMPT to mention unified recommendations**

In `src/server/chatbot/agent.py`, find the `SYSTEM_PROMPT` (line 29). Add one bullet to the "Available data" list:

```python
SYSTEM_PROMPT = """You are Bharat Stock AI, an expert Indian stock market analyst with access to real-time platform data.

Available data (all from local DB unless noted):
- Live signals: unified_signals (today), confluence_signals (30-min updates), technical_signals (RSI/MACD/SMA, daily)
- Unified multi-engine recommendations: unified_score (0–100), conviction_level, ML/DL/confluence/technical sub-scores, entry/target/SL zones, risk_reward — updated daily
- Fundamentals: PE, P/B, ROE, revenue growth, debt/equity, Piotroski F-score
...
```

Only add the one bullet line. Leave the rest of `SYSTEM_PROMPT` unchanged.

- [ ] **Step 5: Test by querying a stock**

```powershell
curl -X POST http://localhost:8001/chat `
  -H "Content-Type: application/json" `
  -d '{"message": "Give me a full analysis of RELIANCE", "session_id": "test-002"}'
```
Expected: The response should now include a "Unified Multi-Engine Recommendation" section with `unified_score`, `conviction_level`, and `trade_reasoning` in the context data visible in the server logs.

- [ ] **Step 6: Commit**

```bash
git add src/server/chatbot/tools/market_tool.py src/server/chatbot/agent.py
git commit -m "feat(chatbot): add unified_recommendations to stock_detail — multi-engine consensus with today's entry/SL/target"
```

---

## Task 5: Fix ChromaDB ingest — switch to `news_sentiment_items`

**Files:**
- Modify: `src/server/chatbot/ingest.py` — replace `ingest_news_articles()` body

Currently `ingest_news_articles()` reads from `news_articles` (legacy, stale, no FinBERT scores). `news_sentiment_items` is the live table: FinBERT-scored, sector-labelled, impact-classified, updated every ~30 min.

The ChromaDB collection name stays `"news_articles"` to avoid invalidating the existing store — we just change what we write into it.

- [ ] **Step 1: Replace `ingest_news_articles()` in `ingest.py`**

In `src/server/chatbot/ingest.py`, replace the entire `ingest_news_articles` function (lines 99–134) with:

```python
def ingest_news_articles(client: chromadb.ClientAPI, db_path: str = DB_PATH) -> int:
    """Recent news from news_sentiment_items (FinBERT-scored, live, updated ~30 min).
    Upserts into the 'news_articles' ChromaDB collection to avoid a full re-embed on upgrade."""
    ef = get_embedding_fn()
    col = client.get_or_create_collection("news_articles", embedding_function=ef)

    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute("""
            SELECT id, title, summary, source, sentiment, sentiment_score,
                   impact, category, sector, symbols_json
            FROM news_sentiment_items
            WHERE published_at >= datetime('now', '-30 days')
            ORDER BY published_at DESC
            LIMIT 1000
        """).fetchall()
    except Exception:
        rows = []
    conn.close()

    docs, ids, metas = [], [], []
    for row in rows:
        art_id, title, summary, source, sentiment, score, impact, category, sector, symbols_json = row
        text = f"{title}. {summary or ''}".strip()
        if not text:
            continue
        docs.append(text[:500])
        ids.append(f"news_{art_id}")
        metas.append({
            "source": source or "",
            "sentiment": sentiment or "Neutral",
            "sentiment_score": float(score) if score is not None else 0.0,
            "impact": impact or "MEDIUM",
            "category": category or "",
            "sector": sector or "",
            "symbols": symbols_json or "",
            "type": "news",
        })

    if docs:
        col.upsert(documents=docs, ids=ids, metadatas=metas)
        logger.info(f"Upserted {len(docs)} news items from news_sentiment_items")
    return len(docs)
```

- [ ] **Step 2: Trigger a re-ingest to populate with fresh data**

```powershell
curl -X POST http://localhost:8001/ingest
```
Expected response: `{"status": "ok", "stocks": 2366, "screeners": 1521, "news": <N>}` where `N` > 0. The server log should print `[ingest] Upserted N news items from news_sentiment_items`.

- [ ] **Step 3: Verify ChromaDB has the new data**

```powershell
$PY = Get-Content "graphify-out/.graphify_python"
& $PY -c "
import chromadb
c = chromadb.PersistentClient(path='src/server/chatbot/chroma_store')
col = c.get_collection('news_articles')
print('count:', col.count())
results = col.query(query_texts=['HDFC Bank earnings'], n_results=2)
print(results['documents'])
"
```
Expected: count > 0, and the two results should be from `news_sentiment_items` (should have richer context).

- [ ] **Step 4: Commit**

```bash
git add src/server/chatbot/ingest.py
git commit -m "fix(chatbot): ingest news from news_sentiment_items instead of stale news_articles table"
```

---

## Self-Review Checklist

**Spec coverage:**
- [x] Task 1 — streaming `"sector": None` bug (audit: "streaming endpoint bug")
- [x] Task 2 — BullMQ stock_scores silent failure investigation (audit: "Critical: stock_scores is 13 days stale")
- [x] Task 3 — daily_research_reports tool + daily_briefing intent (audit: gap #1)
- [x] Task 4 — unified_recommendations in stock_detail (audit: gap #5)
- [x] Task 5 — ChromaDB ingest using wrong news table (audit: "ChromaDB news is ingested from wrong table")

**Not in this plan (deferred to next plan):**
- Gap #2: xgboost_predictions tool — data is 27 days stale, fix staleness first
- Gap #3: chart_patterns tool — data is 22 days stale
- Gap #4: bulk_deals/insider_trades — no fetcher script exists yet
- Gap #6: options sentiment / PCR — data is 22 days stale
- Gap #7: get_price_history() from stock_ohlcv
- Gap #8: multi-stock comparison
- Gap #10: screener_performance_v2 join
- Multi-turn context (agent improvement C)
- Company name → symbol fuzzy match (agent improvement A)
- FII/DII + PCR BullMQ scheduling (data freshness B)

**Placeholder scan:** No TBDs, no "similar to Task N", all steps have complete code. ✓

**Type consistency:**
- `get_daily_briefing(db_path)` → `dict` — consistent across market_tool.py and agent.py
- `get_unified_recommendation(symbol, db_path)` → `dict | None` — consistent across market_tool.py and agent.py
- Both new imports added to the same `from tools.market_tool import (...)` block ✓
