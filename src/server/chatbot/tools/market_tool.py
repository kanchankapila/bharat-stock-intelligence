"""
Market-level tools for the chatbot — covering live DB tables:
  market_regimes, market_sentiment_snapshots, macro_asset_prices,
  confluence_signals, technical_signals, unified_recommendations,
  quant_scores, fii_dii_flow, signal_outcomes, strategy_performance
"""
import json
import os
import sqlite3
from datetime import datetime, timedelta

DB_PATH = os.getenv("DB_PATH", "database.sqlite")

# Maps user-typed sector names to patterns that work across both DB sector schemas.
# Tuple: (confluence_pattern, news_pattern) — both used with LIKE '%...%'
_SECTOR_ALIASES: dict[str, tuple[str, str]] = {
    "it":         ("Information Technology", "IT"),
    "tech":       ("Information Technology", "IT"),
    "banking":    ("Financials", "Banking"),
    "finance":    ("Financials", "Banking"),
    "financial":  ("Financials", "Banking"),
    "pharma":     ("Healthcare", "Pharmaceutical"),
    "health":     ("Healthcare", "Pharmaceutical"),
    "fmcg":       ("Consumer Staples", "FMCG"),
    "auto":       ("Consumer Discretionary", "Automobiles"),
    "automobile": ("Consumer Discretionary", "Automobiles"),
    "realty":     ("Real Estate", "Realty"),
    "metal":      ("Materials", "Metals"),
    "energy":     ("Energy", "Oil"),
    "oil":        ("Energy", "Oil"),
    "power":      ("Utilities", "Power"),
    "infra":      ("Industrials", "Infrastructure"),
    "media":      ("Communication Services", "Media"),
}


def _sector_patterns(sector: str) -> tuple[str, str]:
    """Return (confluence_pattern, news_pattern) for a sector query."""
    key = sector.lower().strip()
    if key in _SECTOR_ALIASES:
        return _SECTOR_ALIASES[key]
    # Default: use the same string for both
    return (sector, sector)


def _connect(db_path: str):
    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row
    return db


# ─── Market Pulse ─────────────────────────────────────────────────────────────

def get_market_pulse(db_path: str = DB_PATH) -> dict:
    """
    Current market regime, sentiment score, and macro asset moves.
    Sources: market_regimes, market_sentiment_snapshots, macro_asset_prices
    Data freshness: updated every 30-60 min during market hours.
    """
    db = _connect(db_path)
    result: dict = {}

    try:
        row = db.execute(
            "SELECT regime, regime_prob, date, features_json "
            "FROM market_regimes ORDER BY date DESC LIMIT 1"
        ).fetchone()
        if row:
            features = {}
            try:
                features = json.loads(row["features_json"] or "{}")
            except Exception:
                pass
            result["regime"] = {
                "current": row["regime"],
                "probability": round(row["regime_prob"], 3) if row["regime_prob"] else None,
                "date": row["date"],
                "fii_5d_net_norm": features.get("fii_5d_net_norm"),
                "advance_decline": features.get("advance_decline"),
                "nifty_5d_return": features.get("nifty_5d_return"),
                "vix": features.get("vix"),
            }
    except Exception:
        pass

    try:
        row = db.execute(
            "SELECT overall_score, overall_label, bullish_count, bearish_count, "
            "neutral_count, nifty_bias, global_cue, global_score, key_themes_json, snapshot_at "
            "FROM market_sentiment_snapshots ORDER BY snapshot_at DESC LIMIT 1"
        ).fetchone()
        if row:
            themes = []
            try:
                themes = json.loads(row["key_themes_json"] or "[]")
            except Exception:
                pass
            result["sentiment"] = {
                "score": row["overall_score"],
                "label": row["overall_label"],
                "bullish_count": row["bullish_count"],
                "bearish_count": row["bearish_count"],
                "neutral_count": row["neutral_count"],
                "nifty_bias": row["nifty_bias"],
                "global_cue": row["global_cue"],
                "global_score": row["global_score"],
                "key_themes": themes[:5],
                "as_of": row["snapshot_at"],
            }
    except Exception:
        pass

    try:
        row = db.execute(
            "SELECT * FROM macro_asset_prices ORDER BY date DESC LIMIT 1"
        ).fetchone()
        if row:
            result["macro"] = dict(row)
    except Exception:
        pass

    db.close()
    return result


# ─── Confluence / Screener Conviction ─────────────────────────────────────────

def get_top_confluence_stocks(
    min_confluence: float = 65.0,
    conviction: str | None = None,
    sector: str | None = None,
    limit: int = 20,
    db_path: str = DB_PATH,
) -> list[dict]:
    """
    Top stocks ranked by screener confluence score with full signal context.
    Source: confluence_signals (updated every 30 min), nse_stocks.
    Includes: entry/target/SL zones, AI conclusion, RSI, trade reasoning, screener names.
    """
    db = _connect(db_path)
    rows = []

    try:
        where = ["cs.confluence_score >= ?"]
        params: list = [min_confluence]

        if conviction:
            where.append("cs.conviction_level = ?")
            params.append(conviction.upper())

        if sector:
            conf_pat, _ = _sector_patterns(sector)
            where.append("(cs.sector LIKE ? OR ns.sector LIKE ?)")
            params += [f"%{conf_pat}%", f"%{conf_pat}%"]

        params.append(limit)

        sql = f"""
            SELECT
                cs.symbol,
                COALESCE(ns.name, cs.symbol) AS name,
                COALESCE(cs.sector, ns.sector) AS sector,
                ns.industry,
                cs.confluence_score,
                cs.conviction_level,
                cs.active_screener_count,
                cs.bullish_screener_count,
                cs.bearish_screener_count,
                cs.screener_names_json,
                cs.trend_alignment_score,
                cs.sector_strength_score,
                cs.fundamental_score,
                cs.rsi,
                cs.suggested_timeframe,
                cs.entry_zone_low,
                cs.entry_zone_high,
                cs.stop_loss,
                cs.target_1,
                cs.target_2,
                cs.risk_reward,
                cs.ai_conclusion,
                cs.trade_reasoning,
                cs.computed_at
            FROM confluence_signals cs
            JOIN (
                SELECT symbol, MAX(computed_at) AS max_at
                FROM confluence_signals
                GROUP BY symbol
            ) latest ON cs.symbol = latest.symbol AND cs.computed_at = latest.max_at
            LEFT JOIN nse_stocks ns ON cs.symbol = ns.symbol
            WHERE {' AND '.join(where)}
            ORDER BY cs.confluence_score DESC
            LIMIT ?
        """

        for row in db.execute(sql, params).fetchall():
            d = dict(row)
            try:
                d["screener_names"] = json.loads(d.pop("screener_names_json") or "[]")[:8]
            except Exception:
                d["screener_names"] = []
            rows.append(d)
    except Exception:
        pass

    db.close()
    return rows


# ─── Stock Signals (live tables) ──────────────────────────────────────────────

def get_stock_signals(symbol: str, days: int = 7, db_path: str = DB_PATH) -> dict:
    """
    All recent signals for a symbol from live tables:
      unified_signals (today's cross-source signals),
      technical_signals (RSI, MACD, SMA status),
      confluence_signals (screener conviction score).
    Falls back to the legacy 'signals' table if unified_signals has no rows.
    """
    db = _connect(db_path)
    sym = symbol.upper()
    cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
    result: dict = {"symbol": sym}

    # unified_signals (primary — live)
    try:
        rows = db.execute(
            "SELECT signal_date, signal_source, signal_type, entry_price, "
            "target_price, stop_loss, confidence_score, reasoning "
            "FROM unified_signals "
            "WHERE symbol = ? AND signal_date >= ? "
            "ORDER BY signal_date DESC LIMIT 10",
            (sym, cutoff),
        ).fetchall()
        result["unified_signals"] = [dict(r) for r in rows]
    except Exception:
        result["unified_signals"] = []

    # fall back to legacy signals table if unified has nothing
    if not result["unified_signals"]:
        try:
            rows = db.execute(
                "SELECT createdAt AS signal_date, 'AI' AS signal_source, type AS signal_type, "
                "entry AS entry_price, target AS target_price, stopLoss AS stop_loss, "
                "confidence AS confidence_score, reasoning "
                "FROM signals "
                "WHERE symbol = ? AND status = 'ACTIVE' "
                "ORDER BY createdAt DESC LIMIT 5",
                (sym,),
            ).fetchall()
            result["unified_signals"] = [dict(r) for r in rows]
        except Exception:
            pass

    # technical_signals (RSI, MACD, SMA)
    try:
        rows = db.execute(
            "SELECT date, signal_score, rsi, sma50, sma200, macd, macd_signal, bb_width, signals_json "
            "FROM technical_signals WHERE symbol = ? ORDER BY date DESC LIMIT 5",
            (sym,),
        ).fetchall()
        technical = []
        for r in rows:
            d = dict(r)
            try:
                d["signals"] = json.loads(d.pop("signals_json") or "[]")
            except Exception:
                d.pop("signals_json", None)
            technical.append(d)
        result["technical_signals"] = technical
    except Exception:
        result["technical_signals"] = []

    # confluence score + AI conclusion + entry/target/SL
    try:
        row = db.execute(
            "SELECT confluence_score, conviction_level, active_screener_count, "
            "bullish_screener_count, bearish_screener_count, "
            "screener_names_json, rsi, trend_alignment_score, "
            "entry_zone_low, entry_zone_high, stop_loss, target_1, target_2, target_3, "
            "risk_reward, ai_conclusion, trade_reasoning, suggested_timeframe, computed_at "
            "FROM confluence_signals WHERE symbol = ? ORDER BY computed_at DESC LIMIT 1",
            (sym,),
        ).fetchone()
        if row:
            d = dict(row)
            try:
                d["screener_names"] = json.loads(d.pop("screener_names_json") or "[]")[:8]
            except Exception:
                d.pop("screener_names_json", None)
            result["confluence"] = d
    except Exception:
        pass

    db.close()
    return result


# ─── FII / DII Flows ──────────────────────────────────────────────────────────

def get_fii_dii_sentiment(days: int = 20, db_path: str = DB_PATH) -> dict:
    """
    FII/DII net flows from the DB. Includes a staleness flag.
    Source: fii_dii_flow table.
    Note: data may lag up to 1 week; for fresh data run fii_dii_fetcher.py.
    """
    db = _connect(db_path)
    result: dict = {}

    try:
        rows = db.execute(
            "SELECT date, fii_buy, fii_sell, fii_net, dii_buy, dii_sell, dii_net "
            "FROM fii_dii_flow "
            "WHERE fii_net IS NOT NULL "
            "ORDER BY date DESC LIMIT ?",
            (days,),
        ).fetchall()

        if rows:
            data = [dict(r) for r in rows]
            latest_date = data[0]["date"]
            days_stale = (datetime.now().date() - datetime.fromisoformat(latest_date).date()).days

            fii_nets = [r["fii_net"] for r in data if r["fii_net"] is not None]
            dii_nets = [r["dii_net"] for r in data if r["dii_net"] is not None]

            result = {
                "flows": data[:10],
                "latest_date": latest_date,
                "days_stale": days_stale,
                "stale_warning": days_stale > 5,
                "fii_5d_net": round(sum(fii_nets[:5]), 2) if fii_nets else None,
                "dii_5d_net": round(sum(dii_nets[:5]), 2) if dii_nets else None,
                "fii_trend": (
                    "Accumulation" if fii_nets and sum(fii_nets[:5]) > 0 else "Distribution"
                ) if fii_nets else "Unknown",
                "dii_trend": (
                    "Accumulation" if dii_nets and sum(dii_nets[:5]) > 0 else "Distribution"
                ) if dii_nets else "Unknown",
            }
        else:
            result = {"error": "No FII/DII data in DB", "flows": []}
    except Exception as e:
        result = {"error": str(e), "flows": []}

    db.close()
    return result


# ─── Sector Momentum ──────────────────────────────────────────────────────────

def get_sector_momentum(sector: str | None = None, limit: int = 12, db_path: str = DB_PATH) -> dict:
    """
    Sector analysis from three sources:
    1. confluence_signals — top stocks per sector with conviction scores
    2. news_sentiment_items — sector news sentiment (well-labelled sector column)
    3. quant_scores — avg momentum scores per sector (filtered to known sectors)
    If sector is given, returns a focused view for that sector.
    """
    db = _connect(db_path)
    result: dict = {}

    # ── Sector news sentiment ─────────────────────────────────────────────────
    try:
        cutoff = (datetime.now() - timedelta(days=14)).strftime("%Y-%m-%d")
        if sector:
            _, news_pat = _sector_patterns(sector)
            rows = db.execute(
                "SELECT sentiment, sentiment_score, COUNT(*) cnt "
                "FROM news_sentiment_items "
                "WHERE sector LIKE ? AND published_at >= ? "
                "GROUP BY sentiment",
                (f"%{news_pat}%", cutoff),
            ).fetchall()
        else:
            rows = db.execute(
                "SELECT sector, "
                "COUNT(*) AS total_news, "
                "ROUND(AVG(sentiment_score), 3) AS avg_sentiment, "
                "SUM(CASE WHEN sentiment='BULLISH' THEN 1 ELSE 0 END) AS bullish, "
                "SUM(CASE WHEN sentiment='BEARISH' THEN 1 ELSE 0 END) AS bearish "
                "FROM news_sentiment_items "
                "WHERE published_at >= ? AND sector != '' AND sector IS NOT NULL "
                "GROUP BY sector HAVING total_news >= 3 "
                "ORDER BY avg_sentiment DESC LIMIT ?",
                (cutoff, limit),
            ).fetchall()
        result["sector_news_sentiment"] = [dict(r) for r in rows]
    except Exception:
        pass

    # ── Top stocks by confluence within sector ────────────────────────────────
    try:
        if sector:
            conf_pat, _ = _sector_patterns(sector)
            rows = db.execute(
                """SELECT cs.symbol, COALESCE(ns.name, cs.symbol) AS name,
                    cs.confluence_score, cs.conviction_level,
                    cs.active_screener_count, cs.rsi, cs.ai_conclusion,
                    cs.entry_zone_low, cs.target_1, cs.stop_loss,
                    cs.trade_reasoning
                FROM confluence_signals cs
                JOIN (SELECT symbol, MAX(computed_at) AS max_at FROM confluence_signals GROUP BY symbol) m
                    ON cs.symbol = m.symbol AND cs.computed_at = m.max_at
                LEFT JOIN nse_stocks ns ON cs.symbol = ns.symbol
                WHERE (cs.sector LIKE ? OR ns.sector LIKE ?)
                ORDER BY cs.confluence_score DESC LIMIT ?""",
                (f"%{conf_pat}%", f"%{conf_pat}%", limit),
            ).fetchall()
            result["top_stocks"] = [dict(r) for r in rows]
    except Exception:
        pass

    # ── Quant momentum by sector (known sectors only) ─────────────────────────
    try:
        rows = db.execute(
            """SELECT ns.sector,
                COUNT(*) AS stock_count,
                ROUND(AVG(qs.return_1m), 2) AS avg_return_1m,
                ROUND(AVG(qs.return_3m), 2) AS avg_return_3m,
                ROUND(AVG(qs.momentum_score), 1) AS avg_momentum_score,
                SUM(CASE WHEN qs.above_sma200=1 THEN 1 ELSE 0 END) AS above_sma200_count
            FROM quant_scores qs
            JOIN nse_stocks ns ON qs.symbol = ns.symbol
            WHERE ns.sector != 'Unknown' AND ns.sector != '' AND ns.sector IS NOT NULL
            GROUP BY ns.sector HAVING stock_count >= 2
            ORDER BY avg_momentum_score DESC LIMIT ?""",
            (limit,),
        ).fetchall()
        if rows:
            result["quant_momentum_by_sector"] = [dict(r) for r in rows]
    except Exception:
        pass

    db.close()
    return result


# ─── Signal Accuracy ──────────────────────────────────────────────────────────

def get_signal_accuracy(db_path: str = DB_PATH) -> dict:
    """
    Overall signal win rates and breakdowns by signal type and regime.
    Sources: signal_outcomes, strategy_performance, signal_type_weights.
    """
    db = _connect(db_path)
    result: dict = {}

    # Overall outcome distribution
    try:
        rows = db.execute(
            "SELECT outcome, COUNT(*) AS cnt FROM signal_outcomes "
            "GROUP BY outcome"
        ).fetchall()
        total = sum(r["cnt"] for r in rows)
        result["overall"] = {
            r["outcome"]: {"count": r["cnt"], "pct": round(r["cnt"] / total * 100, 1)}
            for r in rows
        }
        result["total_resolved"] = total
    except Exception:
        pass

    # By signal type (top performers)
    try:
        rows = db.execute(
            "SELECT strategy_name, segment_value, market_regime, "
            "win_rate, avg_return_pct, total_signals, profit_factor, sharpe_ratio "
            "FROM strategy_performance "
            "WHERE total_signals >= 10 "
            "ORDER BY win_rate DESC, profit_factor DESC LIMIT 15"
        ).fetchall()
        result["top_strategies"] = [dict(r) for r in rows]
    except Exception:
        pass

    # By market regime
    try:
        rows = db.execute(
            "SELECT market_regime, "
            "ROUND(AVG(win_rate), 3) AS avg_win_rate, "
            "ROUND(AVG(avg_return_pct), 3) AS avg_return_pct, "
            "SUM(total_signals) AS total_samples "
            "FROM strategy_performance "
            "WHERE market_regime IS NOT NULL AND market_regime != 'UNKNOWN' "
            "AND total_signals >= 5 "
            "GROUP BY market_regime ORDER BY avg_win_rate DESC"
        ).fetchall()
        result["by_regime"] = [dict(r) for r in rows]
    except Exception:
        pass

    # Latest ML model AUC
    try:
        row = db.execute(
            "SELECT model_name, auc, accuracy, created_at "
            "FROM model_registry WHERE is_active = 1 "
            "ORDER BY created_at DESC LIMIT 1"
        ).fetchone()
        if row:
            result["active_model"] = dict(row)
    except Exception:
        pass

    db.close()
    return result


# ─── News Sentiment (live table) ──────────────────────────────────────────────

def get_live_news_sentiment(
    symbol: str | None = None,
    sector: str | None = None,
    category: str | None = None,
    days: int = 7,
    limit: int = 15,
    db_path: str = DB_PATH,
) -> dict:
    """
    News from news_sentiment_items — FinBERT-scored, updated every ~30 min.
    Much fresher and richer than the legacy news_articles table.
    Supports filtering by stock symbol, sector, or category (EARNINGS/POLICY/SECTOR/GLOBAL/IPO).
    """
    db = _connect(db_path)
    cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")

    where = ["published_at >= ?"]
    params: list = [cutoff]

    if symbol:
        sym = symbol.upper()
        where.append("(symbols_json LIKE ? OR symbols_json LIKE ? OR symbols_json LIKE ? OR symbols_json LIKE ?)")
        params += [f'["{sym}"', f'"{sym}",', f', "{sym}"', f'"{sym}"]']

    if sector:
        where.append("sector LIKE ?")
        params.append(f"%{sector}%")

    if category:
        where.append("category = ?")
        params.append(category.upper())

    params.append(limit)

    try:
        rows = db.execute(
            f"SELECT title, summary, source, published_at, sentiment, sentiment_score, "
            f"impact, category, sector, url "
            f"FROM news_sentiment_items "
            f"WHERE {' AND '.join(where)} "
            f"ORDER BY published_at DESC LIMIT ?",
            params,
        ).fetchall()

        articles = [dict(r) for r in rows]
        total = len(articles)
        pos = sum(1 for a in articles if a.get("sentiment") == "BULLISH")
        neg = sum(1 for a in articles if a.get("sentiment") == "BEARISH")
        neu = total - pos - neg

        avg_score = (
            sum(a["sentiment_score"] for a in articles if a.get("sentiment_score") is not None) / total
            if total > 0 else 0
        )

        overall = (
            "Bullish" if avg_score > 0.1 else
            "Bearish" if avg_score < -0.1 else
            "Neutral"
        )

        high_impact = [a for a in articles if a.get("impact") == "HIGH"]

        db.close()
        return {
            "symbol": symbol,
            "total": total,
            "bullish": pos,
            "bearish": neg,
            "neutral": neu,
            "avg_sentiment_score": round(avg_score, 3),
            "overall_sentiment": overall,
            "high_impact_count": len(high_impact),
            "headlines": articles[:10],
            "high_impact": high_impact[:5],
        }
    except Exception as e:
        db.close()
        return {"symbol": symbol, "total": 0, "error": str(e), "headlines": []}


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
