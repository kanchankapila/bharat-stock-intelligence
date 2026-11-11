import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// AF-20261111-01: DL inference and retraining were retired on 2026-11-11 (user decision).
// dl_score has weight 0.0 in every regime, 5d rank IC +0.003 (t 0.74, 90 dates), and its
// uncertainty/confidence outputs add nothing beyond trailing volatility (measurement.md,
// 2026-11-11). The retrain peaked at 13.8 GB. Feature refresh, regime update and the macro
// fetch stay: feature_store feeds the ML ensemble and market_regimes feeds the ranker.
const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf-8');

describe('DL inference and retraining stay retired (AF-20261111-01)', () => {
  const dl = read('jobs/dl.jobs.ts');
  const queues = read('queues.ts');

  it('registers no DL inference or weekly-retrain schedule and clears both from Redis', () => {
    expect(dl).not.toMatch(/queueName:\s*QUEUE_DL_(INFERENCE|RETRAIN_WEEKLY)\b/);
    expect(dl).toMatch(/\[QUEUE_DL_INFERENCE, QUEUE_DL_RETRAIN_WEEKLY\][\s\S]{0,300}removeRepeatableByKey/);
  });

  it('runs no dl_engine.py or dl_trainer.py from any job', () => {
    expect(dl).not.toMatch(/'dl_engine\.py'|'dl_trainer\.py'/);
    expect(queues).not.toMatch(/'dl_trainer\.py'/);
    expect(queues).not.toMatch(/dlRetrainEmergencyQueue\?\.add|dispatchFullRetrainAfterWeeklyData/);
    expect(queues).not.toMatch(/'--table', 'deep_learning_predictions'/);
  });

  it('keeps the DL-named steps that feed live models', () => {
    for (const q of ['QUEUE_DL_FEATURE_REFRESH', 'QUEUE_DL_REGIME_UPDATE', 'QUEUE_DL_MACRO_FETCH']) {
      expect(dl).toMatch(new RegExp(`queueName:\\s*${q}\\b`));
    }
  });

  it('monitors and freshness-checks nothing that never runs again', () => {
    expect(read('monitorScripts.ts')).not.toMatch(/id:\s*'dl-(engine-infer|trainer)'/);
    expect(read('jobRegistry.ts')).not.toMatch(/jobName:\s*'dl-retrain-emergency'/);
    expect(read('dataQualityChecks.ts')).not.toMatch(/modelName:\s*'BiLSTM'/);
  });
});
