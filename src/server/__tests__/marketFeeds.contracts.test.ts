import { describe, expect, it } from 'vitest';
import {
  parseMcAdRatioCategoryResponse,
  parseMcScannerDetailResponse,
  parseMcSectorPerformanceResponse,
  parseMcSectorStocksResponse,
  parseNtOptionChainResponse,
  parseNtOiPcrResponse,
} from '../contracts/marketFeeds';

describe('marketFeeds contracts', () => {
  it('parses MoneyControl scanner-detail payload', () => {
    const parsed = parseMcScannerDetailResponse({
      success: 1,
      data: {
        list: {
          scannerName: 'Double Dhamaka',
          scannerDescription: 'desc',
          scannerDetails: [
            { stkname: 'ABC', stkId: 'AB01', columns: [{ name: 'LTP', value: '123.4' }] },
          ],
        },
      },
    });

    expect(parsed.success).toBe(1);
    expect(parsed.data?.list.scannerName).toBe('Double Dhamaka');
    expect(parsed.data?.list.scannerDetails[0].stkId).toBe('AB01');
  });

  it('parses sector performance rows', () => {
    const parsed = parseMcSectorPerformanceResponse({
      success: 1,
      data: [{ sector: 'Finance', mcapPerChange: '1.24' }],
    });
    expect(parsed.success).toBe(1);
    expect(parsed.data).toHaveLength(1);
    expect(parsed.data[0].mcapPerChange).toBe(1.24);
  });

  it('parses sector stocks payload', () => {
    const parsed = parseMcSectorStocksResponse({
      success: 1,
      data: {
        name: 'Finance',
        baseUrl: '/stocks',
        data: [
          {
            stockName: 'HDFC Bank',
            scId: 'HDF01',
            currPrice: '1987.2',
            perChange: '0.4',
            marketCap: 'Large',
            ttmEPS: '34.1',
            debtToEq: '0.3',
            techTrend: 'Bullish',
            slug: 'hdfc-bank',
          },
        ],
      },
    });

    expect(parsed.success).toBe(1);
    expect(parsed.data?.data[0].currPrice).toBe(1987.2);
    expect(parsed.data?.data[0].slug).toBe('hdfc-bank');
  });

  it('parses advance/decline category rows', () => {
    const parsed = parseMcAdRatioCategoryResponse({
      success: 1,
      data: [
        {
          bridgeSymbol: 'in;NSX',
          indexId: '9',
          indexName: 'NIFTY 50',
          advance: '31',
          decline: '19',
          ltp: '25000.3',
          change: '-25.8',
          changePer: '-0.10',
          lastUpdated: '2026-08-06 10:00:00',
        },
      ],
    });

    expect(parsed.success).toBe(1);
    expect(parsed.data[0].advance).toBe(31);
    expect(parsed.data[0].changePer).toBe(-0.1);
  });

  it('parses NiftyTrader option-chain payload and normalizes opDatas', () => {
    const parsed = parseNtOptionChainResponse({
      result: 1,
      resultMessage: 'OK',
      resultData: {
        optionChain: [
          {
            strike_price: 25000,
            expiry_date: '2026-08-27',
            calls_oi: '1000',
            puts_oi: '1200',
            calls_ltp: '120',
            puts_ltp: '110',
          },
        ],
        opTotals: { total_calls_puts: { total_calls_oi: '1000', total_puts_oi: '1200', volume_pcr: '1.2' } },
      },
    });

    expect(parsed.result).toBe(1);
    expect(parsed.resultData?.opDatas).toHaveLength(1);
    expect(parsed.resultData?.opDatas[0].calls_oi).toBe(1000);
    expect(parsed.resultData?.opTotals.total_calls_puts.volume_pcr).toBe(1.2);
  });

  it('returns failure shape for invalid payloads', () => {
    expect(parseMcSectorPerformanceResponse({ success: 0 }).success).toBe(0);
    expect(parseNtOptionChainResponse({ result: 0 }).result).toBe(0);
  });

  it('parses NiftyTrader OI-PCR payload', () => {
    const parsed = parseNtOiPcrResponse({
      result: 1,
      resultMessage: 'OK',
      resultData: {
        oiExpiryDates: ['2026-08-27T00:00:00'],
        oiDatas: [
          {
            time: '2026-08-06 10:00:00',
            expiry_date: '2026-08-27',
            pcr: '1.04',
            volume_pcr: '0.92',
            change_oi_pcr: '1.11',
            index_close: '25100.25',
          },
        ],
      },
    });

    expect(parsed.result).toBe(1);
    expect(parsed.resultData?.oiExpiryDates).toHaveLength(1);
    expect(parsed.resultData?.oiDatas[0].pcr).toBe(1.04);
  });
});
