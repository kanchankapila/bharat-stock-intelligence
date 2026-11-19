import { vi, test, expect, beforeEach } from 'vitest';

// 2026-08-09 live audit: trendlyne_screener_stocks' PK is (screener_id, stock_id), and Trendlyne's
// own API declares stock_id as {"type":"number"} -- live-verified real values are plain integers
// (e.g. 59, 2999). 57,307 of 112,595 rows (50.9%) had a NON-numeric stock_id (often the resolved
// NSE symbol itself, e.g. "ALLCARGO") landing as a SEPARATE row instead of updating the real
// numeric-ID one, silently doubling every screener-count-based signal downstream. This test pins
// saveScreenerStocksToDB's guard: a non-numeric stockId must never be upserted.

const dbAllMock = vi.fn();
const dbTransactionMock = vi.fn();
const dbRunMock = vi.fn();

vi.mock('../dbAsync', () => ({
  dbGet: vi.fn(),
  dbAll: dbAllMock,
  dbRun: dbRunMock,
  dbTransaction: dbTransactionMock,
}));
vi.mock('../stockMapping', () => ({
  getStockMapping: vi.fn((q: string) => (/^\d+$/.test(q) ? { symbol: 'REALSYM' } : undefined)),
  getStockMappingByTLId: vi.fn().mockReturnValue(undefined),
  getStockMappingByName: vi.fn().mockReturnValue(undefined),
}));

const { saveScreenerStocksToDB } = await import('../trendlyneScreener');

function makeTx() {
  const all = vi.fn().mockResolvedValue([]); // no pre-existing rows to remove
  const run = vi.fn().mockResolvedValue(undefined);
  return { all, run };
}

beforeEach(() => {
  dbAllMock.mockReset().mockResolvedValue([]); // screener_appearances snapshot
  dbRunMock.mockReset();
  dbTransactionMock.mockReset();
});

test('a non-numeric stockId (e.g. the NSE symbol itself) is never upserted', async () => {
  const tx = makeTx();
  dbTransactionMock.mockImplementation(async (cb: any) => cb(tx));

  await saveScreenerStocksToDB('cci-overbought', [
    { stockId: '59', name: 'Allcargo Logistics Ltd.' },   // valid: purely numeric
    { stockId: 'ALLCARGO', name: 'Allcargo Logistics Ltd.' }, // invalid: the symbol itself
  ]);

  // Only the INSERT/upsert into trendlyne_screener_stocks itself is in scope here (the
  // screener_appearances/history diff-patch calls elsewhere are a separate concern) --
  // exactly one such call, and it carries the real numeric stockId, never the symbol.
  const upsertCalls = tx.run.mock.calls.filter((c: any[]) => String(c[0]).includes('INSERT INTO trendlyne_screener_stocks'));
  expect(upsertCalls).toHaveLength(1);
  expect(upsertCalls[0][1]).toEqual(['cci-overbought', '59', 'REALSYM', expect.any(String), expect.any(String)]);
  expect(tx.run.mock.calls.some((c: any[]) => c[1]?.includes('ALLCARGO'))).toBe(false);
});

test('an all-invalid batch upserts nothing but does not throw', async () => {
  const tx = makeTx();
  dbTransactionMock.mockImplementation(async (cb: any) => cb(tx));

  await expect(
    saveScreenerStocksToDB('some-screener', [
      { stockId: 'FOO', name: 'Foo Ltd.' },
      { stockId: 'BAR-1', name: 'Bar Ltd.' },
    ])
  ).resolves.not.toThrow();

  expect(tx.run).not.toHaveBeenCalled();
});

test('a stale non-numeric row already in the DB is removed on the next sync', async () => {
  const tx = makeTx();
  // Simulate a prior bad row (stock_id='ALLCARGO') plus a good one (stock_id='59') already stored.
  tx.all.mockResolvedValue([{ stock_id: 'ALLCARGO' }, { stock_id: '59' }]);
  dbTransactionMock.mockImplementation(async (cb: any) => cb(tx));

  await saveScreenerStocksToDB('cci-overbought', [
    { stockId: '59', name: 'Allcargo Logistics Ltd.' },
  ]);

  const deleteCalls = tx.run.mock.calls.filter((c: any[]) => String(c[0]).includes('DELETE'));
  expect(deleteCalls.some((c: any[]) => c[1][1] === 'ALLCARGO')).toBe(true);
});

// AF-20261119-04: getStockMapping resolves a Trendlyne id only through stocklist.ts (2,000 names),
// so 40,196 of 81,488 numeric-id rows were stored with symbol NULL and only the (now removed)
// symbol-keyed duplicates from trendlyne_screener_discovery.py carried those members. Every
// screener row carries the exchange's own NSEcode; it is the symbol.
test('the row\'s own NSE symbol is stored, not a stocklist lookup that misses unmapped ids', async () => {
  const tx = makeTx();
  dbTransactionMock.mockImplementation(async (cb: any) => cb(tx));

  await saveScreenerStocksToDB('adx-mild', [{ stockId: '2106579', name: 'JG Chemicals Ltd.', symbol: 'JGCHEM' }]);

  const upsert = tx.run.mock.calls.find((c: any[]) => String(c[0]).includes('INSERT INTO trendlyne_screener_stocks'));
  expect(upsert![1]).toEqual(['adx-mild', '2106579', 'JGCHEM', expect.any(String), expect.any(String)]);
});

test('fetchTrendlyneScreenerData takes the symbol from the NSEcode column', async () => {
  const { fetchTrendlyneScreenerData } = await import('../trendlyneScreener');
  const headers = ['get_full_name', 'NSEcode', 'stock_id', 'currentPrice'].map(unique_name => ({ unique_name }));
  const body = { head: { status: '0' }, body: { screenObj: { title: 'ADX' }, tableHeaders: headers,
    tableData: [['JG Chemicals Ltd.', 'JGCHEM', 2106579, 412.5], ['Bse Only Ltd.', '', 99, 10]] } };
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
  try {
    const res = await fetchTrendlyneScreenerData('756513', 'ADX', 0, true);
    expect(res.data.map(s => [s.stockId, s.symbol])).toEqual([['2106579', 'JGCHEM'], ['99', undefined]]);
  } finally {
    fetchSpy.mockRestore();
  }
});

test('a canonically mapped id keeps our symbol when Trendlyne\'s NSEcode differs (LTM vs LTIM)', async () => {
  const { fetchTrendlyneScreenerData } = await import('../trendlyneScreener');
  const { getStockMappingByTLId } = await import('../stockMapping');
  vi.mocked(getStockMappingByTLId).mockImplementation((id: string) => (id === '4596' ? { symbol: 'LTIM' } as any : undefined));
  const headers = ['get_full_name', 'NSEcode', 'stock_id'].map(unique_name => ({ unique_name }));
  const body = { head: { status: '0' }, body: { screenObj: { title: 'X' }, tableHeaders: headers,
    tableData: [['LTIMindtree Ltd.', 'LTM', 4596]] } };
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
  try {
    const res = await fetchTrendlyneScreenerData('1', 'X', 0, true);
    expect(res.data[0].symbol).toBe('LTIM');
  } finally {
    fetchSpy.mockRestore();
    vi.mocked(getStockMappingByTLId).mockReturnValue(undefined);
  }
});
