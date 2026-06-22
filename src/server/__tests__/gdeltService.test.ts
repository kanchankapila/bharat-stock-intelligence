import { describe, it, expect } from 'vitest';
import { parseGdeltTimeline } from '../gdeltService';

describe('parseGdeltTimeline', () => {
  it('parses the documented timelinetone JSON into {date,tone} points', () => {
    const body = JSON.stringify({
      timeline: [{
        series: 'Average Tone',
        data: [
          { date: '20260401T000000Z', value: -1.5 },
          { date: '20260402T000000Z', value: 2.3 },
        ],
      }],
    });
    expect(parseGdeltTimeline(body)).toEqual([
      { date: '2026-04-01', tone: -1.5 },
      { date: '2026-04-02', tone: 2.3 },
    ]);
  });

  it('returns [] for the GDELT rate-limit text response (not JSON)', () => {
    expect(parseGdeltTimeline('Please limit requests to one every 5 seconds')).toEqual([]);
  });

  it('returns [] when the timeline is empty or missing', () => {
    expect(parseGdeltTimeline(JSON.stringify({ timeline: [] }))).toEqual([]);
    expect(parseGdeltTimeline(JSON.stringify({}))).toEqual([]);
  });

  it('skips malformed points (no numeric value or bad date)', () => {
    const body = JSON.stringify({
      timeline: [{ data: [
        { date: '20260401T000000Z', value: 1.0 },
        { date: 'bad', value: 5 },
        { date: '20260403T000000Z', value: 'x' },
      ]}],
    });
    expect(parseGdeltTimeline(body)).toEqual([{ date: '2026-04-01', tone: 1.0 }]);
  });
});
