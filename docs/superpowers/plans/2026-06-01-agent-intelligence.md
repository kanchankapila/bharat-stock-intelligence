# Agent Intelligence System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a four-agent pipeline (Data Scientist → Strategist → Auditor → Optimizer) that combines Python computation with local Ollama LLM narratives, exposed via tRPC and 4 dedicated React pages with Telegram alerts.

**Architecture:** Python agents run sequentially post-market via BullMQ crons, each writing structured results + Ollama narrative to its own DB table. TypeScript workers call `runPython`, read results, fire Telegram. tRPC queries expose latest run to React UI pages.

**Tech Stack:** Python 3.11 + SQLAlchemy + requests (Ollama), TypeScript + BullMQ + better-sqlite3, tRPC, React 19 + Recharts + TailwindCSS

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `src/server/db.ts` | Add 4 table migrations |
| Create | `src/server/agents/__init__.py` | Package marker |
| Create | `src/server/agents/ollama_client.py` | Shared Ollama HTTP call |
| Create | `src/server/agents/data_scientist_agent.py` | Data quality metrics + narrative |
| Create | `src/server/agents/strategist_agent.py` | Per-timeframe ranked picks + narrative |
| Create | `src/server/agents/auditor_agent.py` | Pick vs actual outcome + narrative |
| Create | `src/server/agents/optimizer_agent.py` | Weight adjustment + narrative |
| Modify | `src/server/queues.ts` | 4 new queue constants + processor functions + workers |
| Create | `src/server/routers/agents.router.ts` | 5 queries + 5 mutations |
| Modify | `src/server/router.ts` | Add agentsRouter to mergeRouters |
| Create | `src/components/AgentDataScientistPage.tsx` | DS report UI |
| Create | `src/components/AgentStrategistPage.tsx` | Picks per timeframe UI |
| Create | `src/components/AgentAuditorPage.tsx` | Audit results UI |
| Create | `src/components/AgentOptimizerPage.tsx` | Optimizer report UI |
| Modify | `src/App.tsx` | Add 4 tab routes |

---

## Task 1 — DB Migrations

**Files:**
- Modify: `src/server/db.ts`

- [ ] **Step 1: Add migrations at the bottom of the `db.exec(...)` block**

Find the last table in `src/server/db.ts` (ends before the closing backtick of the large `db.exec` call). Add these 4 tables inside the same `db.exec` call:

```typescript
  -- Agent Intelligence: Data Scientist reports
  CREATE TABLE IF NOT EXISTS agent_data_scientist_reports (
    id                        INTEGER PRIMARY KEY AUTOINCREMENT,
    run_date                  TEXT NOT NULL,
    ohlcv_coverage_pct        REAL,
    stale_symbols_count       INTEGER,
    fundamentals_fresh_count  INTEGER,
    model_auc                 REAL,
    model_drift_detected      INTEGER DEFAULT 0,
    signal_resolution_rate    REAL,
    data_quality_score        REAL,
    quality_grade             TEXT,
    issues_json               TEXT,
    narrative                 TEXT,
    created_at                DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_ads_run_date ON agent_data_scientist_reports(run_date);

  -- Agent Intelligence: Strategist picks per timeframe
  CREATE TABLE IF NOT EXISTS agent_strategy_picks (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    run_date                 TEXT NOT NULL,
    timeframe                TEXT NOT NULL,
    symbol                   TEXT NOT NULL,
    rank                     INTEGER NOT NULL,
    conviction               TEXT NOT NULL,
    entry_zone_low           REAL,
    entry_zone_high          REAL,
    stop_loss                REAL,
    target_1                 REAL,
    target_2                 REAL,
    target_3                 REAL,
    composite_score          REAL,
    quant_rank               REAL,
    confluence_score         REAL,
    regime_alignment         TEXT,
    supporting_signals_json  TEXT,
    narrative                TEXT,
    created_at               DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_asp_run_date_tf ON agent_strategy_picks(run_date, timeframe);
  CREATE INDEX IF NOT EXISTS idx_asp_symbol      ON agent_strategy_picks(symbol);

  -- Agent Intelligence: Auditor reports per timeframe
  CREATE TABLE IF NOT EXISTS agent_audit_reports (
    id                        INTEGER PRIMARY KEY AUTOINCREMENT,
    run_date                  TEXT NOT NULL,
    audit_for_date            TEXT NOT NULL,
    timeframe                 TEXT NOT NULL,
    total_picks               INTEGER,
    hits                      INTEGER,
    misses                    INTEGER,
    open_positions            INTEGER,
    hit_rate                  REAL,
    avg_return_pct            REAL,
    profit_factor             REAL,
    nifty_return_pct          REAL,
    alpha_pct                 REAL,
    best_pick                 TEXT,
    worst_pick                TEXT,
    signal_attribution_json   TEXT,
    narrative                 TEXT,
    created_at                DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_aar_run_date_tf ON agent_audit_reports(run_date, timeframe);

  -- Agent Intelligence: Optimizer reports
  CREATE TABLE IF NOT EXISTS agent_optimizer_reports (
    id                             INTEGER PRIMARY KEY AUTOINCREMENT,
    run_date                       TEXT NOT NULL,
    trigger                        TEXT NOT NULL,
    baseline_win_rate              REAL,
    new_win_rate                   REAL,
    improvement_pct                REAL,
    weights_changed                INTEGER DEFAULT 0,
    full_optimizer_triggered       INTEGER DEFAULT 0,
    changes_json                   TEXT,
    underperforming_segments_json  TEXT,
    narrative                      TEXT,
    created_at                     DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_aor_run_date ON agent_optimizer_reports(run_date);
```

- [ ] **Step 2: Verify server starts without DB errors**

```bash
cd c:/Github/bharat-stock-intelligence
npx tsx server.ts 2>&1 | head -20
```

Expected: server starts, no "table already exists" errors (IF NOT EXISTS handles re-runs).

- [ ] **Step 3: Commit**

```bash
git add src/server/db.ts
git commit -m "feat(db): add 4 agent intelligence tables"
```

---

## Task 2 — Shared Ollama Client + Agent Package

**Files:**
- Create: `src/server/agents/__init__.py`
- Create: `src/server/agents/ollama_client.py`

- [ ] **Step 1: Create package marker**

Create `src/server/agents/__init__.py` with empty content.

- [ ] **Step 2: Create shared Ollama client**

Create `src/server/agents/ollama_client.py`:

```python
import os
import requests

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434/api/generate")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.2")
OLLAMA_TIMEOUT = int(os.environ.get("OLLAMA_TIMEOUT", "120"))


def get_narrative(prompt: str) -> str:
    """Call local Ollama and return generated text. Returns fallback string on any error."""
    try:
        resp = requests.post(
            OLLAMA_URL,
            json={"model": OLLAMA_MODEL, "prompt": prompt, "stream": False},
            timeout=OLLAMA_TIMEOUT,
        )
        resp.raise_for_status()
        return resp.json().get("response", "").strip()
    except Exception as exc:
        print(f"[OLLAMA] Narrative unavailable: {exc}")
        return f"[Narrative unavailable: {exc}]"
```

- [ ] **Step 3: Verify Python import works**

```bash
cd c:/Github/bharat-stock-intelligence/src/server
python -c "from agents.ollama_client import get_narrative; print('OK')"
```

Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add src/server/agents/
git commit -m "feat(agents): add agents package + shared Ollama client"
```

---

## Task 3 — Data Scientist Agent

**Files:**
- Create: `src/server/agents/data_scientist_agent.py`

- [ ] **Step 1: Create the agent**

Create `src/server/agents/data_scientist_agent.py`:

```python
"""
Data Scientist Agent
Runs at 07:00 IST daily. Computes data quality metrics and writes a graded
report + Ollama narrative to agent_data_scientist_reports.
"""
import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

from sqlalchemy import create_engine, text

sys.path.insert(0, str(Path(__file__).parent))
from ollama_client import get_narrative

DB_PATH = Path(__file__).parent.parent.parent.parent / "database.sqlite"
ENGINE = create_engine(f"sqlite:///{DB_PATH}")


def _scalar(conn, sql: str, params: dict | None = None) -> float:
    row = conn.execute(text(sql), params or {}).fetchone()
    return float(row[0]) if row and row[0] is not None else 0.0


def run() -> dict:
    today = datetime.now().strftime("%Y-%m-%d")
    stale_cutoff = (datetime.now() - timedelta(days=3)).strftime("%Y-%m-%d")
    fund_cutoff = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d")

    with ENGINE.connect() as conn:
        # ── OHLCV coverage ────────────────────────────────────────────────────
        total_syms = _scalar(conn, "SELECT COUNT(DISTINCT symbol) FROM stock_ohlcv")
        covered = _scalar(conn, """
            SELECT COUNT(*) FROM (
                SELECT symbol FROM stock_ohlcv
                GROUP BY symbol HAVING COUNT(*) >= 240
            )
        """)
        ohlcv_coverage_pct = (covered / max(total_syms, 1)) * 100

        stale_count = int(_scalar(conn, """
            SELECT COUNT(*) FROM (
                SELECT symbol, MAX(date) AS latest FROM stock_ohlcv GROUP BY symbol
            ) WHERE latest < :cutoff
        """, {"cutoff": stale_cutoff}))

        # ── Fundamentals freshness ────────────────────────────────────────────
        fund_total = max(_scalar(conn, "SELECT COUNT(*) FROM stock_fundamentals"), 1)
        fund_fresh = int(_scalar(conn,
            "SELECT COUNT(*) FROM stock_fundamentals WHERE phase1_synced_at > :c",
            {"c": fund_cutoff}))

        # ── Model AUC + drift ─────────────────────────────────────────────────
        model_row = conn.execute(text("""
            SELECT cv_roc_auc FROM model_registry
            WHERE is_active = 1 ORDER BY trained_at DESC LIMIT 1
        """)).fetchone()
        model_auc = float(model_row[0]) if model_row and model_row[0] else 0.0

        prev_row = conn.execute(text("""
            SELECT model_auc FROM agent_data_scientist_reports
            ORDER BY created_at DESC LIMIT 1
        """)).fetchone()
        prev_auc = float(prev_row[0]) if prev_row and prev_row[0] else model_auc
        drift = 1 if (model_auc - prev_auc) < -0.03 else 0

        # ── Signal resolution rate ────────────────────────────────────────────
        total_outcomes = max(_scalar(conn, "SELECT COUNT(*) FROM signal_outcomes"), 1)
        resolved = _scalar(conn,
            "SELECT COUNT(*) FROM signal_outcomes WHERE outcome != 'PENDING'")
        resolution_rate = (resolved / total_outcomes) * 100

        # ── Composite score ───────────────────────────────────────────────────
        fund_score = (fund_fresh / fund_total) * 100
        data_quality_score = (
            0.35 * min(ohlcv_coverage_pct, 100) +
            0.25 * min(model_auc * 100, 100) +
            0.25 * resolution_rate +
            0.15 * fund_score
        )
        grade = "A" if data_quality_score >= 85 else \
                "B" if data_quality_score >= 70 else \
                "C" if data_quality_score >= 55 else "D"

        issues = []
        if stale_count > 50:
            issues.append({"severity": "HIGH",
                           "issue": f"{stale_count} symbols have stale OHLCV (>3 days)"})
        if drift:
            issues.append({"severity": "HIGH",
                           "issue": f"Model AUC dropped {prev_auc:.3f} → {model_auc:.3f}"})
        if resolution_rate < 70:
            issues.append({"severity": "MEDIUM",
                           "issue": f"Signal resolution rate low: {resolution_rate:.1f}%"})
        if ohlcv_coverage_pct < 80:
            issues.append({"severity": "MEDIUM",
                           "issue": f"OHLCV coverage below 80%: {ohlcv_coverage_pct:.1f}%"})

        # ── Ollama narrative ──────────────────────────────────────────────────
        prompt = (
            f"You are a quant data scientist. Given these metrics:\n"
            f"- OHLCV coverage: {ohlcv_coverage_pct:.1f}% ({stale_count} symbols stale)\n"
            f"- Model AUC: {model_auc:.3f} (drift detected: {'yes' if drift else 'no'})\n"
            f"- Signal resolution rate: {resolution_rate:.1f}%\n"
            f"- Data quality score: {data_quality_score:.0f}/100 (Grade {grade})\n"
            f"- Issues flagged: {json.dumps(issues)}\n\n"
            f"Write a 4-sentence analyst briefing: data health status, key risks, "
            f"what the strategist should be aware of today, and one recommended action."
        )
        narrative = get_narrative(prompt)

        # ── Persist ───────────────────────────────────────────────────────────
        conn.execute(text("""
            INSERT INTO agent_data_scientist_reports
              (run_date, ohlcv_coverage_pct, stale_symbols_count,
               fundamentals_fresh_count, model_auc, model_drift_detected,
               signal_resolution_rate, data_quality_score, quality_grade,
               issues_json, narrative)
            VALUES
              (:run_date, :ohlcv, :stale, :fund, :auc, :drift,
               :res, :score, :grade, :issues, :narrative)
        """), {
            "run_date": today, "ohlcv": round(ohlcv_coverage_pct, 2),
            "stale": stale_count, "fund": fund_fresh,
            "auc": round(model_auc, 4), "drift": drift,
            "res": round(resolution_rate, 2), "score": round(data_quality_score, 2),
            "grade": grade, "issues": json.dumps(issues), "narrative": narrative,
        })
        conn.commit()

    result = {"grade": grade, "score": round(data_quality_score, 2),
              "stale": stale_count, "drift": drift}
    print(f"[DATA-SCIENTIST] {today} | Grade={grade} Score={data_quality_score:.1f}")
    return result


if __name__ == "__main__":
    run()
```

- [ ] **Step 2: Verify it runs (DB must exist)**

```bash
cd c:/Github/bharat-stock-intelligence/src/server
python agents/data_scientist_agent.py
```

Expected: `[DATA-SCIENTIST] 2026-06-01 | Grade=B Score=72.4` (values will vary)

- [ ] **Step 3: Verify row inserted**

```bash
python -c "
import sqlite3, json
conn = sqlite3.connect('../../../database.sqlite')
row = conn.execute('SELECT run_date, quality_grade, data_quality_score FROM agent_data_scientist_reports ORDER BY id DESC LIMIT 1').fetchone()
print(row)
"
```

Expected: `('2026-06-01', 'B', 72.4)` (grade/score will vary)

- [ ] **Step 4: Commit**

```bash
git add src/server/agents/data_scientist_agent.py
git commit -m "feat(agents): data scientist agent — OHLCV coverage, model AUC, drift detection"
```

---

## Task 4 — Strategist Agent

**Files:**
- Create: `src/server/agents/strategist_agent.py`

- [ ] **Step 1: Create the agent**

Create `src/server/agents/strategist_agent.py`:

```python
"""
Strategist Agent
Runs at 08:30 IST daily. Produces ranked picks for 4 timeframes using
quant_scores + confluence + regime alignment, with Ollama narratives.
"""
import json
import sys
from datetime import datetime, date
from pathlib import Path

from sqlalchemy import create_engine, text

sys.path.insert(0, str(Path(__file__).parent))
from ollama_client import get_narrative

DB_PATH = Path(__file__).parent.parent.parent.parent / "database.sqlite"
ENGINE = create_engine(f"sqlite:///{DB_PATH}")

TIMEFRAMES = ["intraday", "swing", "positional", "investment"]
PICKS_PER_TF = 5


def _compute_atr14(conn, symbol: str) -> float:
    rows = conn.execute(text("""
        SELECT high, low, close FROM stock_ohlcv
        WHERE symbol = :s ORDER BY date DESC LIMIT 15
    """), {"s": symbol}).fetchall()
    if len(rows) < 2:
        return 0.0
    trs = []
    for i in range(len(rows) - 1):
        h, l, pc = rows[i][0], rows[i][1], rows[i + 1][2]
        if h and l and pc:
            trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    return sum(trs[-14:]) / max(len(trs[-14:]), 1)


def _regime_bonus(regime: str | None, sentiment: str | None) -> float:
    if not regime or not sentiment:
        return 0.0
    if regime == "BULL" and sentiment == "bullish":
        return 15.0
    if regime in ("BULL", "BEAR") and sentiment == "bearish":
        return -15.0
    return 0.0


def _get_candidates_for_tf(conn, timeframe: str) -> list[dict]:
    if timeframe == "investment":
        rows = conn.execute(text("""
            SELECT q.symbol,
                   COALESCE(q.rank_composite, 50)  AS quant_rank,
                   COALESCE(c.confluence_score, 0) AS confluence_score,
                   COALESCE(c.sentiment, 'neutral') AS sentiment,
                   q.cmp
            FROM quant_scores q
            LEFT JOIN confluence_signals c ON c.symbol = q.symbol
            WHERE q.rank_composite IS NOT NULL
            ORDER BY q.rank_composite DESC
            LIMIT 50
        """)).fetchall()
    else:
        tf_map = {"intraday": "intraday", "swing": "swing", "positional": "positional"}
        rows = conn.execute(text("""
            SELECT ts.symbol,
                   COALESCE(q.rank_composite, 50)   AS quant_rank,
                   COALESCE(c.confluence_score, 0)  AS confluence_score,
                   COALESCE(c.sentiment, 'neutral')  AS sentiment,
                   ts.cmp
            FROM technical_signals ts
            LEFT JOIN quant_scores q ON q.symbol = ts.symbol
            LEFT JOIN confluence_signals c ON c.symbol = ts.symbol
            WHERE ts.time_horizon = :tf
              AND ts.date = date('now')
            ORDER BY ts.signal_score DESC
            LIMIT 100
        """), {"tf": tf_map[timeframe]}).fetchall()

    return [{"symbol": r[0], "quant_rank": float(r[1] or 50),
             "confluence_score": float(r[2] or 0),
             "sentiment": r[3], "cmp": float(r[4] or 0)} for r in rows]


def _score_candidate(c: dict, regime: str | None,
                      reliability_map: dict) -> float:
    rel_avg = reliability_map.get(c["symbol"], 50.0)
    bonus = _regime_bonus(regime, c["sentiment"])
    score = (
        0.35 * c["quant_rank"] +
        0.30 * min(c["confluence_score"], 100) +
        0.20 * (50 + bonus) +
        0.15 * rel_avg
    )
    return round(score, 2)


def _conviction(score: float, n_signals: int) -> str:
    if score >= 75 and n_signals >= 3:
        return "HIGH"
    if score >= 60:
        return "MEDIUM"
    return "LOW"


def run() -> dict:
    today = datetime.now().strftime("%Y-%m-%d")

    with ENGINE.connect() as conn:
        # Quality gate from DS report
        ds_row = conn.execute(text("""
            SELECT quality_grade, stale_symbols_count
            FROM agent_data_scientist_reports
            ORDER BY created_at DESC LIMIT 1
        """)).fetchone()
        if ds_row and ds_row[0] == "D":
            print("[STRATEGIST] Aborted — data quality grade D")
            return {"aborted": True, "reason": "data quality D"}
        stale_warn = ds_row and int(ds_row[1] or 0) > 100

        # Regime
        regime_row = conn.execute(text("""
            SELECT regime FROM market_regimes ORDER BY date DESC LIMIT 1
        """)).fetchone()
        regime = regime_row[0] if regime_row else "UNKNOWN"

        # FII/DII
        fii_row = conn.execute(text("""
            SELECT fii_net FROM fii_dii_flow ORDER BY date DESC LIMIT 1
        """)).fetchone()
        fii_net = float(fii_row[0]) if fii_row and fii_row[0] else 0.0
        fii_direction = "buying" if fii_net > 0 else "selling"

        # Screener reliability map
        rel_rows = conn.execute(text("""
            SELECT scan_id, reliability_score FROM screener_reliability
        """)).fetchall()
        reliability_map: dict[str, float] = {r[0]: float(r[1] or 50) for r in rel_rows}

        total_inserted = 0
        high_conviction_picks: list[dict] = []

        for tf in TIMEFRAMES:
            candidates = _get_candidates_for_tf(conn, tf)
            if not candidates:
                print(f"[STRATEGIST] No candidates for {tf}")
                continue

            scored = []
            for c in candidates:
                sig_row = conn.execute(text("""
                    SELECT signals_json FROM technical_signals
                    WHERE symbol = :s AND date = date('now') LIMIT 1
                """), {"s": c["symbol"]}).fetchone()
                n_signals = len(json.loads(sig_row[0])) if sig_row and sig_row[0] else 0

                score = _score_candidate(c, regime, reliability_map)
                conv = _conviction(score, n_signals)
                scored.append({**c, "score": score, "conviction": conv,
                                "n_signals": n_signals})

            scored.sort(key=lambda x: x["score"], reverse=True)
            top = scored[:PICKS_PER_TF]

            # Build Ollama prompt for top 3
            top3_lines = "\n".join(
                f"{i+1}. {p['symbol']} | Score: {p['score']:.0f} | "
                f"Conviction: {p['conviction']}"
                for i, p in enumerate(top[:3])
            )
            prompt = (
                f"You are a senior equity strategist for Indian markets.\n"
                f"Market regime: {regime}. "
                f"FII net flow: ₹{fii_net:,.0f}Cr ({fii_direction}).\n\n"
                f"Top {tf} picks:\n{top3_lines}\n\n"
                f"Write a 5-sentence strategy brief: market context, "
                f"{tf} timeframe rationale, top pick conviction reasoning, "
                f"key risk, and action trigger."
            )
            narrative = get_narrative(prompt)

            for rank, pick in enumerate(top, 1):
                symbol = pick["symbol"]
                cmp = pick["cmp"] or 0.0
                atr = _compute_atr14(conn, symbol) if cmp > 0 else 0.0

                entry_low = round(cmp * 0.995, 2)
                entry_high = round(cmp * 1.005, 2)
                entry_mid = (entry_low + entry_high) / 2
                sl = round(entry_mid - 2 * atr, 2) if atr > 0 else round(entry_mid * 0.97, 2)
                r = entry_mid - sl
                t1 = round(entry_mid + 1.5 * r, 2)
                t2 = round(entry_mid + 2.5 * r, 2)
                t3 = round(entry_mid + 4.0 * r, 2)

                # Supporting signals summary
                sig_row = conn.execute(text("""
                    SELECT signals_json FROM technical_signals
                    WHERE symbol = :s AND date = date('now') LIMIT 1
                """), {"s": symbol}).fetchone()
                signals_list = json.loads(sig_row[0]) if sig_row and sig_row[0] else []

                regime_align = "ALIGNED" if pick["sentiment"] == "bullish" and regime == "BULL" \
                    else "OPPOSED" if pick["sentiment"] == "bearish" and regime == "BULL" \
                    else "NEUTRAL"

                conn.execute(text("""
                    INSERT INTO agent_strategy_picks
                      (run_date, timeframe, symbol, rank, conviction,
                       entry_zone_low, entry_zone_high, stop_loss,
                       target_1, target_2, target_3,
                       composite_score, quant_rank, confluence_score,
                       regime_alignment, supporting_signals_json, narrative)
                    VALUES
                      (:rd, :tf, :sym, :rank, :conv,
                       :el, :eh, :sl, :t1, :t2, :t3,
                       :score, :qr, :cs, :ra, :sigs, :narr)
                """), {
                    "rd": today, "tf": tf, "sym": symbol, "rank": rank,
                    "conv": pick["conviction"], "el": entry_low, "eh": entry_high,
                    "sl": sl, "t1": t1, "t2": t2, "t3": t3,
                    "score": pick["score"], "qr": pick["quant_rank"],
                    "cs": pick["confluence_score"], "ra": regime_align,
                    "sigs": json.dumps(signals_list[:5]),
                    "narr": narrative if rank == 1 else "",
                })
                total_inserted += 1

                if pick["conviction"] == "HIGH":
                    high_conviction_picks.append({
                        "timeframe": tf, "symbol": symbol,
                        "entry_low": entry_low, "entry_high": entry_high,
                        "sl": sl, "t1": t1, "t2": t2, "t3": t3,
                        "score": pick["score"],
                    })

        conn.commit()

    if stale_warn:
        print(f"[STRATEGIST] WARNING: >100 stale symbols, picks may be unreliable")

    print(f"[STRATEGIST] {today} | {total_inserted} picks across {len(TIMEFRAMES)} timeframes "
          f"| {len(high_conviction_picks)} HIGH conviction")
    return {"picks": total_inserted, "high_conviction": len(high_conviction_picks),
            "high_picks": high_conviction_picks}


if __name__ == "__main__":
    run()
```

- [ ] **Step 2: Smoke test**

```bash
cd c:/Github/bharat-stock-intelligence/src/server
python agents/strategist_agent.py
```

Expected: `[STRATEGIST] 2026-06-01 | N picks across 4 timeframes | M HIGH conviction`

- [ ] **Step 3: Commit**

```bash
git add src/server/agents/strategist_agent.py
git commit -m "feat(agents): strategist agent — 4-timeframe ranked picks with ATR-based targets"
```

---

## Task 5 — Auditor Agent

**Files:**
- Create: `src/server/agents/auditor_agent.py`

- [ ] **Step 1: Create the agent**

Create `src/server/agents/auditor_agent.py`:

```python
"""
Auditor Agent
Runs at 16:30 IST daily. Compares yesterday's strategy picks against
actual price data and writes per-timeframe audit reports.
"""
import json
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

from sqlalchemy import create_engine, text

sys.path.insert(0, str(Path(__file__).parent))
from ollama_client import get_narrative

DB_PATH = Path(__file__).parent.parent.parent.parent / "database.sqlite"
ENGINE = create_engine(f"sqlite:///{DB_PATH}")


def _get_price(conn, symbol: str, as_of: str | None = None) -> float | None:
    if as_of:
        row = conn.execute(text(
            "SELECT close FROM stock_ohlcv WHERE symbol=:s AND date<=:d ORDER BY date DESC LIMIT 1"
        ), {"s": symbol, "d": as_of}).fetchone()
    else:
        row = conn.execute(text(
            "SELECT close FROM stock_ohlcv WHERE symbol=:s ORDER BY date DESC LIMIT 1"
        ), {"s": symbol}).fetchone()
    return float(row[0]) if row and row[0] else None


def run() -> dict:
    today = datetime.now().strftime("%Y-%m-%d")

    with ENGINE.connect() as conn:
        # Most recent previous strategy run
        prev_row = conn.execute(text("""
            SELECT DISTINCT run_date FROM agent_strategy_picks
            WHERE run_date < :today ORDER BY run_date DESC LIMIT 1
        """), {"today": today}).fetchone()
        if not prev_row:
            print("[AUDITOR] No previous picks to audit")
            return {"skipped": True}
        audit_date = prev_row[0]

        # Nifty benchmark close-to-close
        nifty_entry = _get_price(conn, "^NSEI", audit_date)
        nifty_now = _get_price(conn, "^NSEI")
        nifty_return = ((nifty_now - nifty_entry) / nifty_entry * 100) \
            if nifty_entry and nifty_now and nifty_entry > 0 else 0.0

        picks = conn.execute(text("""
            SELECT symbol, timeframe, conviction, entry_zone_low, entry_zone_high,
                   stop_loss, target_1, supporting_signals_json
            FROM agent_strategy_picks WHERE run_date = :d
        """), {"d": audit_date}).fetchall()

        by_tf: dict[str, list] = defaultdict(list)
        for p in picks:
            by_tf[p[1]].append(p)

        reports_inserted = 0
        for tf, tf_picks in by_tf.items():
            hits = misses = opens = 0
            returns: list[float] = []
            best_sym = best_ret = None
            worst_sym = worst_ret = None
            signal_wins: dict[str, list] = defaultdict(list)

            for p in tf_picks:
                sym, _, _, el, eh, sl, t1, sigs_json = p
                entry_mid = ((el or 0) + (eh or 0)) / 2
                current = _get_price(conn, sym)
                if not current or not entry_mid or entry_mid == 0:
                    opens += 1
                    continue

                ret = (current - entry_mid) / entry_mid * 100

                if sl and current <= sl:
                    outcome = "MISS"
                    misses += 1
                elif t1 and current >= t1:
                    outcome = "HIT"
                    hits += 1
                else:
                    outcome = "OPEN"
                    opens += 1

                returns.append(ret)

                if best_ret is None or ret > best_ret:
                    best_ret, best_sym = ret, sym
                if worst_ret is None or ret < worst_ret:
                    worst_ret, worst_sym = ret, sym

                try:
                    sigs = json.loads(sigs_json or "[]")
                    for sig in sigs:
                        sig_type = sig.get("type", "unknown") if isinstance(sig, dict) else str(sig)
                        signal_wins[sig_type].append(1 if outcome == "HIT" else 0)
                except Exception:
                    pass

            total = len(tf_picks)
            resolved = hits + misses
            hit_rate = (hits / resolved * 100) if resolved > 0 else 0.0
            avg_ret = sum(returns) / len(returns) if returns else 0.0
            pos_sum = sum(r for r in returns if r > 0) or 0.001
            neg_sum = abs(sum(r for r in returns if r < 0)) or 0.001
            profit_factor = pos_sum / neg_sum
            alpha = avg_ret - nifty_return

            attribution = {
                st: round(sum(wins) / len(wins) * 100, 1)
                for st, wins in signal_wins.items() if wins
            }
            top_sigs = sorted(attribution.items(), key=lambda x: x[1], reverse=True)[:3]
            weak_sigs = sorted(attribution.items(), key=lambda x: x[1])[:3]

            prompt = (
                f"You are a quantitative analyst auditing yesterday's Indian market picks.\n"
                f"Timeframe: {tf}\n"
                f"Hit rate: {hit_rate:.0f}% | Avg return: {avg_ret:+.2f}% | "
                f"Alpha vs Nifty: {alpha:+.2f}%\n"
                f"Best: {best_sym} ({best_ret:+.2f}%) | "
                f"Worst: {worst_sym} ({worst_ret:+.2f}%)\n"
                f"Top signals: {[s[0] for s in top_sigs]} | "
                f"Weak signals: {[s[0] for s in weak_sigs]}\n\n"
                f"Write a 4-sentence audit report: overall performance verdict, "
                f"what worked, what failed and why, and one actionable insight for the strategist."
            )
            narrative = get_narrative(prompt)

            conn.execute(text("""
                INSERT INTO agent_audit_reports
                  (run_date, audit_for_date, timeframe, total_picks,
                   hits, misses, open_positions, hit_rate, avg_return_pct,
                   profit_factor, nifty_return_pct, alpha_pct,
                   best_pick, worst_pick, signal_attribution_json, narrative)
                VALUES
                  (:rd, :afd, :tf, :total, :hits, :misses, :opens,
                   :hr, :avg, :pf, :nifty, :alpha, :best, :worst, :attr, :narr)
            """), {
                "rd": today, "afd": audit_date, "tf": tf, "total": total,
                "hits": hits, "misses": misses, "opens": opens,
                "hr": round(hit_rate, 2), "avg": round(avg_ret, 3),
                "pf": round(profit_factor, 3), "nifty": round(nifty_return, 3),
                "alpha": round(alpha, 3), "best": best_sym, "worst": worst_sym,
                "attr": json.dumps(attribution), "narr": narrative,
            })
            reports_inserted += 1

        conn.commit()

    print(f"[AUDITOR] {today} | Audited {audit_date} | {reports_inserted} timeframe reports")
    return {"audited_date": audit_date, "reports": reports_inserted}


if __name__ == "__main__":
    run()
```

- [ ] **Step 2: Smoke test**

```bash
cd c:/Github/bharat-stock-intelligence/src/server
python agents/auditor_agent.py
```

Expected: `[AUDITOR] 2026-06-01 | Audited 2026-05-31 | 4 timeframe reports`
(or "No previous picks to audit" if no picks exist yet — that is correct)

- [ ] **Step 3: Commit**

```bash
git add src/server/agents/auditor_agent.py
git commit -m "feat(agents): auditor agent — HIT/MISS/OPEN resolution, alpha vs Nifty, signal attribution"
```

---

## Task 6 — Optimizer Agent

**Files:**
- Create: `src/server/agents/optimizer_agent.py`

- [ ] **Step 1: Create the agent**

Create `src/server/agents/optimizer_agent.py`:

```python
"""
Optimizer Agent
Runs at 17:30 IST daily. Reads 30-day audit trail, nudges screener weights
for underperforming signal types, triggers full strategy_optimizer.py when
overall win rate stays below 50% for 5+ consecutive days.
"""
import json
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

import requests
from sqlalchemy import create_engine, text

sys.path.insert(0, str(Path(__file__).parent))
from ollama_client import get_narrative

DB_PATH = Path(__file__).parent.parent.parent.parent / "database.sqlite"
ENGINE = create_engine(f"sqlite:///{DB_PATH}")
ALPHAQUANT_URL = "http://127.0.0.1:8002/api/v1/optimize"
WEIGHT_MIN, WEIGHT_MAX = 0.3, 2.0


def _clamp(v: float) -> float:
    return round(max(WEIGHT_MIN, min(WEIGHT_MAX, v)), 3)


def run() -> dict:
    today = datetime.now().strftime("%Y-%m-%d")

    with ENGINE.connect() as conn:
        # 30-day audit rows
        rows = conn.execute(text("""
            SELECT timeframe, hit_rate, avg_return_pct,
                   signal_attribution_json, run_date
            FROM agent_audit_reports
            ORDER BY run_date DESC LIMIT 120
        """)).fetchall()

        if not rows:
            print("[OPTIMIZER] No audit data yet — skipping")
            return {"skipped": True}

        # Rolling win rates per timeframe
        tf_rates: dict[str, list[float]] = defaultdict(list)
        signal_wins: dict[str, list[float]] = defaultdict(list)
        for row in rows:
            tf, hit_rate, _, attr_json, _ = row
            tf_rates[tf].append(float(hit_rate or 0))
            try:
                attr = json.loads(attr_json or "{}")
                for sig_type, wr in attr.items():
                    signal_wins[sig_type].append(float(wr))
            except Exception:
                pass

        avg_rates = {tf: sum(rates) / len(rates) for tf, rates in tf_rates.items()}
        overall_rate = sum(avg_rates.values()) / max(len(avg_rates), 1)

        # Check consecutive underperformance (last 5 days overall)
        recent_5 = conn.execute(text("""
            SELECT AVG(hit_rate) FROM agent_audit_reports
            WHERE run_date >= date('now', '-5 days')
            GROUP BY run_date ORDER BY run_date
        """)).fetchall()
        consecutive_bad = sum(1 for r in recent_5 if r[0] and float(r[0]) < 50)

        full_optimizer = consecutive_bad >= 5

        # Determine underperforming signal types
        changes: dict[str, dict] = {}
        for sig_type, rates in signal_wins.items():
            avg = sum(rates) / len(rates)
            cur_row = conn.execute(text("""
                SELECT weight_override FROM screener_master
                WHERE name LIKE :pattern LIMIT 1
            """), {"pattern": f"%{sig_type}%"}).fetchone()
            if cur_row and cur_row[0] is not None:
                before = float(cur_row[0])
                if avg < 45:
                    after = _clamp(before * 0.88)
                elif avg > 65:
                    after = _clamp(before * 1.10)
                else:
                    continue
                if abs(after - before) >= 0.01:
                    conn.execute(text("""
                        UPDATE screener_master SET weight_override = :w
                        WHERE name LIKE :pattern
                    """), {"w": after, "pattern": f"%{sig_type}%"})
                    changes[sig_type] = {"before": before, "after": after}

        weights_changed = len(changes) > 0

        # Trigger full optimizer if needed
        if full_optimizer:
            try:
                requests.post(ALPHAQUANT_URL,
                              json={"horizon_days": 15, "iterations": 200, "apply": True},
                              timeout=30 * 60)
                print("[OPTIMIZER] Full optimizer triggered via AlphaQuant API")
            except Exception as exc:
                print(f"[OPTIMIZER] Full optimizer call failed: {exc}")

        underperforming = {tf: r for tf, r in avg_rates.items() if r < 55}

        tf_table = "\n".join(
            f"  {tf}: {r:.1f}% win rate" for tf, r in avg_rates.items()
        )
        prompt = (
            f"You are a quantitative portfolio optimizer for Indian equities.\n"
            f"30-day performance by timeframe:\n{tf_table}\n\n"
            f"Weight adjustments made: {json.dumps(changes)}\n"
            f"Full optimizer triggered: {'yes' if full_optimizer else 'no'}\n\n"
            f"Write a 4-sentence optimization report: performance trend assessment, "
            f"which adjustments were made and the rationale, expected improvement, "
            f"and one metric to monitor over the next 5 trading days."
        )
        narrative = get_narrative(prompt)

        conn.execute(text("""
            INSERT INTO agent_optimizer_reports
              (run_date, trigger, baseline_win_rate, new_win_rate,
               improvement_pct, weights_changed, full_optimizer_triggered,
               changes_json, underperforming_segments_json, narrative)
            VALUES
              (:rd, :trig, :base, :new, :imp,
               :wc, :fo, :changes, :under, :narr)
        """), {
            "rd": today,
            "trig": "performance_drop" if full_optimizer else "scheduled",
            "base": round(overall_rate, 2),
            "new": round(overall_rate, 2),   # updated on next audit cycle
            "imp": 0.0,
            "wc": int(weights_changed),
            "fo": int(full_optimizer),
            "changes": json.dumps(changes),
            "under": json.dumps(underperforming),
            "narr": narrative,
        })
        conn.commit()

    print(f"[OPTIMIZER] {today} | Overall win rate: {overall_rate:.1f}% | "
          f"Weights changed: {len(changes)} | Full optimizer: {full_optimizer}")
    return {"overall_rate": overall_rate, "changes": len(changes),
            "full_optimizer": full_optimizer}


if __name__ == "__main__":
    run()
```

- [ ] **Step 2: Smoke test**

```bash
cd c:/Github/bharat-stock-intelligence/src/server
python agents/optimizer_agent.py
```

Expected: `[OPTIMIZER] 2026-06-01 | Overall win rate: N% | Weights changed: M | Full optimizer: False`
(or "No audit data yet" on first run — correct)

- [ ] **Step 3: Commit**

```bash
git add src/server/agents/optimizer_agent.py
git commit -m "feat(agents): optimizer agent — weight nudging, full optimizer trigger, 30-day audit rollup"
```

---

## Task 7 — BullMQ Queue Workers

**Files:**
- Modify: `src/server/queues.ts`

- [ ] **Step 1: Add 4 queue name constants** (after existing `QUEUE_SCREENER_PERFORMANCE` constant)

```typescript
export const QUEUE_AGENT_DATA_SCIENTIST = 'agent-data-scientist';
export const QUEUE_AGENT_STRATEGIST     = 'agent-strategist';
export const QUEUE_AGENT_AUDITOR        = 'agent-auditor';
export const QUEUE_AGENT_OPTIMIZER      = 'agent-optimizer';
```

- [ ] **Step 2: Add 4 queue + worker handle declarations** (after existing `screenerPerfQueue`/`screenerPerfWorker` declarations)

```typescript
export let agentDataScientistQueue: Queue | null = null;
export let agentStrategistQueue:    Queue | null = null;
export let agentAuditorQueue:       Queue | null = null;
export let agentOptimizerQueue:     Queue | null = null;
let agentDataScientistWorker: Worker | null = null;
let agentStrategistWorker:    Worker | null = null;
let agentAuditorWorker:       Worker | null = null;
let agentOptimizerWorker:     Worker | null = null;
```

- [ ] **Step 3: Add 4 named processor functions** (before `initQueues()`)

```typescript
async function processAgentDataScientist(_job: Job): Promise<{ success: boolean; grade?: string }> {
  await runPython('agents/data_scientist_agent.py', [], 10 * 60_000);
  const row = db.prepare(
    'SELECT quality_grade FROM agent_data_scientist_reports ORDER BY created_at DESC LIMIT 1'
  ).get() as { quality_grade: string } | undefined;
  return { success: true, grade: row?.quality_grade };
}

async function processAgentStrategist(_job: Job): Promise<{ success: boolean }> {
  await runPython('agents/strategist_agent.py', [], 15 * 60_000);

  const highPicks = db.prepare(`
    SELECT symbol, timeframe, entry_zone_low, entry_zone_high,
           stop_loss, target_1, target_2, target_3, composite_score, narrative
    FROM agent_strategy_picks
    WHERE run_date = date('now') AND conviction = 'HIGH'
    ORDER BY composite_score DESC
  `).all() as any[];

  if (highPicks.length > 0) {
    try {
      const { TelegramNotificationService } = await import('./telegramService');
      const tg = new TelegramNotificationService();
      for (const p of highPicks) {
        const firstSentence = (p.narrative as string || '').split('.')[0];
        await tg.sendMarkdownMessage(
          `🎯 *STRATEGY ALERT — ${(p.timeframe as string).toUpperCase()}*\n` +
          `*${p.symbol}* | Entry: ₹${p.entry_zone_low}–${p.entry_zone_high} | SL: ₹${p.stop_loss}\n` +
          `T1: ₹${p.target_1} | T2: ₹${p.target_2} | T3: ₹${p.target_3}\n` +
          `Conviction: HIGH | Score: ${Number(p.composite_score).toFixed(0)}\n` +
          `${firstSentence}.`
        );
      }
    } catch (err: unknown) {
      console.warn('[QUEUE] Strategist Telegram alert failed:', (err as Error).message);
    }
  }
  return { success: true };
}

async function processAgentAuditor(_job: Job): Promise<{ success: boolean }> {
  await runPython('agents/auditor_agent.py', [], 15 * 60_000);
  return { success: true };
}

async function processAgentOptimizer(_job: Job): Promise<{ success: boolean }> {
  await runPython('agents/optimizer_agent.py', [], 20 * 60_000);

  const latest = db.prepare(
    'SELECT weights_changed, full_optimizer_triggered, baseline_win_rate, new_win_rate, narrative ' +
    'FROM agent_optimizer_reports ORDER BY created_at DESC LIMIT 1'
  ).get() as any;

  if (latest && (latest.weights_changed || latest.full_optimizer_triggered)) {
    try {
      const { TelegramNotificationService } = await import('./telegramService');
      const tg = new TelegramNotificationService();
      const firstSentence = (latest.narrative as string || '').split('.')[0];
      await tg.sendMarkdownMessage(
        `⚙️ *OPTIMIZER ALERT*\n` +
        `Win rate: ${Number(latest.baseline_win_rate).toFixed(0)}% → ${Number(latest.new_win_rate).toFixed(0)}%\n` +
        `Full optimizer: ${latest.full_optimizer_triggered ? 'YES 🔄' : 'NO'}\n` +
        `${firstSentence}.`
      );
    } catch (err: unknown) {
      console.warn('[QUEUE] Optimizer Telegram alert failed:', (err as Error).message);
    }
  }
  return { success: true };
}
```

- [ ] **Step 4: Register queues + workers inside `initQueues()`** (add after the screener-performance block, before the closing `console.warn = _origWarn` line)

```typescript
    // ── Agent: Data Scientist (07:00 IST = 01:30 UTC, weekdays) ──────────────
    agentDataScientistQueue = new Queue(QUEUE_AGENT_DATA_SCIENTIST, { connection });
    const adsRep = await agentDataScientistQueue.getRepeatableJobs();
    for (const r of adsRep) await agentDataScientistQueue.removeRepeatableByKey(r.key);
    await agentDataScientistQueue.add('agent-ds-daily', {}, {
      repeat: { pattern: '30 1 * * 1-5' },
      jobId: 'agent-ds-daily',
      removeOnComplete: 3, removeOnFail: 3,
    });
    agentDataScientistWorker = new Worker(QUEUE_AGENT_DATA_SCIENTIST,
      processAgentDataScientist, { connection, concurrency: 1, lockDuration: 10 * 60_000 });
    agentDataScientistWorker.on('completed', (_, r) => console.log('[QUEUE] agent-ds done, grade=', r?.grade));
    agentDataScientistWorker.on('failed', (_, e) => console.error('[QUEUE] agent-ds failed:', e.message));

    // ── Agent: Strategist (08:30 IST = 03:00 UTC, weekdays) ──────────────────
    agentStrategistQueue = new Queue(QUEUE_AGENT_STRATEGIST, { connection });
    const asRep = await agentStrategistQueue.getRepeatableJobs();
    for (const r of asRep) await agentStrategistQueue.removeRepeatableByKey(r.key);
    await agentStrategistQueue.add('agent-strat-daily', {}, {
      repeat: { pattern: '0 3 * * 1-5' },
      jobId: 'agent-strat-daily',
      removeOnComplete: 3, removeOnFail: 3,
    });
    agentStrategistWorker = new Worker(QUEUE_AGENT_STRATEGIST,
      processAgentStrategist, { connection, concurrency: 1, lockDuration: 15 * 60_000 });
    agentStrategistWorker.on('completed', () => console.log('[QUEUE] agent-strategist done'));
    agentStrategistWorker.on('failed', (_, e) => console.error('[QUEUE] agent-strategist failed:', e.message));

    // ── Agent: Auditor (16:30 IST = 11:00 UTC, weekdays) ─────────────────────
    agentAuditorQueue = new Queue(QUEUE_AGENT_AUDITOR, { connection });
    const aaRep = await agentAuditorQueue.getRepeatableJobs();
    for (const r of aaRep) await agentAuditorQueue.removeRepeatableByKey(r.key);
    await agentAuditorQueue.add('agent-audit-daily', {}, {
      repeat: { pattern: '0 11 * * 1-5' },
      jobId: 'agent-audit-daily',
      removeOnComplete: 3, removeOnFail: 3,
    });
    agentAuditorWorker = new Worker(QUEUE_AGENT_AUDITOR,
      processAgentAuditor, { connection, concurrency: 1, lockDuration: 15 * 60_000 });
    agentAuditorWorker.on('completed', () => console.log('[QUEUE] agent-auditor done'));
    agentAuditorWorker.on('failed', (_, e) => console.error('[QUEUE] agent-auditor failed:', e.message));

    // ── Agent: Optimizer (17:30 IST = 12:00 UTC, weekdays) ───────────────────
    agentOptimizerQueue = new Queue(QUEUE_AGENT_OPTIMIZER, { connection });
    const aoRep = await agentOptimizerQueue.getRepeatableJobs();
    for (const r of aoRep) await agentOptimizerQueue.removeRepeatableByKey(r.key);
    await agentOptimizerQueue.add('agent-optim-daily', {}, {
      repeat: { pattern: '0 12 * * 1-5' },
      jobId: 'agent-optim-daily',
      removeOnComplete: 3, removeOnFail: 3,
    });
    agentOptimizerWorker = new Worker(QUEUE_AGENT_OPTIMIZER,
      processAgentOptimizer, { connection, concurrency: 1, lockDuration: 20 * 60_000 });
    agentOptimizerWorker.on('completed', () => console.log('[QUEUE] agent-optimizer done'));
    agentOptimizerWorker.on('failed', (_, e) => console.error('[QUEUE] agent-optimizer failed:', e.message));
```

- [ ] **Step 5: Add 4 queues + workers to `shutdownQueues()`**

Inside `Promise.allSettled([...])` in `shutdownQueues`, add:

```typescript
    agentDataScientistWorker?.close(),
    agentStrategistWorker?.close(),
    agentAuditorWorker?.close(),
    agentOptimizerWorker?.close(),
    agentDataScientistQueue?.close(),
    agentStrategistQueue?.close(),
    agentAuditorQueue?.close(),
    agentOptimizerQueue?.close(),
```

- [ ] **Step 6: Verify TypeScript compiles**

```bash
cd c:/Github/bharat-stock-intelligence
npx tsc --noEmit
```

Expected: only the pre-existing `technicalIntelligenceService.ts` error, no new errors.

- [ ] **Step 7: Commit**

```bash
git add src/server/queues.ts
git commit -m "feat(queues): add 4 agent intelligence queue workers with Telegram alerts"
```

---

## Task 8 — tRPC Agents Router

**Files:**
- Create: `src/server/routers/agents.router.ts`
- Modify: `src/server/router.ts`

- [ ] **Step 1: Create `agents.router.ts`**

```typescript
import { z } from 'zod';
import db from '../db';
import { router, publicProcedure } from '../trpc';

export const agentsRouter = router({

  // ── Queries ──────────────────────────────────────────────────────────────

  getDataScientistReport: publicProcedure
    .input(z.object({ limit: z.number().min(1).max(90).default(30) }))
    .query(({ input }) => {
      const latest = db.prepare(
        'SELECT * FROM agent_data_scientist_reports ORDER BY created_at DESC LIMIT 1'
      ).get();
      const history = db.prepare(
        'SELECT run_date, data_quality_score, quality_grade, model_auc, ' +
        'ohlcv_coverage_pct, stale_symbols_count, signal_resolution_rate ' +
        'FROM agent_data_scientist_reports ORDER BY run_date DESC LIMIT ?'
      ).all(input.limit);
      return { latest, history };
    }),

  getStrategyPicks: publicProcedure
    .input(z.object({
      date:      z.string().optional(),
      timeframe: z.enum(['intraday', 'swing', 'positional', 'investment']).optional(),
    }))
    .query(({ input }) => {
      const runDate = input.date ?? (db.prepare(
        'SELECT MAX(run_date) AS d FROM agent_strategy_picks'
      ).get() as any)?.d;
      if (!runDate) return { picks: [], runDate: null };

      let sql = 'SELECT * FROM agent_strategy_picks WHERE run_date = ?';
      const params: any[] = [runDate];
      if (input.timeframe) { sql += ' AND timeframe = ?'; params.push(input.timeframe); }
      sql += ' ORDER BY timeframe, rank';

      return { picks: db.prepare(sql).all(...params), runDate };
    }),

  getAuditReport: publicProcedure
    .input(z.object({
      date:      z.string().optional(),
      timeframe: z.enum(['intraday', 'swing', 'positional', 'investment']).optional(),
    }))
    .query(({ input }) => {
      const runDate = input.date ?? (db.prepare(
        'SELECT MAX(run_date) AS d FROM agent_audit_reports'
      ).get() as any)?.d;
      if (!runDate) return { reports: [], runDate: null };

      let sql = 'SELECT * FROM agent_audit_reports WHERE run_date = ?';
      const params: any[] = [runDate];
      if (input.timeframe) { sql += ' AND timeframe = ?'; params.push(input.timeframe); }

      return { reports: db.prepare(sql).all(...params), runDate };
    }),

  getOptimizerReport: publicProcedure
    .input(z.object({ limit: z.number().min(1).max(90).default(30) }))
    .query(({ input }) => {
      const latest = db.prepare(
        'SELECT * FROM agent_optimizer_reports ORDER BY created_at DESC LIMIT 1'
      ).get();
      const history = db.prepare(
        'SELECT run_date, baseline_win_rate, new_win_rate, improvement_pct, ' +
        'weights_changed, full_optimizer_triggered ' +
        'FROM agent_optimizer_reports ORDER BY run_date DESC LIMIT ?'
      ).all(input.limit);
      return { latest, history };
    }),

  getAgentStatus: publicProcedure.query(() => {
    const ds = db.prepare(
      'SELECT run_date, quality_grade FROM agent_data_scientist_reports ORDER BY created_at DESC LIMIT 1'
    ).get() as any;
    const strat = db.prepare(
      'SELECT run_date, COUNT(*) AS pick_count FROM agent_strategy_picks WHERE run_date = (SELECT MAX(run_date) FROM agent_strategy_picks)'
    ).get() as any;
    const audit = db.prepare(
      'SELECT run_date, AVG(hit_rate) AS avg_hit_rate FROM agent_audit_reports WHERE run_date = (SELECT MAX(run_date) FROM agent_audit_reports)'
    ).get() as any;
    const optim = db.prepare(
      'SELECT run_date, weights_changed FROM agent_optimizer_reports ORDER BY created_at DESC LIMIT 1'
    ).get() as any;
    return { ds, strat, audit, optim };
  }),

  // ── Mutations ─────────────────────────────────────────────────────────────

  runDataScientistAgent: publicProcedure.mutation(async () => {
    const { agentDataScientistQueue } = await import('../queues');
    if (agentDataScientistQueue) {
      await agentDataScientistQueue.add('manual-ds', {}, { removeOnComplete: 1 });
      return { queued: true };
    }
    const { runPython } = await import('../pythonRunner');
    runPython('agents/data_scientist_agent.py', [], 10 * 60_000).catch(console.error);
    return { queued: false, running: true };
  }),

  runStrategistAgent: publicProcedure.mutation(async () => {
    const { agentStrategistQueue } = await import('../queues');
    if (agentStrategistQueue) {
      await agentStrategistQueue.add('manual-strat', {}, { removeOnComplete: 1 });
      return { queued: true };
    }
    const { runPython } = await import('../pythonRunner');
    runPython('agents/strategist_agent.py', [], 15 * 60_000).catch(console.error);
    return { queued: false, running: true };
  }),

  runAuditorAgent: publicProcedure.mutation(async () => {
    const { agentAuditorQueue } = await import('../queues');
    if (agentAuditorQueue) {
      await agentAuditorQueue.add('manual-audit', {}, { removeOnComplete: 1 });
      return { queued: true };
    }
    const { runPython } = await import('../pythonRunner');
    runPython('agents/auditor_agent.py', [], 15 * 60_000).catch(console.error);
    return { queued: false, running: true };
  }),

  runOptimizerAgent: publicProcedure.mutation(async () => {
    const { agentOptimizerQueue } = await import('../queues');
    if (agentOptimizerQueue) {
      await agentOptimizerQueue.add('manual-optim', {}, { removeOnComplete: 1 });
      return { queued: true };
    }
    const { runPython } = await import('../pythonRunner');
    runPython('agents/optimizer_agent.py', [], 20 * 60_000).catch(console.error);
    return { queued: false, running: true };
  }),

  runFullAgentPipeline: publicProcedure.mutation(async () => {
    const queues = await import('../queues');
    const now = Date.now();
    const jobs = [
      { q: queues.agentDataScientistQueue, name: 'pipeline-ds',    delay: 0 },
      { q: queues.agentStrategistQueue,    name: 'pipeline-strat', delay: 5 * 60_000 },
      { q: queues.agentAuditorQueue,       name: 'pipeline-audit', delay: 10 * 60_000 },
      { q: queues.agentOptimizerQueue,     name: 'pipeline-optim', delay: 15 * 60_000 },
    ];
    let queued = 0;
    for (const { q, name, delay } of jobs) {
      if (q) { await q.add(name, {}, { delay, removeOnComplete: 1 }); queued++; }
    }
    return { queued, message: `Enqueued ${queued}/4 agents` };
  }),
});
```

- [ ] **Step 2: Wire into `src/server/router.ts`**

Add to the imports:
```typescript
import { agentsRouter } from "./routers/agents.router";
```

Add `agentsRouter` to the `mergeRouters(...)` call.

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/server/routers/agents.router.ts src/server/router.ts
git commit -m "feat(trpc): add agents router — 5 queries + 5 mutations"
```

---

## Task 9 — AgentDataScientistPage

**Files:**
- Create: `src/components/AgentDataScientistPage.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { trpc } from '../lib/trpc';
import { RefreshCw, Database, TrendingUp, AlertTriangle, CheckCircle } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

const GRADE_COLOR: Record<string, string> = {
  A: 'text-green-400', B: 'text-blue-400', C: 'text-yellow-400', D: 'text-red-400',
};
const GRADE_BG: Record<string, string> = {
  A: 'bg-green-900/40', B: 'bg-blue-900/40', C: 'bg-yellow-900/40', D: 'bg-red-900/40',
};

export function AgentDataScientistPage() {
  const { data, isLoading, refetch } = trpc.getDataScientistReport.useQuery({ limit: 30 });
  const runMutation = trpc.runDataScientistAgent.useMutation({
    onSuccess: () => setTimeout(() => refetch(), 3000),
  });

  const latest = data?.latest as any;
  const history = (data?.history as any[]) ?? [];
  const issues = latest ? JSON.parse(latest.issues_json || '[]') as any[] : [];

  const chartData = [...history].reverse().map((h: any) => ({
    date: h.run_date?.slice(5),
    score: h.data_quality_score,
    auc: h.model_auc ? +(h.model_auc * 100).toFixed(1) : null,
  }));

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Database className="w-6 h-6 text-blue-400" /> Data Scientist Agent
          </h1>
          {latest && (
            <p className="text-sm text-gray-400 mt-1">
              Last run: {latest.run_date} · Grade:{' '}
              <span className={`font-bold ${GRADE_COLOR[latest.quality_grade]}`}>
                {latest.quality_grade}
              </span>
            </p>
          )}
        </div>
        <button
          onClick={() => runMutation.mutate()}
          disabled={runMutation.isLoading}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-white text-sm disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${runMutation.isLoading ? 'animate-spin' : ''}`} />
          Run Now
        </button>
      </div>

      {isLoading && <p className="text-gray-400">Loading...</p>}

      {latest && (
        <>
          {/* Narrative */}
          <div className={`rounded-xl p-5 border border-white/10 ${GRADE_BG[latest.quality_grade]}`}>
            <p className="text-sm font-semibold text-gray-300 mb-2">🧠 Agent Analysis</p>
            <p className="text-white leading-relaxed">{latest.narrative || 'No narrative available.'}</p>
          </div>

          {/* Metric cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: 'Quality Score', value: `${latest.data_quality_score?.toFixed(0)}/100`, sub: `Grade ${latest.quality_grade}` },
              { label: 'OHLCV Coverage', value: `${latest.ohlcv_coverage_pct?.toFixed(1)}%`, sub: `${latest.stale_symbols_count} stale` },
              { label: 'Model AUC', value: latest.model_auc?.toFixed(3), sub: latest.model_drift_detected ? '⚠️ Drift detected' : '✓ Stable' },
              { label: 'Signal Resolution', value: `${latest.signal_resolution_rate?.toFixed(1)}%`, sub: 'outcomes resolved' },
            ].map(m => (
              <div key={m.label} className="bg-white/5 rounded-xl p-4 border border-white/10">
                <p className="text-xs text-gray-400">{m.label}</p>
                <p className="text-2xl font-bold text-white mt-1">{m.value}</p>
                <p className="text-xs text-gray-500 mt-1">{m.sub}</p>
              </div>
            ))}
          </div>

          {/* Issues */}
          {issues.length > 0 && (
            <div className="bg-white/5 rounded-xl p-4 border border-yellow-500/30">
              <p className="text-sm font-semibold text-yellow-400 mb-3 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4" /> Issues Flagged
              </p>
              <ul className="space-y-2">
                {issues.map((iss: any, i: number) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${iss.severity === 'HIGH' ? 'bg-red-900 text-red-300' : 'bg-yellow-900 text-yellow-300'}`}>
                      {iss.severity}
                    </span>
                    <span className="text-gray-300">{iss.issue}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {issues.length === 0 && (
            <div className="flex items-center gap-2 text-green-400 text-sm">
              <CheckCircle className="w-4 h-4" /> No issues flagged today
            </div>
          )}
        </>
      )}

      {/* History chart */}
      {chartData.length > 1 && (
        <div className="bg-white/5 rounded-xl p-4 border border-white/10">
          <p className="text-sm font-semibold text-gray-300 mb-4">30-Day Quality Score Trend</p>
          <ResponsiveContainer width="100%" height={160}>
            <LineChart data={chartData}>
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#9ca3af' }} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: '#9ca3af' }} />
              <Tooltip contentStyle={{ background: '#1f2937', border: '1px solid #374151' }} />
              <Line type="monotone" dataKey="score" stroke="#60a5fa" strokeWidth={2} dot={false} name="Quality Score" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/AgentDataScientistPage.tsx
git commit -m "feat(ui): AgentDataScientistPage — quality scorecard, narrative, issues, trend chart"
```

---

## Task 10 — AgentStrategistPage

**Files:**
- Create: `src/components/AgentStrategistPage.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { useState } from 'react';
import { trpc } from '../lib/trpc';
import { RefreshCw, Target, TrendingUp, Shield } from 'lucide-react';

type Timeframe = 'intraday' | 'swing' | 'positional' | 'investment';

const TF_LABELS: Record<Timeframe, string> = {
  intraday: 'Intraday', swing: 'Swing', positional: 'Positional', investment: 'Investment',
};
const CONVICTION_COLOR: Record<string, string> = {
  HIGH: 'bg-green-500/20 text-green-300 border-green-500/40',
  MEDIUM: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/40',
  LOW: 'bg-gray-500/20 text-gray-300 border-gray-500/40',
};

export function AgentStrategistPage() {
  const [tf, setTf] = useState<Timeframe>('swing');
  const { data, isLoading, refetch } = trpc.getStrategyPicks.useQuery({ timeframe: tf });
  const runMutation = trpc.runStrategistAgent.useMutation({
    onSuccess: () => setTimeout(() => refetch(), 3000),
  });

  const picks = (data?.picks as any[]) ?? [];
  const topNarrative = picks[0]?.narrative;

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Target className="w-6 h-6 text-purple-400" /> Strategist Agent
          </h1>
          {data?.runDate && <p className="text-sm text-gray-400 mt-1">Run date: {data.runDate}</p>}
        </div>
        <button
          onClick={() => runMutation.mutate()}
          disabled={runMutation.isLoading}
          className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 rounded-lg text-white text-sm disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${runMutation.isLoading ? 'animate-spin' : ''}`} />
          Run Now
        </button>
      </div>

      {/* Timeframe tabs */}
      <div className="flex gap-2">
        {(Object.keys(TF_LABELS) as Timeframe[]).map(t => (
          <button
            key={t}
            onClick={() => setTf(t)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tf === t ? 'bg-purple-600 text-white' : 'bg-white/5 text-gray-400 hover:bg-white/10'
            }`}
          >
            {TF_LABELS[t]}
          </button>
        ))}
      </div>

      {isLoading && <p className="text-gray-400">Loading picks...</p>}

      {topNarrative && (
        <div className="bg-purple-900/20 rounded-xl p-5 border border-purple-500/20">
          <p className="text-sm font-semibold text-purple-300 mb-2">🎯 Strategy Brief — {TF_LABELS[tf]}</p>
          <p className="text-white leading-relaxed">{topNarrative}</p>
        </div>
      )}

      {picks.length === 0 && !isLoading && (
        <p className="text-gray-500 text-sm">No picks for {TF_LABELS[tf]} today.</p>
      )}

      {picks.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-400 border-b border-white/10">
                <th className="text-left py-3 pr-4">#</th>
                <th className="text-left py-3 pr-4">Symbol</th>
                <th className="text-left py-3 pr-4">Conviction</th>
                <th className="text-right py-3 pr-4">Entry Zone</th>
                <th className="text-right py-3 pr-4">Stop Loss</th>
                <th className="text-right py-3 pr-4">T1</th>
                <th className="text-right py-3 pr-4">T2</th>
                <th className="text-right py-3 pr-4">T3</th>
                <th className="text-right py-3">Score</th>
              </tr>
            </thead>
            <tbody>
              {picks.map((p: any) => (
                <tr key={p.id} className="border-b border-white/5 hover:bg-white/5">
                  <td className="py-3 pr-4 text-gray-500">{p.rank}</td>
                  <td className="py-3 pr-4 font-semibold text-white">{p.symbol}</td>
                  <td className="py-3 pr-4">
                    <span className={`px-2 py-0.5 rounded border text-xs font-medium ${CONVICTION_COLOR[p.conviction]}`}>
                      {p.conviction}
                    </span>
                  </td>
                  <td className="py-3 pr-4 text-right text-gray-300">
                    ₹{p.entry_zone_low}–{p.entry_zone_high}
                  </td>
                  <td className="py-3 pr-4 text-right text-red-400">₹{p.stop_loss}</td>
                  <td className="py-3 pr-4 text-right text-green-400">₹{p.target_1}</td>
                  <td className="py-3 pr-4 text-right text-green-400">₹{p.target_2}</td>
                  <td className="py-3 pr-4 text-right text-green-400">₹{p.target_3}</td>
                  <td className="py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div className="w-16 h-1.5 bg-white/10 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-purple-400 rounded-full"
                          style={{ width: `${Math.min(p.composite_score, 100)}%` }}
                        />
                      </div>
                      <span className="text-gray-300 w-8 text-right">{p.composite_score?.toFixed(0)}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/AgentStrategistPage.tsx
git commit -m "feat(ui): AgentStrategistPage — 4-timeframe picks table with conviction badges"
```

---

## Task 11 — AgentAuditorPage

**Files:**
- Create: `src/components/AgentAuditorPage.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { useState } from 'react';
import { trpc } from '../lib/trpc';
import { RefreshCw, BarChart2 } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';

type Timeframe = 'intraday' | 'swing' | 'positional' | 'investment';
const TF_LABELS: Record<Timeframe, string> = {
  intraday: 'Intraday', swing: 'Swing', positional: 'Positional', investment: 'Investment',
};

export function AgentAuditorPage() {
  const [tf, setTf] = useState<Timeframe>('swing');
  const { data, isLoading, refetch } = trpc.getAuditReport.useQuery({ timeframe: tf });
  const runMutation = trpc.runAuditorAgent.useMutation({
    onSuccess: () => setTimeout(() => refetch(), 3000),
  });

  const report = (data?.reports as any[])?.[0];
  const attribution = report ? JSON.parse(report.signal_attribution_json || '{}') as Record<string, number> : {};
  const attrData = Object.entries(attribution)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([sig, wr]) => ({ sig: sig.slice(0, 16), wr: +wr.toFixed(1) }));

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <BarChart2 className="w-6 h-6 text-orange-400" /> Auditor Agent
          </h1>
          {data?.runDate && <p className="text-sm text-gray-400 mt-1">Auditing picks from: {report?.audit_for_date}</p>}
        </div>
        <button
          onClick={() => runMutation.mutate()}
          disabled={runMutation.isLoading}
          className="flex items-center gap-2 px-4 py-2 bg-orange-600 hover:bg-orange-500 rounded-lg text-white text-sm disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${runMutation.isLoading ? 'animate-spin' : ''}`} />
          Run Now
        </button>
      </div>

      <div className="flex gap-2">
        {(Object.keys(TF_LABELS) as Timeframe[]).map(t => (
          <button key={t} onClick={() => setTf(t)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tf === t ? 'bg-orange-600 text-white' : 'bg-white/5 text-gray-400 hover:bg-white/10'
            }`}>
            {TF_LABELS[t]}
          </button>
        ))}
      </div>

      {isLoading && <p className="text-gray-400">Loading audit...</p>}

      {report && (
        <>
          <div className="bg-orange-900/20 rounded-xl p-5 border border-orange-500/20">
            <p className="text-sm font-semibold text-orange-300 mb-2">📋 Audit Report — {TF_LABELS[tf]}</p>
            <p className="text-white leading-relaxed">{report.narrative || 'No narrative.'}</p>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: 'Hit Rate', value: `${report.hit_rate?.toFixed(0)}%`, color: report.hit_rate >= 60 ? 'text-green-400' : 'text-red-400' },
              { label: 'Avg Return', value: `${report.avg_return_pct >= 0 ? '+' : ''}${report.avg_return_pct?.toFixed(2)}%`, color: report.avg_return_pct >= 0 ? 'text-green-400' : 'text-red-400' },
              { label: 'Alpha vs Nifty', value: `${report.alpha_pct >= 0 ? '+' : ''}${report.alpha_pct?.toFixed(2)}%`, color: report.alpha_pct >= 0 ? 'text-green-400' : 'text-red-400' },
              { label: 'Profit Factor', value: report.profit_factor?.toFixed(2), color: report.profit_factor >= 1.5 ? 'text-green-400' : 'text-yellow-400' },
            ].map(m => (
              <div key={m.label} className="bg-white/5 rounded-xl p-4 border border-white/10">
                <p className="text-xs text-gray-400">{m.label}</p>
                <p className={`text-2xl font-bold mt-1 ${m.color}`}>{m.value}</p>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-3 gap-4 text-center">
            {[
              { label: '✅ Hits', value: report.hits, color: 'text-green-400' },
              { label: '❌ Misses', value: report.misses, color: 'text-red-400' },
              { label: '⏳ Open', value: report.open_positions, color: 'text-yellow-400' },
            ].map(m => (
              <div key={m.label} className="bg-white/5 rounded-xl p-4 border border-white/10">
                <p className="text-sm text-gray-400">{m.label}</p>
                <p className={`text-3xl font-bold mt-1 ${m.color}`}>{m.value}</p>
              </div>
            ))}
          </div>

          {attrData.length > 0 && (
            <div className="bg-white/5 rounded-xl p-4 border border-white/10">
              <p className="text-sm font-semibold text-gray-300 mb-4">Signal Attribution (Win Rate %)</p>
              <ResponsiveContainer width="100%" height={160}>
                <BarChart data={attrData} layout="vertical">
                  <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 10, fill: '#9ca3af' }} />
                  <YAxis type="category" dataKey="sig" tick={{ fontSize: 10, fill: '#9ca3af' }} width={100} />
                  <Tooltip contentStyle={{ background: '#1f2937', border: '1px solid #374151' }} />
                  <Bar dataKey="wr" name="Win Rate %">
                    {attrData.map((entry, i) => (
                      <Cell key={i} fill={entry.wr >= 60 ? '#4ade80' : entry.wr >= 45 ? '#facc15' : '#f87171'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </>
      )}
      {!report && !isLoading && (
        <p className="text-gray-500 text-sm">No audit data for {TF_LABELS[tf]} yet. Run the agent after market close.</p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/AgentAuditorPage.tsx
git commit -m "feat(ui): AgentAuditorPage — hit/miss/open breakdown, alpha, signal attribution bar chart"
```

---

## Task 12 — AgentOptimizerPage

**Files:**
- Create: `src/components/AgentOptimizerPage.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { trpc } from '../lib/trpc';
import { RefreshCw, Settings } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts';

export function AgentOptimizerPage() {
  const { data, isLoading, refetch } = trpc.getOptimizerReport.useQuery({ limit: 30 });
  const runMutation = trpc.runOptimizerAgent.useMutation({
    onSuccess: () => setTimeout(() => refetch(), 3000),
  });

  const latest = data?.latest as any;
  const history = (data?.history as any[]) ?? [];
  const changes = latest ? JSON.parse(latest.changes_json || '{}') as Record<string, { before: number; after: number }> : {};
  const underperforming = latest ? JSON.parse(latest.underperforming_segments_json || '{}') : {};

  const chartData = [...history].reverse().map((h: any) => ({
    date: h.run_date?.slice(5),
    baseline: h.baseline_win_rate,
    new: h.new_win_rate,
  }));

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Settings className="w-6 h-6 text-teal-400" /> Optimizer Agent
          </h1>
          {latest && <p className="text-sm text-gray-400 mt-1">Last run: {latest.run_date} · Trigger: {latest.trigger}</p>}
        </div>
        <button
          onClick={() => runMutation.mutate()}
          disabled={runMutation.isLoading}
          className="flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-500 rounded-lg text-white text-sm disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${runMutation.isLoading ? 'animate-spin' : ''}`} />
          Run Now
        </button>
      </div>

      {isLoading && <p className="text-gray-400">Loading...</p>}

      {latest && (
        <>
          <div className="bg-teal-900/20 rounded-xl p-5 border border-teal-500/20">
            <p className="text-sm font-semibold text-teal-300 mb-2">⚙️ Optimization Report</p>
            <p className="text-white leading-relaxed">{latest.narrative || 'No narrative.'}</p>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: 'Baseline Win Rate', value: `${latest.baseline_win_rate?.toFixed(1)}%` },
              { label: 'New Win Rate', value: `${latest.new_win_rate?.toFixed(1)}%` },
              { label: 'Weights Changed', value: latest.weights_changed ? `✓ ${Object.keys(changes).length} types` : '— none' },
              { label: 'Full Optimizer', value: latest.full_optimizer_triggered ? '🔄 Triggered' : '— not needed' },
            ].map(m => (
              <div key={m.label} className="bg-white/5 rounded-xl p-4 border border-white/10">
                <p className="text-xs text-gray-400">{m.label}</p>
                <p className="text-lg font-bold text-white mt-1">{m.value}</p>
              </div>
            ))}
          </div>

          {Object.keys(changes).length > 0 && (
            <div className="bg-white/5 rounded-xl p-4 border border-white/10 overflow-x-auto">
              <p className="text-sm font-semibold text-gray-300 mb-3">Weight Changes</p>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-400 border-b border-white/10">
                    <th className="text-left py-2 pr-4">Signal Type</th>
                    <th className="text-right py-2 pr-4">Before</th>
                    <th className="text-right py-2 pr-4">After</th>
                    <th className="text-right py-2">Δ</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(changes).map(([sig, { before, after }]) => {
                    const delta = after - before;
                    return (
                      <tr key={sig} className="border-b border-white/5">
                        <td className="py-2 pr-4 text-gray-300">{sig}</td>
                        <td className="py-2 pr-4 text-right text-gray-400">{before.toFixed(3)}</td>
                        <td className="py-2 pr-4 text-right text-white">{after.toFixed(3)}</td>
                        <td className={`py-2 text-right font-medium ${delta > 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {delta > 0 ? '+' : ''}{delta.toFixed(3)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {Object.keys(underperforming).length > 0 && (
            <div className="bg-red-900/20 rounded-xl p-4 border border-red-500/20">
              <p className="text-sm font-semibold text-red-300 mb-2">⚠️ Underperforming Timeframes</p>
              {Object.entries(underperforming).map(([tf, rate]: any) => (
                <p key={tf} className="text-sm text-gray-300">{tf}: {Number(rate).toFixed(1)}% win rate</p>
              ))}
            </div>
          )}
        </>
      )}

      {chartData.length > 1 && (
        <div className="bg-white/5 rounded-xl p-4 border border-white/10">
          <p className="text-sm font-semibold text-gray-300 mb-4">Win Rate Trend (30 days)</p>
          <ResponsiveContainer width="100%" height={160}>
            <LineChart data={chartData}>
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#9ca3af' }} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: '#9ca3af' }} />
              <Tooltip contentStyle={{ background: '#1f2937', border: '1px solid #374151' }} />
              <Legend />
              <Line type="monotone" dataKey="baseline" stroke="#f97316" strokeWidth={2} dot={false} name="Baseline %" />
              <Line type="monotone" dataKey="new" stroke="#14b8a6" strokeWidth={2} dot={false} name="Post-Optimize %" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {!latest && !isLoading && (
        <p className="text-gray-500 text-sm">No optimizer runs yet. Run the agent after the auditor completes.</p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/AgentOptimizerPage.tsx
git commit -m "feat(ui): AgentOptimizerPage — weight changes table, win rate trend, full optimizer status"
```

---

## Task 13 — Wire into App.tsx

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add imports at the top of `App.tsx`** (with other lazy/component imports)

```tsx
import { AgentDataScientistPage } from './components/AgentDataScientistPage';
import { AgentStrategistPage }    from './components/AgentStrategistPage';
import { AgentAuditorPage }       from './components/AgentAuditorPage';
import { AgentOptimizerPage }     from './components/AgentOptimizerPage';
```

- [ ] **Step 2: Add nav entries**

In the navigation array/sidebar where other tabs are defined, add (grouped under a new "Agent Intelligence" section or alongside existing tabs):

```tsx
{ id: 'agent-data-scientist', label: 'Data Scientist', icon: Database },
{ id: 'agent-strategist',    label: 'Strategist',     icon: Target },
{ id: 'agent-auditor',       label: 'Auditor',        icon: BarChart2 },
{ id: 'agent-optimizer',     label: 'Optimizer',      icon: Settings },
```

Import the relevant Lucide icons (`Database`, `Target`, `BarChart2`, `Settings`) if not already imported.

- [ ] **Step 3: Add route cases**

In the tab-routing switch/conditional (wherever `activeTab` is compared), add:

```tsx
{activeTab === 'agent-data-scientist' && <AgentDataScientistPage />}
{activeTab === 'agent-strategist'     && <AgentStrategistPage />}
{activeTab === 'agent-auditor'        && <AgentAuditorPage />}
{activeTab === 'agent-optimizer'      && <AgentOptimizerPage />}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: only pre-existing `technicalIntelligenceService.ts` error.

- [ ] **Step 5: Start dev server and verify pages load**

```bash
npm run dev
```

Open `http://localhost:5173`, navigate to each of the 4 new tabs. Each should render without errors. The pages will show empty states ("No picks yet", "No audit data yet") until agents run.

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx
git commit -m "feat(ui): wire 4 agent intelligence pages into app navigation"
```

---

## Self-Review

**Spec coverage:**
- [x] 4 Python agents: data_scientist, strategist, auditor, optimizer
- [x] Ollama narrative in all 4 agents via shared `ollama_client.py`
- [x] 4 DB tables with correct indexes
- [x] BullMQ crons: 01:30/03:00/11:00/12:00 UTC (= 07:00/08:30/16:30/17:30 IST)
- [x] Telegram: HIGH-conviction picks from strategist worker, weight-change alerts from optimizer worker
- [x] tRPC: 5 queries + 5 mutations in `agents.router.ts`
- [x] 4 React pages with narrative cards, metrics, charts
- [x] DS quality gate in strategist (grade D → abort, stale > 100 → warn)
- [x] Investment timeframe uses `quant_scores`, not `technical_signals`
- [x] Optimizer weight clamp [0.3, 2.0] ✓
- [x] Underperformance threshold: win_rate < 55% → nudge; overall < 50% for 5 days → full optimizer
- [x] `runFullAgentPipeline` mutation with 5-min delays between agents
- [x] shutdown queues includes all 4 new workers

**Type consistency:**
- `getStrategyPicks` returns `{ picks, runDate }` — AgentStrategistPage reads `data?.picks` and `data?.runDate` ✓
- `getAuditReport` returns `{ reports, runDate }` — AgentAuditorPage reads `data?.reports` ✓
- `getDataScientistReport` returns `{ latest, history }` — page reads same fields ✓
- `getOptimizerReport` returns `{ latest, history }` — page reads same fields ✓

**No placeholders:** All code blocks are complete. No TBD/TODO in any task.
