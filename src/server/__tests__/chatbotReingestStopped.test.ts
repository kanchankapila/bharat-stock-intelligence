import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A chatbot the operator stopped on purpose (`pm2 stop chatbot`, to free memory) must not turn the
// nightly re-ingest into a failed job every night. Anything else -- crashed, errored, unknown to
// pm2, or pm2 unreadable -- must still fail loudly: the job throws on a dead chatbot because that
// silence once left the index frozen for eight weeks (see processChatbotReingest's comment).
const pm2Status = vi.hoisted(() => ({ value: 'online' as string | null, connectErr: null as Error | null }));

vi.mock('pm2', () => ({
  default: {
    connect: (cb: (e: Error | null) => void) => cb(pm2Status.connectErr),
    describe: (_name: string, cb: (e: Error | null, l: unknown[]) => void) =>
      cb(null, pm2Status.value === null ? [] : [{ pm2_env: { status: pm2Status.value } }]),
    disconnect: () => {},
  },
}));

import { processChatbotReingest } from '../jobs/operations.jobs';

describe('chatbot-reingest when the chatbot service is not running', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    pm2Status.value = 'online';
    pm2Status.connectErr = null;
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('skips (neither success nor failure) when pm2 reports the chatbot deliberately stopped', async () => {
    pm2Status.value = 'stopped';
    const r = await processChatbotReingest({} as any);
    expect(r).toMatchObject({ skipped: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still throws when the chatbot crashed (pm2 status errored)', async () => {
    pm2Status.value = 'errored';
    fetchMock.mockResolvedValue({ ok: false, status: 503, text: async () => 'down' });
    await expect(processChatbotReingest({} as any)).rejects.toThrow(/503/);
  });

  it('still throws when pm2 cannot be read', async () => {
    pm2Status.connectErr = new Error('no daemon');
    fetchMock.mockResolvedValue({ ok: false, status: 503, text: async () => 'down' });
    await expect(processChatbotReingest({} as any)).rejects.toThrow(/503/);
  });

  it('runs the ingest when the chatbot is online', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ stocks: 1 }) });
    await expect(processChatbotReingest({} as any)).resolves.toEqual({ stocks: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
