import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../jobHeartbeat');

import { updateMonitorState } from '../monitoringService';
import { recordHeartbeat } from '../jobHeartbeat';

const recordHeartbeatMock = vi.mocked(recordHeartbeat);

describe('updateMonitorState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates success to recordHeartbeat', () => {
    updateMonitorState('quant-eod-sync', 'success');
    expect(recordHeartbeatMock).toHaveBeenCalledWith('quant-eod-sync', 'success', undefined, undefined);
  });

  it('delegates failure with message to recordHeartbeat', () => {
    updateMonitorState('fii-dii-fetcher', 'failed', 'timeout');
    expect(recordHeartbeatMock).toHaveBeenCalledWith('fii-dii-fetcher', 'failed', 'timeout', undefined);
  });

  // 2026-09-04: duration_ms plumbing (AF-20260904-04) added a 4th optional param -- confirm it
  // passes through undisturbed when a caller does supply one.
  it('passes a supplied durationMs through as the 4th arg', () => {
    updateMonitorState('quant-eod-sync', 'success', undefined, 4321);
    expect(recordHeartbeatMock).toHaveBeenCalledWith('quant-eod-sync', 'success', undefined, 4321);
  });
});
