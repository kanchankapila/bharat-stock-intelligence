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
