import { beforeEach, describe, expect, it } from 'vitest';

if (!process.env.VITEST_PG_SCHEMA) {
  throw new Error('XBRL observation fixtures require the isolated Vitest schema');
}
const schema = process.env.VITEST_PG_SCHEMA;
const { dbGet, dbRun } = await import('../dbAsync');
const { DATA_QUALITY_CHECKS } = await import('../dataQualityChecks');
const check = DATA_QUALITY_CHECKS.find(c => c.id === 'xbrl-observation-latest-integrity')!;

async function run() {
  return check.evaluate(await dbGet(check.sql), new Date());
}

describe('XBRL observation check against PostgreSQL', () => {
  beforeEach(async () => {
    await dbRun(`DELETE FROM "${schema}".nse_filing_financial_observations`);
  });

  it('warns until an observation has actually been captured', async () => {
    expect((await run()).status).toBe('warn');
  });

  it('checks the latest payload identity without claiming coverage', async () => {
    await dbRun(`INSERT INTO "${schema}".nse_filing_financial_observations
      (symbol,period_end,consolidated,broadcast_ts,filing_period,source_url,payload)
      VALUES ('PROBE','2026-09-30',true,'2026-10-28T13:00:00Z','Integrated','https://example.test/xbrl',
        '{"symbol":"PROBE","period_end":"2026-09-30","filing_period":"Integrated","source_url":"https://example.test/xbrl"}'::jsonb)`);
    expect((await run()).status).toBe('pass');
    await dbRun(`UPDATE "${schema}".nse_filing_financial_observations
      SET payload = payload || '{"symbol":"WRONG"}'::jsonb WHERE symbol = 'PROBE'`);
    expect((await run()).status).toBe('fail');
  });

  it('names the latest observation, so a stalled writer reads as a frozen detail', async () => {
    const insert = (sym: string) => dbRun(`INSERT INTO "${schema}".nse_filing_financial_observations
      (symbol,period_end,consolidated,broadcast_ts,filing_period,source_url,payload)
      VALUES ('${sym}','2026-09-30',true,'2026-10-28T13:00:00Z','Integrated','https://example.test/${sym}',
        '{"symbol":"${sym}","period_end":"2026-09-30","filing_period":"Integrated","source_url":"https://example.test/${sym}"}'::jsonb)`);
    await insert('PROBEA');
    const first = await run();
    await insert('PROBEB');
    const second = await run();
    expect(second.status).toBe('pass');
    expect(second.detail).toContain('PROBEB');
    expect(second.detail).not.toBe(first.detail);
  });
});
