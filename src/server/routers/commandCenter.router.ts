import { z } from 'zod';
import { dbGet, dbAll } from '../dbAsync';
import { router, publicProcedure, adminProcedure } from '../trpc';
import { runPython } from '../pythonRunner';
import { cacheGet } from '../cacheService';

// TTL cache for MAX(computed_at) — refreshes every 5 min so new ranker runs are picked up.
let _urLatestAtCC: string | null = null;
let _urLatestAtExp = 0;
async function urLatestAt(): Promise<string | null> {
  if (!_urLatestAtCC || Date.now() > _urLatestAtExp) {
    const row = await dbGet<{ ts: string }>('SELECT CAST(MAX(computed_at) AS TEXT) AS ts FROM unified_recommendations');
    _urLatestAtCC = row?.ts ?? null;
    _urLatestAtExp = Date.now() + 5 * 60_000;
  }
  return _urLatestAtCC;
}
export function invalidateUrLatestAt() { _urLatestAtCC = null; _urLatestAtExp = 0; }

export const commandCenterRouter = router({

  getCommandCenter: publicProcedure
    .input(z.object({
      conviction: z.enum(['ALL', 'S_ELITE', 'A_HIGH', 'B_MEDIUM', 'C_LOW', 'D_MARGINAL']).default('ALL'),
      horizon:    z.enum(['ALL', 'intraday', 'swing', 'long_term']).default('ALL'),
      limit:      z.number().min(1).max(100).default(30),
    }))
    .query(async ({ input }) => {
      const regimeRow = await dbGet<{ regime: string; regime_prob: number }>(
        'SELECT regime, regime_prob FROM market_regimes ORDER BY date DESC LIMIT 1'
      );
      const regime = {
        name:       regimeRow?.regime ?? 'BULL',
        confidence: regimeRow?.regime_prob ?? 0.5,
        updated_at: new Date().toISOString(),
      };

      const latest = await urLatestAt();
      let query = `
        SELECT symbol, unified_score, conviction_level, timeframe, sector,
               avg_engine_track_record, classification, stop_loss, target_1, target_2,
               entry_zone_low, entry_zone_high, risk_reward, screener_stock_score,
               ml_score, confluence_score, technical_score, dl_score, trade_reasoning,
               engine_coverage_count, computed_at
        FROM unified_recommendations
        WHERE CAST(computed_at AS TEXT) = ?
      `;
      const params: (string | number)[] = [latest ?? ''];
      if (input.conviction !== 'ALL') {
        query += ` AND conviction_level = ?`;
        params.push(input.conviction);
      }
      if (input.horizon !== 'ALL') {
        query += ` AND timeframe = ?`;
        params.push(input.horizon);
      }
      query += ` ORDER BY unified_score DESC LIMIT ?`;
      params.push(input.limit);

      const eodRows = await dbAll<any>(query, params);

      let liveCache: Record<string, any> = {};
      try {
        const cached = await cacheGet('live-stocks-bulk');
        if (cached) liveCache = JSON.parse(cached as string);
      } catch { /* no cache */ }

      const eodPicks = eodRows.map((row) => {
        const live = liveCache[row.symbol];
        const livePrice = live?.price ?? live?.lastPrice ?? null;
        const realizedReturnPct = (livePrice && row.entry_zone_low)
          ? parseFloat(((livePrice - row.entry_zone_low) / row.entry_zone_low * 100).toFixed(2))
          : null;
        return { ...row, livePrice, realizedReturnPct, changePercent: live?.changePercent ?? null };
      });

      let intradaySignals: any[] = [];
      if (regime.name !== 'CRASH') {
        try {
          const today = new Date().toISOString().slice(0, 10);
          // Orders on COALESCE(calibrated_win_probability, win_probability) — was raw
          // unconditionally (2026-07-18 gating follow-up).
          // signal_strength was never a real technical_signals column (this always threw and
          // was silently swallowed by the catch below, so intradaySignals was always []) --
          // signal_score (real, 0-10 composite) is this codebase's actual strength measure;
          // >=7 matches the "HIGH" tier threshold used elsewhere. Found via CI smoke test.
          intradaySignals = await dbAll<any>(`
            SELECT symbol, signal_type, win_probability,
                   signal_score, rsi, cmp, change_pct, ai_insight,
                   entry_zone, stop_loss, targets, time_horizon
            FROM technical_signals
            WHERE date = ? AND signal_score >= 7
            ORDER BY COALESCE(calibrated_win_probability, win_probability) DESC LIMIT 20
          `, [today]);
        } catch (e) { console.error(e); /* table may differ in schema */ }
      }

      return {
        regime,
        eodPicks,
        intradaySignals,
        lastComputedAt: eodRows[0]?.computed_at ?? null,
        avgEngineTrackRecord: eodRows[0]?.avg_engine_track_record ?? null,
      };
    }),

  getBuyRecommendations: publicProcedure
    .input(z.object({
      conviction: z.enum(['ALL', 'S_ELITE', 'A_HIGH', 'B_MEDIUM']).default('ALL'),
      horizon:    z.enum(['ALL', 'intraday', 'swing', 'long_term']).default('ALL'),
      sector:     z.string().optional(),
      limit:      z.number().min(1).max(200).default(60),
    }))
    .query(async ({ input }) => {
      const regimeRow = await dbGet<{ regime: string; regime_prob: number }>(
        'SELECT regime, regime_prob FROM market_regimes ORDER BY date DESC LIMIT 1'
      );
      const regime = regimeRow?.regime ?? 'BULL';

      const latest = await urLatestAt();
      const params: (string | number)[] = [latest ?? ''];
      let convFilter = '';
      if (input.conviction !== 'ALL') {
        convFilter = ` AND ur.conviction_level = ?`;
        params.push(input.conviction);
      } else {
        // default: exclude D_MARGINAL
        convFilter = ` AND ur.conviction_level != 'D_MARGINAL'`;
      }
      let horizonFilter = '';
      if (input.horizon !== 'ALL') {
        horizonFilter = ` AND ur.timeframe = ?`;
        params.push(input.horizon);
      }
      let sectorFilter = '';
      if (input.sector) {
        sectorFilter = ` AND ur.sector = ?`;
        params.push(input.sector);
      }
      params.push(input.limit);

      const rows = await dbAll<any>(`
        SELECT
          ur.symbol, ur.unified_score, ur.conviction_level, ur.timeframe, ur.sector,
          ur.classification, ur.stop_loss, ur.target_1, ur.target_2,
          ur.entry_zone_low, ur.entry_zone_high, ur.risk_reward,
          ur.ml_score, ur.confluence_score, ur.technical_score, ur.dl_score,
          ur.trade_reasoning, ur.engine_coverage_count, ur.computed_at,
          -- technical_signals feature columns (signal_strength removed -- not a real column,
          -- always threw and 500'd this endpoint; found via CI smoke test)
          ts.win_probability, ts.signal_type,
          ts.rsi, ts.cmp, ts.change_pct,
          ts.rs_vs_sector_21d, ts.rs_vs_sector_63d,
          ts.eps_surprise_q1, ts.eps_surprise_q2, ts.eps_beat_streak,
          ts.eps_miss_after_streak, ts.rev_surprise_q1,
          ts.fcf_yield_approx AS fcf_yield, ts.interest_coverage, ts.fcf_positive, ts.debt_coverage_risk,
          ts.delivery_trend_30d, ts.block_deal_flag, ts.block_deal_direction,
          ts.short_interest_proxy,
          ts.promoter_buy_90d_cr, ts.promoter_sell_90d_cr, ts.promoter_net_90d,
          ts.insider_buy_flag, ts.insider_sell_flag,
          ts.rating_upgrade_180d, ts.rating_downgrade_180d,
          ts.mf_sector_flow_pct,
          ts.ccc_trend, ts.wc_deteriorating, ts.wc_improving,
          ts.expected_move_pct, ts.stock_gex_proxy,
          ts.iep_gap_pct, ts.preopen_imbalance,
          ts.pledge_chg_90d, ts.asm_flag, ts.gsm_stage,
          ts.mc_broker_buy_7d, ts.mc_broker_sell_7d, ts.mc_broker_upside,
          ts.is_nifty50, ts.nifty_tier,
          ts.hv_20d, ts.iv_hv_ratio,
          ts.days_to_next_results
        FROM unified_recommendations ur
        LEFT JOIN (
          SELECT * FROM technical_signals
          WHERE date = (SELECT MAX(date) FROM technical_signals)
        ) ts ON ts.symbol = ur.symbol
        WHERE ur.computed_at = ?
        ${convFilter}${horizonFilter}${sectorFilter}
        ORDER BY ur.unified_score DESC
        LIMIT ?
      `, params);

      let liveCache: Record<string, any> = {};
      try {
        const cached = await cacheGet('live-stocks-bulk');
        if (cached) liveCache = JSON.parse(cached as string);
      } catch { /* no cache */ }

      const picks = rows.map((r) => {
        const live = liveCache[r.symbol];
        return {
          ...r,
          livePrice:    live?.price ?? live?.lastPrice ?? r.cmp ?? null,
          changePercent: live?.changePercent ?? r.change_pct ?? null,
        };
      });

      // distinct sectors for filter dropdown
      const sectorSet = [...new Set(picks.map((p: any) => p.sector).filter(Boolean))].sort();

      return { picks, regime, sectorList: sectorSet, lastComputedAt: rows[0]?.computed_at ?? null };
    }),

  runUnifiedRanker: adminProcedure
    .mutation(async () => {
      try {
        const { stdout } = await runPython('unified_ranker.py', [], 5 * 60_000);
        const parsed = JSON.parse(stdout.trim().split('\n').pop() || '{}');
        return {
          success: true,
          stocks_scored:        parsed.stocks_scored ?? 0,
          conviction_breakdown: parsed.conviction_breakdown ?? {},
          regime:               parsed.regime ?? 'UNKNOWN',
          duration_ms:          0,
        };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }),
});
