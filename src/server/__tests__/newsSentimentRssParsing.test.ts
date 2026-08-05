import { vi, describe, test, expect } from 'vitest';

// parseRSS/extractCdata are module-internal (not exported), so the unit-level tests below
// mirror newsSentimentService.ts's extractCdata/stripHtml exactly to pin the regex bug fix.
// The e2e describe block further down drives the REAL module (mocked fetch, real parseRSS)
// as the source of truth — if this local copy ever drifts from the real implementation,
// that block is what actually catches it.
function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}
function extractCdata(block: string, tag: string): string {
  const cdataRe = new RegExp(`<${tag}>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`, 'i');
  const plainRe  = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = cdataRe.exec(block) || plainRe.exec(block);
  return m ? stripHtml(m[1].trim()) : '';
}

describe('extractCdata — ET RSS whitespace-before-closing-tag bug (2026-08-05)', () => {
  test('extracts a title when there is a space between ]]> and </title> (ET\'s real shape)', () => {
    const block = '<title><![CDATA[RBI MPC At a Glance: Guide for all key decisions]]> </title><link>https://x.com</link>';
    expect(extractCdata(block, 'title')).toBe('RBI MPC At a Glance: Guide for all key decisions');
  });

  test('extracts a title when there is a newline between ]]> and </title>', () => {
    const block = '<title><![CDATA[Some headline]]>\n</title>';
    expect(extractCdata(block, 'title')).toBe('Some headline');
  });

  test('still extracts a title with the strict no-whitespace CDATA form (regression guard)', () => {
    const block = '<title><![CDATA[Sensex rises 100 points]]></title>';
    expect(extractCdata(block, 'title')).toBe('Sensex rises 100 points');
  });

  test('still extracts a plain (non-CDATA) title unaffected by the fix', () => {
    const block = '<title>Nifty ends flat</title>';
    expect(extractCdata(block, 'title')).toBe('Nifty ends flat');
  });

  test('does NOT silently collapse to empty string for the buggy shape (the actual failure mode)', () => {
    const block = '<title><![CDATA[Headline with content]]> </title>';
    const result = extractCdata(block, 'title');
    expect(result).not.toBe('');
    expect(result.length).toBeGreaterThan(0);
  });
});

vi.mock('../dbAsync', () => ({
  dbGet: vi.fn().mockResolvedValue(undefined),
  dbAll: vi.fn().mockResolvedValue([]),
  dbRun: vi.fn(),
  dbTransaction: vi.fn(async (fn: any) => fn({ run: vi.fn() })),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const { runNewsSentimentCycle } = await import('../newsSentimentService');

describe('parseRSS end-to-end via runNewsSentimentCycle (real module, mocked fetch)', () => {
  test('an ET-shaped feed (]]> before the closing tag) yields a non-empty, ingestible title', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => `<?xml version="1.0"?><rss><channel><item>
        <title><![CDATA[RBI MPC At a Glance: Guide for all key decisions]]> </title>
        <link><![CDATA[https://economictimes.indiatimes.com/x]]> </link>
        <pubDate><![CDATA[Wed, 05 Aug 2026 08:00:00 +0530]]> </pubDate>
        <description><![CDATA[Some summary text]]> </description>
      </item></channel></rss>`,
    });

    const result = await runNewsSentimentCycle();

    // Before the fix, every item in an ET-shaped feed had its title collapsed to '' by
    // stripHtml eating the literal CDATA markers, so parseRSS's `if (title)` guard dropped
    // every single one — fetched would be >0 but processed/inserted would be 0.
    expect(result.fetched).toBeGreaterThan(0);
    expect(result.inserted).toBeGreaterThan(0);
  });
});
