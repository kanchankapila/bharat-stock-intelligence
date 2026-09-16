import { describe, it, expect } from 'vitest';
import { profileSyncVerdict } from '../companyProfileSyncService';

/**
 * syncAndAnalyzeCompanyProfiles() returned a hardcoded `success: true` regardless of outcome,
 * and processCompanyProfilesSync() was typed Promise<void> so it discarded even that. Live on
 * 2026-09-05 the job logged "Completed. Success: 0, Failed: 2" and recorded 'success' in
 * job_run_history -- every stock it attempted had failed, because GEMINI_API_KEY is present in
 * .env but EMPTY (zero-length value), so the analysis call cannot succeed for any symbol.
 *
 * The distinction that matters is "nothing was due" versus "everything attempted failed".
 * Both write zero rows, and only the second is a fault -- a verdict that cannot tell them apart
 * either cries wolf on a quiet day or stays silent through a total outage.
 */
describe('profileSyncVerdict', () => {
  it('is a success when nothing was due for analysis', () => {
    expect(profileSyncVerdict(0, 0)).toEqual({ success: true, processed: 0, failed: 0 });
  });

  it('is a FAILURE when work was attempted and every single item failed', () => {
    // The live 2026-09-05 case: 0 succeeded, 2 failed, reported as success.
    expect(profileSyncVerdict(0, 2).success).toBe(false);
  });

  it('is a success when at least one item succeeded, even alongside failures', () => {
    // Partial failure must not fail the whole job: the successes are real work that landed,
    // and a per-symbol upstream error is normal for a 387-symbol universe.
    expect(profileSyncVerdict(5, 2).success).toBe(true);
  });

  it('carries the real counts through rather than flattening them', () => {
    expect(profileSyncVerdict(5, 2)).toEqual({ success: true, processed: 5, failed: 2 });
  });
});
