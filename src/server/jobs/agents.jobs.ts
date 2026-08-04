/**
 * Autonomous agent jobs (data-scientist, strategist, auditor, optimizer), migrated out of
 * queues.ts's initQueues() as the second slice of the queues.ts decomposition (see CLAUDE.md
 * architecture review, Phase 3 — the first slice was the screener/scoring jobs in
 * screeners.jobs.ts). Three of the four were already byte-for-byte identical in registration
 * shape; agent-data-scientist's completed handler logs an extra `grade` field from its result,
 * covered by registerRepeatableJob()'s onCompleted hook rather than forcing a special case.
 *
 * Queue/worker instances are still exported from queues.ts under their original names
 * (agentDataScientistQueue, agentStrategistQueue, ...) — agents.router.ts (manual triggers +
 * the "run pipeline" feature) and monitor.router.ts's queue-health dashboard import those
 * exact bindings directly, so this module only owns the *registration logic*.
 */
import { Job } from 'bullmq';
import { runPython } from '../pythonRunner';
import { dbGet, dbAll } from '../dbAsync';
import { registerRepeatableJob } from './registerJob';
import { sanitizeMarkdown } from '../telegramService';

export const QUEUE_AGENT_DATA_SCIENTIST = 'agent-data-scientist';
export const QUEUE_AGENT_STRATEGIST     = 'agent-strategist';
export const QUEUE_AGENT_AUDITOR        = 'agent-auditor';
export const QUEUE_AGENT_OPTIMIZER      = 'agent-optimizer';

async function processAgentDataScientist(_job: Job): Promise<{ success: boolean; grade?: string }> {
  await runPython('agents/data_scientist_agent.py', [], 10 * 60_000);
  const row = await dbGet<{ quality_grade: string }>(
    'SELECT quality_grade FROM agent_data_scientist_reports ORDER BY created_at DESC LIMIT 1'
  );
  return { success: true, grade: row?.quality_grade };
}

async function processAgentStrategist(_job: Job): Promise<{ success: boolean }> {
  await runPython('agents/strategist_agent.py', [], 15 * 60_000);

  const highPicks = await dbAll<any>(`
    SELECT symbol, timeframe, entry_zone_low, entry_zone_high,
           stop_loss, target_1, target_2, target_3, composite_score, narrative
    FROM agent_strategy_picks
    WHERE date(run_date)::text = date('now') AND conviction = 'HIGH'
    ORDER BY composite_score DESC
  `);

  if (highPicks.length > 0) {
    try {
      const { TelegramNotificationService } = await import('../telegramService');
      const tg = new TelegramNotificationService();
      for (const p of highPicks) {
        const firstSentence = sanitizeMarkdown((p.narrative as string || '').split('.')[0]);
        await tg.sendMarkdownMessage(
          `🎯 *STRATEGY ALERT — ${(p.timeframe as string).toUpperCase()}*\n` +
          `*${sanitizeMarkdown(p.symbol)}* | Entry: ₹${p.entry_zone_low}–${p.entry_zone_high} | SL: ₹${p.stop_loss}\n` +
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

  const latest = await dbGet<any>(
    'SELECT weights_changed, full_optimizer_triggered, baseline_win_rate, new_win_rate, narrative ' +
    'FROM agent_optimizer_reports ORDER BY created_at DESC LIMIT 1'
  );

  if (latest && (latest.weights_changed || latest.full_optimizer_triggered)) {
    try {
      const { TelegramNotificationService } = await import('../telegramService');
      const tg = new TelegramNotificationService();
      const firstSentence = sanitizeMarkdown((latest.narrative as string || '').split('.')[0]);
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

export async function registerAgentJobs(connection: any) {
  const dataScientist = await registerRepeatableJob({
    connection,
    queueName: QUEUE_AGENT_DATA_SCIENTIST,
    jobName: 'agent-ds-daily',
    repeat: { pattern: '30 1 * * 1-5' }, // 07:00 IST
    jobId: 'agent-ds-daily',
    removeOnComplete: 3,
    removeOnFail: 3,
    processor: processAgentDataScientist,
    monitorName: 'agent-data-scientist',
    concurrency: 1,
    lockDuration: 10 * 60_000,
    // Preserves the original handler's extra `[QUEUE] agent-ds done, grade= X` log line
    // (distinct text from the standard `[QUEUE] agent-data-scientist completed` line above it).
    onCompleted: (r: any) => console.log('[QUEUE] agent-ds done, grade=', r?.grade),
  });

  const strategist = await registerRepeatableJob({
    connection,
    queueName: QUEUE_AGENT_STRATEGIST,
    jobName: 'agent-strat-daily',
    // 08:50 IST. Moved off 08:30 IST 2026-07-31 — it started on the same minute as
    // research-premarket. Still comfortably pre-open (09:15 IST).
    repeat: { pattern: '20 3 * * 1-5' },
    jobId: 'agent-strat-daily',
    removeOnComplete: 3,
    removeOnFail: 3,
    processor: processAgentStrategist,
    monitorName: 'agent-strategist',
    concurrency: 1,
    lockDuration: 15 * 60_000,
  });

  const auditor = await registerRepeatableJob({
    connection,
    queueName: QUEUE_AGENT_AUDITOR,
    jobName: 'agent-audit-daily',
    repeat: { pattern: '0 11 * * 1-5' }, // 16:30 IST
    jobId: 'agent-audit-daily',
    removeOnComplete: 3,
    removeOnFail: 3,
    processor: processAgentAuditor,
    monitorName: 'agent-auditor',
    concurrency: 1,
    lockDuration: 15 * 60_000,
  });

  const optimizer = await registerRepeatableJob({
    connection,
    queueName: QUEUE_AGENT_OPTIMIZER,
    jobName: 'agent-optim-daily',
    repeat: { pattern: '0 12 * * 1-5' }, // 17:30 IST
    jobId: 'agent-optim-daily',
    removeOnComplete: 3,
    removeOnFail: 3,
    processor: processAgentOptimizer,
    monitorName: 'agent-optimizer',
    concurrency: 1,
    lockDuration: 20 * 60_000,
  });

  return { dataScientist, strategist, auditor, optimizer };
}
