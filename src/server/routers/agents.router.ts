import { z } from 'zod';
import { dbGet, dbAll, dbRun } from '../dbAsync';
import { router, publicProcedure, adminProcedure } from '../trpc';

// AF-20260828-26: the direct-runPython fallback path (used only when the matching BullMQ
// queue isn't configured) used to be pure fire-and-forget (`.catch(console.error)`) -- a
// failure only ever reached the server console, with no way for the UI to learn about it.
// Mirrors monitor.router.ts's triggerScript `${stateKey}_error` persistence pattern (same
// app_settings key shape, `agent_<id>_error`/`_error_at` instead of `monitor_<id>_error`) so
// a failed direct run is readable back the same way a failed monitor script is.
async function trackDirectAgentRun(agentId: string, run: Promise<unknown>): Promise<void> {
  const key = `agent_${agentId}_error`;
  try {
    await run;
    // Both keys, not just the error: deleting `_error` alone would strand `_error_at`
    // forever, and getAgentTriggerErrors would then keep returning a phantom
    // { error: '', at: <old timestamp> } entry for an agent that has since succeeded.
    await dbRun('DELETE FROM app_settings WHERE key IN (?, ?)', [key, `${key}_at`]);
  } catch (err: unknown) {
    const msg = (err as Error).message ?? String(err);
    console.error(`[AGENT] ${agentId} direct run failed:`, msg);
    try {
      await dbRun(
        'INSERT INTO app_settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        [key, msg.slice(0, 500)]
      );
      await dbRun(
        'INSERT INTO app_settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        [`${key}_at`, new Date().toISOString()]
      );
    } catch (persistErr: unknown) {
      console.warn('[AGENT] failed to persist trigger error:', (persistErr as Error).message);
    }
  }
}

export const agentsRouter = router({

  // ── Queries ──────────────────────────────────────────────────────────────

  getDataScientistReport: publicProcedure
    .input(z.object({ limit: z.number().min(1).max(90).default(30) }))
    .query(async ({ input }) => {
      const latest = await dbGet(
        'SELECT * FROM agent_data_scientist_reports ORDER BY created_at DESC LIMIT 1'
      );
      const history = await dbAll(
        'SELECT run_date, data_quality_score, quality_grade, model_auc, ' +
        'ohlcv_coverage_pct, stale_symbols_count, signal_resolution_rate ' +
        'FROM agent_data_scientist_reports ORDER BY run_date DESC LIMIT ?',
        [input.limit]
      );
      return { latest, history };
    }),

  getAgentStrategyPicks: publicProcedure
    .input(z.object({
      date:      z.string().optional(),
      timeframe: z.enum(['intraday', 'swing', 'positional', 'investment']).optional(),
    }))
    .query(async ({ input }) => {
      const runDate = input.date ?? (await dbGet<any>(
        'SELECT MAX(run_date) AS d FROM agent_strategy_picks'
      ))?.d;
      if (!runDate) return { picks: [], runDate: null };

      let sql = 'SELECT * FROM agent_strategy_picks WHERE run_date = ?';
      const params: any[] = [runDate];
      if (input.timeframe) { sql += ' AND timeframe = ?'; params.push(input.timeframe); }
      sql += ' ORDER BY timeframe, rank';

      return { picks: await dbAll(sql, params), runDate };
    }),

  getAuditReport: publicProcedure
    .input(z.object({
      date:      z.string().optional(),
      timeframe: z.enum(['intraday', 'swing', 'positional', 'investment']).optional(),
    }))
    .query(async ({ input }) => {
      const runDate = input.date ?? (await dbGet<any>(
        'SELECT MAX(run_date) AS d FROM agent_audit_reports'
      ))?.d;
      if (!runDate) return { reports: [], runDate: null };

      let sql = 'SELECT * FROM agent_audit_reports WHERE run_date = ?';
      const params: any[] = [runDate];
      if (input.timeframe) { sql += ' AND timeframe = ?'; params.push(input.timeframe); }

      return { reports: await dbAll(sql, params), runDate };
    }),

  getOptimizerReport: publicProcedure
    .input(z.object({ limit: z.number().min(1).max(90).default(30) }))
    .query(async ({ input }) => {
      const latest = await dbGet(
        'SELECT * FROM agent_optimizer_reports ORDER BY created_at DESC LIMIT 1'
      );
      const history = await dbAll(
        'SELECT run_date, baseline_win_rate, new_win_rate, improvement_pct, ' +
        'weights_changed, full_optimizer_triggered ' +
        'FROM agent_optimizer_reports ORDER BY run_date DESC LIMIT ?',
        [input.limit]
      );
      return { latest, history };
    }),

  getAgentStatus: publicProcedure.query(async () => {
    const ds = await dbGet<any>(
      'SELECT run_date, quality_grade FROM agent_data_scientist_reports ORDER BY created_at DESC LIMIT 1'
    );
    const strat = await dbGet<any>(
      'SELECT run_date, COUNT(*) AS pick_count FROM agent_strategy_picks WHERE run_date = (SELECT MAX(run_date) FROM agent_strategy_picks) GROUP BY run_date'
    );
    const audit = await dbGet<any>(
      'SELECT run_date, AVG(hit_rate) AS avg_hit_rate FROM agent_audit_reports WHERE run_date = (SELECT MAX(run_date) FROM agent_audit_reports) GROUP BY run_date'
    );
    const optim = await dbGet<any>(
      'SELECT run_date, weights_changed FROM agent_optimizer_reports ORDER BY created_at DESC LIMIT 1'
    );
    return { ds, strat, audit, optim };
  }),

  // AF-20260828-26: readable-back counterpart to trackDirectAgentRun above -- only ever
  // populated when an agent ran via the direct-runPython fallback (queue unconfigured) AND
  // failed; empty in the normal BullMQ-queued path, which has its own job-level failure
  // visibility already.
  getAgentTriggerErrors: publicProcedure.query(async () => {
    const rows = await dbAll<{ key: string; value: string }>(
      "SELECT key, value FROM app_settings WHERE key LIKE 'agent\\_%\\_error%' ESCAPE '\\'"
    );
    const byAgent: Record<string, { error: string; at: string | null }> = {};
    for (const row of rows) {
      const m = row.key.match(/^agent_(.+?)_error(_at)?$/);
      if (!m) continue;
      const [, agentId, isAt] = m;
      byAgent[agentId] ??= { error: '', at: null };
      if (isAt) byAgent[agentId].at = row.value;
      else byAgent[agentId].error = row.value;
    }
    // Drop any entry with no actual error text -- defensive against a stranded `_error_at`
    // row written before the delete-both fix above, which would otherwise render as an
    // agent "failure" carrying an empty message.
    for (const [agentId, v] of Object.entries(byAgent)) {
      if (!v.error) delete byAgent[agentId];
    }
    return byAgent;
  }),

  // ── Mutations ─────────────────────────────────────────────────────────────

  runDataScientistAgent: adminProcedure.mutation(async () => {
    const { agentDataScientistQueue } = await import('../queues');
    if (agentDataScientistQueue) {
      await agentDataScientistQueue.add('manual-ds', {}, { removeOnComplete: 1 });
      return { queued: true };
    }
    const { runPython } = await import('../pythonRunner');
    void trackDirectAgentRun('data_scientist', runPython('agents/data_scientist_agent.py', [], 10 * 60_000));
    return { queued: false, running: true };
  }),

  runStrategistAgent: adminProcedure.mutation(async () => {
    const { agentStrategistQueue } = await import('../queues');
    if (agentStrategistQueue) {
      await agentStrategistQueue.add('manual-strat', {}, { removeOnComplete: 1 });
      return { queued: true };
    }
    const { runPython } = await import('../pythonRunner');
    void trackDirectAgentRun('strategist', runPython('agents/strategist_agent.py', [], 15 * 60_000));
    return { queued: false, running: true };
  }),

  runAuditorAgent: adminProcedure.mutation(async () => {
    const { agentAuditorQueue } = await import('../queues');
    if (agentAuditorQueue) {
      await agentAuditorQueue.add('manual-audit', {}, { removeOnComplete: 1 });
      return { queued: true };
    }
    const { runPython } = await import('../pythonRunner');
    void trackDirectAgentRun('auditor', runPython('agents/auditor_agent.py', [], 15 * 60_000));
    return { queued: false, running: true };
  }),

  runOptimizerAgent: adminProcedure.mutation(async () => {
    const { agentOptimizerQueue } = await import('../queues');
    if (agentOptimizerQueue) {
      await agentOptimizerQueue.add('manual-optim', {}, { removeOnComplete: 1 });
      return { queued: true };
    }
    const { runPython } = await import('../pythonRunner');
    void trackDirectAgentRun('optimizer', runPython('agents/optimizer_agent.py', [], 20 * 60_000));
    return { queued: false, running: true };
  }),

  runFullAgentPipeline: adminProcedure.mutation(async () => {
    const queues = await import('../queues');
    const jobs = [
      { q: queues.agentDataScientistQueue, name: 'pipeline-ds',    delay: 0,  script: 'agents/data_scientist_agent.py', timeout: 10 * 60_000 },
      { q: queues.agentStrategistQueue,    name: 'pipeline-strat', delay: 5 * 60_000, script: 'agents/strategist_agent.py', timeout: 15 * 60_000 },
      { q: queues.agentAuditorQueue,       name: 'pipeline-audit', delay: 10 * 60_000, script: 'agents/auditor_agent.py', timeout: 15 * 60_000 },
      { q: queues.agentOptimizerQueue,     name: 'pipeline-optim', delay: 15 * 60_000, script: 'agents/optimizer_agent.py', timeout: 20 * 60_000 },
    ];

    let queued = 0;
    const directAgents: Array<{ agentId: string; script: string; timeout: number }> = [];
    const agentIdForScript = (script: string) =>
      script.replace(/^agents\//, '').replace(/_agent\.py$/, '');

    for (const { q, name, delay, script, timeout } of jobs) {
      if (q) {
        await q.add(name, {}, { delay, removeOnComplete: 1 });
        queued++;
      } else {
        directAgents.push({ agentId: agentIdForScript(script), script, timeout });
      }
    }

    if (directAgents.length > 0) {
      const { runPython } = await import('../pythonRunner');
      const runAgents = async () => {
        for (const agent of directAgents) {
          // Sequential by design (pipeline stages), so one agent's failure is tracked and
          // logged without aborting the rest -- trackDirectAgentRun swallows the rejection.
          await trackDirectAgentRun(agent.agentId, runPython(agent.script, [], agent.timeout));
        }
      };
      void runAgents();
    }

    return {
      queued,
      message: directAgents.length === 0
        ? `Enqueued ${queued}/4 agents`
        : `Enqueued ${queued}/4 agents and started ${directAgents.length} agent(s) directly`,
    };
  }),
});
