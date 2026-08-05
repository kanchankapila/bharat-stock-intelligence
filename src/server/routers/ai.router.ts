
import { z } from 'zod';
import { dbGet, dbAll } from '../dbAsync';
import { router, publicProcedure } from '../trpc';

export const aiRouter = router({
  getAiInsights: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const { symbol } = input;

      const agentPicks = await dbAll<any>(`
        SELECT * FROM agent_strategy_picks
        WHERE symbol = ?
        ORDER BY run_date DESC
        LIMIT 5
      `, [symbol]);

      const dlPredictions = await dbAll<any>(`
        SELECT * FROM deep_learning_predictions
        WHERE symbol = ?
        ORDER BY prediction_date DESC
        LIMIT 5
      `, [symbol]);

      const confluenceSignals = await dbAll<any>(`
        SELECT * FROM confluence_signals
        WHERE symbol = ?
        ORDER BY computed_at DESC
        LIMIT 5
      `, [symbol]);

      return {
        agentPicks,
        dlPredictions,
        confluenceSignals,
      };
    }),
});
