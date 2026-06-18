import { z } from "zod";
import { dbGet, dbAll } from "../dbAsync";
import { router, publicProcedure } from "../trpc";

export const dlRouter = router({
  getDLPredictions: publicProcedure
    .input(z.object({
      symbols: z.array(z.string()).optional(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }).optional())
    .query(async ({ input }) => {
      const date = input?.date ?? new Date().toISOString().split("T")[0];
      const base = `
        SELECT d.symbol, d.prediction_date, d.model_name, d.model_version,
               d.prob_up_1d, d.prob_up_5d, d.prob_up_15d,
               d.prob_dn_1d, d.prob_dn_5d, d.prob_dn_15d,
               d.exp_ret_1d, d.exp_ret_5d, d.exp_ret_15d,
               d.confidence, d.uncertainty,
               d.regime, d.regime_confidence,
               d.top_features_json, d.attention_json,
               d.created_at
        FROM deep_learning_predictions d
        WHERE d.prediction_date = ?
      `;
      if (input?.symbols?.length) {
        const placeholders = input.symbols.map(() => "?").join(",");
        return (await dbAll<any>(`${base} AND d.symbol IN (${placeholders}) ORDER BY d.confidence DESC`,
          [date, ...input.symbols]))
          .map(r => ({
            ...r,
            topFeatures: r.top_features_json ? JSON.parse(r.top_features_json) : null,
            attention:   r.attention_json    ? JSON.parse(r.attention_json)    : null,
          }));
      }
      return (await dbAll<any>(`${base} ORDER BY d.confidence DESC LIMIT 200`, [date]))
        .map(r => ({
          ...r,
          topFeatures: r.top_features_json ? JSON.parse(r.top_features_json) : null,
          attention:   r.attention_json    ? JSON.parse(r.attention_json)    : null,
        }));
    }),

  getDLModelPerformance: publicProcedure
    .input(z.object({
      model: z.string().optional(),
      days:  z.number().min(7).max(365).default(30),
    }).optional())
    .query(async ({ input }) => {
      const days  = input?.days  ?? 30;
      const model = input?.model ?? "LSTM_TFT_ENSEMBLE";
      const cutoff = new Date(Date.now() - days * 86400000).toISOString().split("T")[0];
      return dbAll(`
        SELECT model_name, model_version, eval_date, horizon_days,
               directional_accuracy, roc_auc, precision_up, recall_up,
               f1_score, sharpe_ratio, profit_factor, sample_count,
               drift_score, retrain_triggered
        FROM dl_model_performance
        WHERE model_name = ? AND eval_date >= ?
        ORDER BY eval_date DESC
      `, [model, cutoff]);
    }),

  getMarketRegime: publicProcedure
    .input(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).optional())
    .query(async ({ input }) => {
      const date = input?.date ?? new Date().toISOString().split("T")[0];
      const row = await dbGet<any>(`
        SELECT date, regime, regime_prob, hmm_state, viterbi_path_json, features_json, computed_at
        FROM market_regimes WHERE date <= ? ORDER BY date DESC LIMIT 1
      `, [date]);
      if (!row) return null;
      return {
        ...row,
        viterbiPath: row.viterbi_path_json ? JSON.parse(row.viterbi_path_json) : null,
        features:    row.features_json     ? JSON.parse(row.features_json)     : null,
      };
    }),

  getDLPredictionHistory: publicProcedure
    .input(z.object({
      symbol:  z.string(),
      horizon: z.union([z.literal(5), z.literal(15)]).default(5),
      days:    z.number().min(7).max(90).default(30),
    }))
    .query(async ({ input }) => {
      const cutoff = new Date(Date.now() - input.days * 86400000).toISOString().split("T")[0];
      const h = input.horizon as 5 | 15;
      return dbAll(`
        SELECT prediction_date,
               prob_up_${h}d AS prob_up,
               exp_ret_${h}d AS exp_ret,
               confidence, uncertainty,
               outcome_${h}d AS outcome, regime,
               actual_ret_${h}d AS actual_ret
        FROM deep_learning_predictions
        WHERE symbol = ? AND prediction_date >= ? AND model_name = 'LSTM_TFT_ENSEMBLE'
        ORDER BY prediction_date DESC
      `, [input.symbol, cutoff]);
    }),
});
