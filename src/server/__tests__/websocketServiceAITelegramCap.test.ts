import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock() calls are hoisted above all other statements -- see jobWatchdog.test.ts for the
// established pattern this file follows.
const { mockSendSignalNotification } = vi.hoisted(() => ({
  mockSendSignalNotification: vi.fn(async () => true),
}));

vi.mock('../telegramService', () => ({
  telegramService: { sendSignalNotification: mockSendSignalNotification },
}));

// ws (the `ws` package) opens a real net listener on import in some environments; this suite
// never calls initialize(), so no server is ever created, but stub it out anyway to keep the
// import side-effect-free and consistent with how other server tests avoid touching real I/O.
vi.mock('ws', () => ({
  WebSocketServer: vi.fn(),
  WebSocket: { OPEN: 1 },
}));

const {
  wsSignalService,
  AI_SIGNAL_TELEGRAM_DAILY_CAP,
  resetAITelegramCapForTests,
} = await import('../websocketService');

function buyAlert(symbol: string, source: 'AI' | 'TECHNICAL' | 'UNIFIED' = 'AI') {
  return {
    type: 'new_signal' as const,
    symbol,
    timestamp: new Date().toISOString(),
    source,
    signal: {
      signalType: 'BUY',
      entryPrice: 100,
      targetPrice: 110,
      stopLoss: 95,
      confidence: 41,
      reasoning: 'test',
    },
  };
}

beforeEach(() => {
  mockSendSignalNotification.mockClear();
  resetAITelegramCapForTests();
});

describe('AI-signal Telegram daily cap (defense-in-depth, 2026-08-06)', () => {
  it('sends a Telegram alert for an AI-sourced BUY signal under the cap', () => {
    wsSignalService.broadcastNewSignal(buyAlert('RELIANCE'));
    expect(mockSendSignalNotification).toHaveBeenCalledTimes(1);
    expect(mockSendSignalNotification).toHaveBeenCalledWith(
      'RELIANCE', 'BUY', 100, 110, 95, 41, 'test',
    );
  });

  it('stops sending once the daily cap is reached, even if the upstream gate degenerates', () => {
    for (let i = 0; i < AI_SIGNAL_TELEGRAM_DAILY_CAP; i++) {
      wsSignalService.broadcastNewSignal(buyAlert(`SYM${i}`));
    }
    expect(mockSendSignalNotification).toHaveBeenCalledTimes(AI_SIGNAL_TELEGRAM_DAILY_CAP);

    // This is the exact regression: dozens more AI BUY signals arriving in a burst (the
    // upstream win_probability gate having collapsed to a near-no-op) must not translate into
    // dozens more Telegram messages.
    for (let i = 0; i < 30; i++) {
      wsSignalService.broadcastNewSignal(buyAlert(`OVERFLOW${i}`));
    }
    expect(mockSendSignalNotification).toHaveBeenCalledTimes(AI_SIGNAL_TELEGRAM_DAILY_CAP);
  });

  it('does not consume budget or send for non-AI sources (TECHNICAL, UNIFIED)', () => {
    wsSignalService.broadcastNewSignal(buyAlert('INFY', 'TECHNICAL'));
    wsSignalService.broadcastNewSignal(buyAlert('TCS', 'UNIFIED'));
    expect(mockSendSignalNotification).not.toHaveBeenCalled();

    // Budget must still be fully available afterward -- non-AI traffic never touches it.
    for (let i = 0; i < AI_SIGNAL_TELEGRAM_DAILY_CAP; i++) {
      wsSignalService.broadcastNewSignal(buyAlert(`AI${i}`));
    }
    expect(mockSendSignalNotification).toHaveBeenCalledTimes(AI_SIGNAL_TELEGRAM_DAILY_CAP);
  });

  it('does not send for AI-sourced non-BUY signals (SELL)', () => {
    const sell = buyAlert('WIPRO');
    sell.signal.signalType = 'SELL';
    wsSignalService.broadcastNewSignal(sell);
    expect(mockSendSignalNotification).not.toHaveBeenCalled();
  });

  it('resets the budget on a new day', () => {
    for (let i = 0; i < AI_SIGNAL_TELEGRAM_DAILY_CAP; i++) {
      wsSignalService.broadcastNewSignal(buyAlert(`D1SYM${i}`));
    }
    expect(mockSendSignalNotification).toHaveBeenCalledTimes(AI_SIGNAL_TELEGRAM_DAILY_CAP);

    resetAITelegramCapForTests(); // simulates the day rolling over
    wsSignalService.broadcastNewSignal(buyAlert('D2SYM'));
    expect(mockSendSignalNotification).toHaveBeenCalledTimes(AI_SIGNAL_TELEGRAM_DAILY_CAP + 1);
  });
});
