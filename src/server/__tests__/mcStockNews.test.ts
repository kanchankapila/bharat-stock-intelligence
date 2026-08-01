import { describe, it, expect } from 'vitest';
import {
  decodeMangledEscapes,
  formatHumanTimestamp,
  parseMcStockNews,
} from '../mcApiService';

/**
 * Captured verbatim from
 * https://www.moneycontrol.com/techmvc/mc_apis/mc_pricechart_homepage/news?sc_did=HDF01
 * on 2026-07-31 — including the mangled "u2013" MoneyControl actually serves.
 */
const LIVE_PAYLOAD = {
  body: {
    section: 'news',
    news: {
      element_name: 'News & Videos',
      count: 10,
      data: [
        {
          heading: 'Weekly Tactical Pick u2013 Why the price captures the headwinds for this banking behemoth',
          posturl: 'https://www.moneycontrol.com/news/business/moneycontrol-research/weekly-tactical-pick-13989792.html',
          creation_date_epoch: '1785472647',
          update_date_epoch: '1785472798',
          display_date: 'Jul 31, 2026',
          post_type: 'news',
          post_image: 'https://images.moneycontrol.com/static-mcnews/2026/03/hdfc-bank-1.jpg',
          summary: '',
        },
        {
          heading: 'HDFC Bank slips nearly 1% after board fines CEO, CFO over MSRDC matter',
          posturl: 'https://www.moneycontrol.com/news/business/stocks/hdfc-bank-slips-13989123.html',
          creation_date_epoch: '1785460000',
          update_date_epoch: '1785460100',
          display_date: 'Jul 31, 2026',
          post_type: 'news',
          post_image: '',
          summary: 'Shares declined in early trade u2014 brokerages retained their calls.',
        },
      ],
      additional_links: [
        { name: 'Business', link: 'https://www.moneycontrol.com/news/hdfcbank/business-HDF01-3months-1.html' },
        { name: 'Earnings', link: 'https://www.moneycontrol.com/news/hdfcbank/results-HDF01-3months-2.html' },
      ],
      more_link: { name: 'View All News', link: 'https://www.moneycontrol.com/company-article/hdfcbank/news/HDF01' },
    },
  },
};

/** What MoneyControl returns for an sc_id it does not recognise (verified live). */
const UNKNOWN_ID_PAYLOAD = { body: { section: 'news', news: null } };

describe('decodeMangledEscapes', () => {
  it('repairs the backslash-stripped \\uXXXX escapes MoneyControl serves', () => {
    expect(decodeMangledEscapes('Weekly Tactical Pick u2013 Why the price')).toBe(
      'Weekly Tactical Pick – Why the price',
    );
    expect(decodeMangledEscapes('early trade u2014 brokerages')).toBe('early trade — brokerages');
  });

  it('leaves all-letter hex-shaped words alone', () => {
    // "ubade" is valid hex but carries no digit — repairing it would invent a
    // Hangul syllable out of an ordinary word.
    expect(decodeMangledEscapes('the ubade case')).toBe('the ubade case');
  });

  it('leaves sequences that decode inside ASCII alone', () => {
    expect(decodeMangledEscapes('code u0041 here')).toBe('code u0041 here');
  });

  it('does not touch a hex run in the middle of a word', () => {
    expect(decodeMangledEscapes('Neu2013ral')).toBe('Neu2013ral');
  });

  it('repairs consecutive occurrences', () => {
    expect(decodeMangledEscapes('a u2013 b u2013 c')).toBe('a – b – c');
  });

  it('passes empty input through', () => {
    expect(decodeMangledEscapes('')).toBe('');
  });
});

describe('formatHumanTimestamp', () => {
  const nowSec = () => Math.floor(Date.now() / 1000);

  it('renders sub-hour ages in minutes, never "0 mins"', () => {
    expect(formatHumanTimestamp(String(nowSec() - 300))).toBe('5 mins ago');
    expect(formatHumanTimestamp(String(nowSec() - 10))).toBe('1 min ago');
  });

  it('renders same-day ages in hours', () => {
    expect(formatHumanTimestamp(String(nowSec() - 3 * 3600))).toBe('3 hours ago');
    expect(formatHumanTimestamp(String(nowSec() - 3600))).toBe('1 hour ago');
  });

  it('renders ages under a week in days', () => {
    expect(formatHumanTimestamp(String(nowSec() - 3 * 86400))).toBe('3 days ago');
    expect(formatHumanTimestamp(String(nowSec() - 86400))).toBe('1 day ago');
  });

  it('falls back to an absolute date beyond a week', () => {
    const out = formatHumanTimestamp(String(nowSec() - 30 * 86400));
    expect(out).toMatch(/^\d{2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} (AM|PM)$/);
  });

  it('uses the absolute format for future timestamps rather than a negative age', () => {
    const out = formatHumanTimestamp(String(nowSec() + 86400));
    expect(out).toMatch(/^\d{2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} (AM|PM)$/);
    expect(out).not.toContain('ago');
  });

  it('falls back to the display date when the epoch is unusable', () => {
    expect(formatHumanTimestamp('not-a-number', 'Jul 29, 2026')).toBe('Jul 29, 2026');
    expect(formatHumanTimestamp(undefined, 'Jul 29, 2026')).toBe('Jul 29, 2026');
  });

  it('degrades to a dash when nothing usable is supplied', () => {
    expect(formatHumanTimestamp(undefined, undefined)).toBe('—');
  });
});

describe('parseMcStockNews', () => {
  it('parses the live payload shape', () => {
    const out = parseMcStockNews('HDF01', LIVE_PAYLOAD);
    expect(out.status).toBe('ok');
    expect(out.scId).toBe('HDF01');
    expect(out.news).toHaveLength(2);
    expect(out.news[0].posturl).toContain('moneycontrol.com');
    expect(out.news[0].formatted_date).toBeTruthy();
    expect(out.additional_links).toHaveLength(2);
    expect(out.more_link?.link).toContain('company-article');
  });

  it('decodes mangled escapes in both heading and summary', () => {
    const out = parseMcStockNews('HDF01', LIVE_PAYLOAD);
    expect(out.news[0].heading).not.toContain('u2013');
    expect(out.news[0].heading).toContain('–');
    expect(out.news[1].summary).toContain('—');
  });

  it('reports the number of items returned, not the upstream page size', () => {
    // Upstream `count` is 10 (the page size) while `data` holds 2 items here —
    // reporting 10 would claim articles the UI does not have.
    expect(LIVE_PAYLOAD.body.news.count).toBe(10);
    expect(parseMcStockNews('HDF01', LIVE_PAYLOAD).count).toBe(2);
  });

  it('distinguishes an unknown sc_id from a failed fetch', () => {
    expect(parseMcStockNews('ZZZZ99', UNKNOWN_ID_PAYLOAD).status).toBe('no_news');
    expect(parseMcStockNews('RI', null).status).toBe('fetch_failed');
    expect(parseMcStockNews('RI', undefined).status).toBe('fetch_failed');
    expect(parseMcStockNews('RI', {}).status).toBe('fetch_failed');
  });

  it('always returns renderable arrays, whatever the outcome', () => {
    for (const res of [null, UNKNOWN_ID_PAYLOAD, { body: { news: { data: 'nope' } } }]) {
      const out = parseMcStockNews('X', res);
      expect(Array.isArray(out.news)).toBe(true);
      expect(Array.isArray(out.additional_links)).toBe(true);
      expect(out.count).toBe(0);
    }
  });

  it('tolerates items missing every optional field', () => {
    const out = parseMcStockNews('X', { body: { news: { data: [{}] } } });
    expect(out.status).toBe('ok');
    expect(out.news[0].heading).toBe('');
    expect(out.news[0].post_type).toBe('news');
    expect(out.news[0].formatted_date).toBe('—');
  });
});
