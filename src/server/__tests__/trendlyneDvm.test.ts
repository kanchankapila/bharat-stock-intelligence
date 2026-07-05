import { vi, test, expect, beforeEach } from 'vitest';

const mockDbGet = vi.fn();
vi.mock('../dbAsync', () => ({
  dbGet: mockDbGet,
}));
vi.mock('../stockMapping', () => ({
  getStockMapping: vi.fn().mockReturnValue(undefined),
}));
vi.mock('../trendlyneAuthService', () => ({
  fetchTrendlyneWithAuth: vi.fn(),
}));
vi.mock('../cacheService', () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn(),
}));

const { getTrendlyneDVMFromDb } = await import('../trendlyneService');

beforeEach(() => {
  mockDbGet.mockClear();
});

test('returns null when no row exists', async () => {
  mockDbGet.mockResolvedValue(undefined);
  const result = await getTrendlyneDVMFromDb('INFY');
  expect(result).toBeNull();
});

test('returns null when all three scores are null', async () => {
  mockDbGet.mockResolvedValue({ d_score: null, v_score: null, m_score: null, d_color: null, v_color: null, m_color: null });
  const result = await getTrendlyneDVMFromDb('INFY');
  expect(result).toBeNull();
});

test('maps a full row to the durability/valuation/momentum shape', async () => {
  mockDbGet.mockResolvedValue({ d_score: 72, v_score: 45, m_score: 88, d_color: 'green', v_color: 'yellow', m_color: 'green' });
  const result = await getTrendlyneDVMFromDb('INFY');
  expect(result).toEqual({
    durability: { score: 72, color: 'green' },
    valuation: { score: 45, color: 'yellow' },
    momentum: { score: 88, color: 'green' },
  });
});

test('maps a partial row (one leg missing) correctly', async () => {
  mockDbGet.mockResolvedValue({ d_score: 72, v_score: null, m_score: 88, d_color: 'green', v_color: null, m_color: 'green' });
  const result = await getTrendlyneDVMFromDb('INFY');
  expect(result).toEqual({
    durability: { score: 72, color: 'green' },
    valuation: null,
    momentum: { score: 88, color: 'green' },
  });
});

test('uppercases the symbol before querying', async () => {
  mockDbGet.mockResolvedValue(undefined);
  await getTrendlyneDVMFromDb('infy');
  expect(mockDbGet).toHaveBeenCalledWith(expect.any(String), ['INFY']);
});
