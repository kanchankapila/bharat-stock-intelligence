import { describe, it, expect } from 'vitest';
import { isMeaningfulNewsSentiment } from '../technicalSignalsService';

// 2026-08-06 fix: runTechnicalSignalScan used to discard news_sentiment_score entirely for
// any symbol with zero technical signals that day, regardless of how strong the news was --
// live-confirmed dropping a real, correctly-tagged, 24h-old BULLISH M&A-talk article for
// CELLO the morning before a +15.69% move, because its chart was technically unremarkable
// (RSI 63.74, nothing extreme). isMeaningfulNewsSentiment is the extracted, pure core of the
// fix: a symbol clearing this bar now gets its technical_signals row persisted (score=0,
// signals=[]) even with no technical pattern, purely so the news signal isn't silently lost.
describe('isMeaningfulNewsSentiment', () => {
  it('is true for a strongly bullish score above the threshold', () => {
    expect(isMeaningfulNewsSentiment(1.0)).toBe(true);   // CELLO's real Bain Capital article
    expect(isMeaningfulNewsSentiment(0.26)).toBe(true);
  });

  it('is true for a strongly bearish score below the negative threshold', () => {
    expect(isMeaningfulNewsSentiment(-0.5)).toBe(true);
    expect(isMeaningfulNewsSentiment(-0.26)).toBe(true);
  });

  it('is false for a mild/neutral score inside the threshold band', () => {
    expect(isMeaningfulNewsSentiment(0.24)).toBe(false);
    expect(isMeaningfulNewsSentiment(-0.24)).toBe(false);
    expect(isMeaningfulNewsSentiment(0)).toBe(false);
  });

  it('is false exactly at the boundary (strict >, not >=)', () => {
    expect(isMeaningfulNewsSentiment(0.25)).toBe(false);
    expect(isMeaningfulNewsSentiment(-0.25)).toBe(false);
  });

  it('matches the same threshold scoreSignals uses for its own bullish/bearish modifier', () => {
    // Not a re-implementation check -- both consumers must agree on what "meaningful" means,
    // or a symbol could get a news-only technical_signals row persisted (this gate) while
    // scoreSignals' own modifier disagrees about whether that same score was significant.
    expect(isMeaningfulNewsSentiment(0.251)).toBe(true);
    expect(isMeaningfulNewsSentiment(-0.251)).toBe(true);
  });
});
