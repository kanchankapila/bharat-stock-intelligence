import { describe, it, expect } from 'vitest';
import { companyAliases, buildAliasIndex, extractSymbolsByName } from '../newsEntityTagger';

describe('companyAliases', () => {
  it('strips legal suffixes', () => {
    expect(companyAliases('Infosys Limited')).toEqual(['Infosys']);
    expect(companyAliases('Bajaj Auto Ltd')).toEqual(['Bajaj Auto']);
  });
  it('drops parentheticals like (India)', () => {
    expect(companyAliases('Alphageo (India) Limited')).toEqual(['Alphageo']);
  });
  it('keeps meaningful multi-word names', () => {
    expect(companyAliases('Reliance Industries Limited')).toEqual(['Reliance Industries']);
    expect(companyAliases('HDFC Bank Limited')).toEqual(['HDFC Bank']);
  });
  it('skips a single generic word that would mass-false-match', () => {
    expect(companyAliases('Power Limited')).toEqual([]);
    expect(companyAliases('India Limited')).toEqual([]);
  });
});

describe('extractSymbolsByName', () => {
  const stocks = [
    { symbol: 'INFY',       name: 'Infosys Limited' },
    { symbol: 'HDFCBANK',   name: 'HDFC Bank Limited' },
    { symbol: 'BAJAJ-AUTO', name: 'Bajaj Auto Limited' },
    { symbol: 'RELIANCE',   name: 'Reliance Industries Limited' },
  ];
  const idx = buildAliasIndex(stocks, { TCS: ['TCS'] });

  it('tags by company NAME, not the ticker (the core fix)', () => {
    // Old ticker-match would miss all of these — prose never writes "INFY"/"HDFCBANK"/"BAJAJ-AUTO".
    expect(extractSymbolsByName('Infosys posted a strong Q1; margins improved', idx)).toEqual(['INFY']);
    expect(extractSymbolsByName('HDFC Bank raised deposit rates today', idx)).toEqual(['HDFCBANK']);
    expect(extractSymbolsByName('Bajaj Auto monthly sales rose 12%', idx)).toEqual(['BAJAJ-AUTO']);
  });

  it('honors word boundaries (no substring false hits)', () => {
    // "Reliance" must not fire on "self-reliance" mid-word, and Infosys must be whole-word
    expect(extractSymbolsByName('a story about self-reliance and grit', idx)).toEqual([]);
  });

  it('picks up curated short forms', () => {
    const i2 = buildAliasIndex([{ symbol: 'TCS', name: 'Tata Consultancy Services Limited' }], { TCS: ['TCS'] });
    expect(extractSymbolsByName('TCS wins a large deal', i2)).toContain('TCS');
  });

  it('returns empty when no company is named', () => {
    expect(extractSymbolsByName('Nifty ends flat as FII flows stay muted', idx)).toEqual([]);
  });

  it('caps the number of tags', () => {
    const txt = 'Infosys, HDFC Bank, Bajaj Auto and Reliance Industries all gained';
    expect(extractSymbolsByName(txt, idx, 2)).toHaveLength(2);
  });
});

describe('sibling companies whose names differ only in brackets (AF-20261105-05)', () => {
  const idx = buildAliasIndex([
    { symbol: 'ASIANHOTNR', name: 'Asian Hotels (North) Limited' },
    { symbol: 'AHLEAST', name: 'Asian Hotels (East) Limited' },
    { symbol: 'AHLWEST', name: 'Asian Hotels (West) Limited' },
    { symbol: 'ALPHAGEO', name: 'Alphageo (India) Limited' },
  ]);

  it('tags only the company named', () => {
    expect(extractSymbolsByName('Asian Hotels (East) Ltd: Board Meeting', idx)).toEqual(['AHLEAST']);
  });

  it('does not guess when the text names only the shared part', () => {
    expect(extractSymbolsByName('Asian Hotels shares rise', idx)).toEqual([]);
  });

  it('still drops a bracket that does not distinguish a sibling', () => {
    expect(extractSymbolsByName('Alphageo wins contract', idx)).toEqual(['ALPHAGEO']);
  });
});
