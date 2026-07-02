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
    expect(recordHeartbeatMock).toHaveBeenCalledWith('quant-eod-sync', 'success', undefined);
  });

  it('delegates failure with message to recordHeartbeat', () => {
    updateMonitorState('fii-dii-fetcher', 'failed', 'timeout');
    expect(recordHeartbeatMock).toHaveBeenCalledWith('fii-dii-fetcher', 'failed', 'timeout');
  });
});
