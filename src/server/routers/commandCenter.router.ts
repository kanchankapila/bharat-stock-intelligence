import { z } from 'zod';
import { dbGet, dbAll } from '../dbAsync';
import { router, publicProcedure } from '../trpc';
import { runPython } from '../pythonRunner';
import { cacheGet } from '../cacheService';

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

      let query = `
        SELECT * FROM unified_recommendations
        WHERE computed_at = (SELECT MAX(computed_at) FROM unified_recommendations)
      `;
      const params: (string | number)[] = [];
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
          intradaySignals = await dbAll<any>(`
            SELECT symbol, signal_type, signal_strength, win_probability,
                   signal_score, rsi, cmp, change_pct, ai_insight,
                   entry_zone, stop_loss, targets, time_horizon
            FROM technical_signals
            WHERE date = ? AND signal_strength = 'HIGH'
            ORDER BY win_probability DESC LIMIT 20
          `, [today]);
        } catch { /* table may differ in schema */ }
      }

      return {
        regime,
        eodPicks,
        intradaySignals,
        lastComputedAt: eodRows[0]?.computed_at ?? null,
        avgEngineTrackRecord: eodRows[0]?.avg_engine_track_record ?? null,
      };
    }),

  runUnifiedRanker: publicProcedure
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
