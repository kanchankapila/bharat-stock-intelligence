import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mockGenerateContent = vi.fn();

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: mockGenerateContent };
  },
  Type: { OBJECT: 'OBJECT', STRING: 'STRING', NUMBER: 'NUMBER', BOOLEAN: 'BOOLEAN' },
}));

const { generateStockAnalysis, _resetGeminiStateForTests } = await import('../geminiService');

describe('Gemini pacing and bounded retry', () => {
  beforeEach(() => {
    mockGenerateContent.mockReset();
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.GEMINI_MIN_INTERVAL_MS = '0';
    process.env.GEMINI_RETRY_BASE_MS = '0';
    process.env.GEMINI_MAX_ATTEMPTS = '3';
    _resetGeminiStateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_MIN_INTERVAL_MS;
    delete process.env.GEMINI_RETRY_BASE_MS;
    delete process.env.GEMINI_MAX_ATTEMPTS;
    delete process.env.GEMINI_MAX_RETRY_DELAY_MS;
    delete process.env.GEMINI_TRANSIENT_COOLDOWN_MS;
  });

  it('retries transient 503 responses and returns the recovered analysis', async () => {
    mockGenerateContent
      .mockRejectedValueOnce(Object.assign(new Error('503 UNAVAILABLE'), { status: 503 }))
      .mockRejectedValueOnce(Object.assign(new Error('503 UNAVAILABLE'), { status: 503 }))
      .mockResolvedValueOnce({ text: JSON.stringify({
        sentiment: 'Bullish', signal: 'BUY', reasoning: 'Recovered', confidence: 82,
      }) });

    await expect(generateStockAnalysis('TCS', { rsi: 55 })).resolves.toMatchObject({
      sentiment: 'Bullish', signal: 'BUY', reasoning: 'Recovered', confidence: 82,
    });
    expect(mockGenerateContent).toHaveBeenCalledTimes(3);
  });

  it('opens a cooldown circuit after transient retries are exhausted', async () => {
    process.env.GEMINI_MAX_ATTEMPTS = '2';
    const unavailable = Object.assign(new Error('503 UNAVAILABLE'), { status: 503 });
    mockGenerateContent.mockRejectedValue(unavailable);

    const first = await generateStockAnalysis('TCS', {});
    const second = await generateStockAnalysis('INFY', {});

    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    expect(first).toMatchObject({ signal: 'HOLD', confidence: 0 });
    expect(second).toMatchObject({ signal: 'HOLD', confidence: 0 });
  });

  it('returns an honest conservative result after quota retries are exhausted', async () => {
    const quota = Object.assign(new Error('429 RESOURCE_EXHAUSTED retryDelay:"0s"'), { status: 429 });
    mockGenerateContent.mockRejectedValue(quota);

    const result = await generateStockAnalysis('TCS', {});
    expect(mockGenerateContent).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ error: 'QUOTA_EXCEEDED', signal: 'HOLD', confidence: 0 });
    expect(result.reasoning).toContain('bounded retries');
  });

  it('does not sleep or retry when Gemini reports a daily-quota-scale retry delay', async () => {
    const dailyQuota = Object.assign(
      new Error('429 RESOURCE_EXHAUSTED retryDelay:"61728s"'),
      { status: 429 },
    );
    mockGenerateContent.mockRejectedValue(dailyQuota);

    const result = await generateStockAnalysis('TCS', {});
    const second = await generateStockAnalysis('INFY', {});

    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ error: 'QUOTA_EXCEEDED', signal: 'HOLD', confidence: 0 });
    expect(second).toMatchObject({ error: 'QUOTA_EXCEEDED', signal: 'HOLD', confidence: 0 });
  });

  it('serializes request starts according to the configured minimum interval', async () => {
    vi.useFakeTimers();
    process.env.GEMINI_MIN_INTERVAL_MS = '1000';
    _resetGeminiStateForTests();
    mockGenerateContent.mockResolvedValue({ text: JSON.stringify({
      sentiment: 'Neutral', signal: 'HOLD', reasoning: 'ok', confidence: 50,
    }) });

    const first = generateStockAnalysis('AAA', {});
    const second = generateStockAnalysis('BBB', {});
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([first, second]);
    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
  });
});
