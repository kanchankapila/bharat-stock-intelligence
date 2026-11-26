import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanyAnnouncements, FnoBanBadge, FnoBanList, ParticipantPositions } from './NseExchangeData';

const state: Record<string, { data?: unknown; isError?: boolean }> = {};
vi.mock('../lib/trpc', () => {
  const proc = (name: string) => ({ useQuery: () => ({ data: state[name]?.data, isError: !!state[name]?.isError, isLoading: false }) });
  return { trpc: { getFnoBanList: proc('ban'), getParticipantPositions: proc('oi'), getCompanyAnnouncements: proc('ann') } };
});

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-26T10:00:00+05:30')); });
afterEach(() => { vi.useRealTimers(); for (const k of Object.keys(state)) delete state[k]; });

describe('FnoBanList', () => {
  it('names the banned stocks with the trade date and source', () => {
    state.ban = { data: { tradeDate: '2026-11-26', fetchedAt: null, symbols: ['APLAPOLLO'] } };
    const html = renderToStaticMarkup(<FnoBanList />);
    expect(html).toContain('APLAPOLLO');
    expect(html).toContain('2026-11-26');
    expect(html).toContain('NSE');
  });

  it('does not present an older list as current', () => {
    // A day with no banned names stores no rows, so the newest stored list can be a stale one.
    state.ban = { data: { tradeDate: '2026-11-23', fetchedAt: null, symbols: ['OLDNAME'] } };
    const html = renderToStaticMarkup(<FnoBanList />);
    expect(html).not.toContain('OLDNAME');
    expect(html).toContain('No current list');
    expect(html).toContain('2026-11-23');
  });

  it('says unavailable on a failed read, not "no ban"', () => {
    state.ban = { isError: true };
    expect(renderToStaticMarkup(<FnoBanList />)).toContain('Could not load');
  });
});

describe('FnoBanBadge', () => {
  it('shows only for a symbol on a current list', () => {
    state.ban = { data: { tradeDate: '2026-11-26', fetchedAt: null, symbols: ['APLAPOLLO'] } };
    expect(renderToStaticMarkup(<FnoBanBadge symbol="aplapollo" />)).toContain('F&amp;O ban');
    expect(renderToStaticMarkup(<FnoBanBadge symbol="TCS" />)).toBe('');
    state.ban = { data: { tradeDate: '2026-11-23', fetchedAt: null, symbols: ['APLAPOLLO'] } };
    expect(renderToStaticMarkup(<FnoBanBadge symbol="APLAPOLLO" />)).toBe('');
  });
});

describe('ParticipantPositions', () => {
  it('renders signed contract counts, and a dash for unknown values', () => {
    state.oi = { data: { date: '2026-11-25', prevDate: '2026-11-24', fetchedAt: null, rows: [
      { participant: 'FII', idxFutNet: -85230, idxFutNetChange: 1200, idxFutLongPct: 23.8, stkFutNet: 857076, stkFutNetChange: null, idxCallNet: -122123, idxPutNet: null },
    ] } };
    const html = renderToStaticMarkup(<ParticipantPositions />);
    expect(html).toContain('-85,230');
    expect(html).toContain('+1,200');
    expect(html).toContain('23.8%');
    expect(html).toContain('contracts');
    expect(html).toContain('—');
    expect(html).toContain('2026-11-25');
  });

  it('says unavailable on a failed read', () => {
    state.oi = { isError: true };
    expect(renderToStaticMarkup(<ParticipantPositions />)).toContain('Could not load');
  });
});

describe('CompanyAnnouncements', () => {
  const row = { seq_id: '1', symbol: 'TCS', category: 'Press Release', summary: '<b>order</b> win', disseminated_at: '2026-11-25T14:12:00Z', fetched_at: '2026-11-25T14:20:00Z' };

  it('links an https filing, shows the summary as text and the capture time', () => {
    state.ann = { data: [{ ...row, attachment_url: 'https://nsearchives.nseindia.in/corporate/a.pdf' }] };
    const html = renderToStaticMarkup(<CompanyAnnouncements />);
    expect(html).toContain('href="https://nsearchives.nseindia.in/corporate/a.pdf"');
    expect(html).toContain('&lt;b&gt;order');
    expect(html).toContain('captured');
  });

  it('never links a non-http attachment', () => {
    state.ann = { data: [{ ...row, attachment_url: 'javascript:alert(1)' }] };
    expect(renderToStaticMarkup(<CompanyAnnouncements symbol="TCS" />)).not.toContain('javascript:');
  });

  it('distinguishes a failed read from no filings', () => {
    state.ann = { data: [] };
    expect(renderToStaticMarkup(<CompanyAnnouncements symbol="TCS" />)).toContain('No NSE filings stored');
    state.ann = { isError: true };
    expect(renderToStaticMarkup(<CompanyAnnouncements symbol="TCS" />)).toContain('Could not load');
  });
});
