type UnknownRecord = Record<string, unknown>;

function isRecord(v: unknown): v is UnknownRecord {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function toStringOr(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function toNumberOr(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/,/g, ''));
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

function toArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export interface McScannerDetailRow {
  stkname: string;
  stkId: string;
  columns: Array<{ name: string; value: string }>;
}

export interface McScannerDetailResponse {
  success: number;
  data: {
    list: {
      scannerName: string;
      scannerDescription: string;
      scannerDetails: McScannerDetailRow[];
    };
  } | null;
}

export function parseMcScannerDetailResponse(raw: unknown): McScannerDetailResponse {
  if (!isRecord(raw) || toNumberOr(raw.success, 0) !== 1 || !isRecord(raw.data)) {
    return { success: 0, data: null };
  }

  const list = isRecord(raw.data.list) ? raw.data.list : {};
  const scannerDetails = toArray(list.scannerDetails).map((row) => {
    const r = isRecord(row) ? row : {};
    const columns = toArray(r.columns).map((col) => {
      const c = isRecord(col) ? col : {};
      return {
        name: toStringOr(c.name),
        value: toStringOr(c.value),
      };
    });
    return {
      stkname: toStringOr(r.stkname || r.stock_name || r.shortName),
      stkId: toStringOr(r.stkId || r.sc_id),
      columns,
    };
  });

  return {
    success: 1,
    data: {
      list: {
        scannerName: toStringOr(list.scannerName || raw.data.scanName || raw.data.scanname),
        scannerDescription: toStringOr(list.scannerDescription),
        scannerDetails,
      },
    },
  };
}

export interface McSectorPerformanceRow {
  sector: string;
  mcapPerChange: number;
}

export interface McSectorPerformanceResponse {
  success: number;
  data: McSectorPerformanceRow[];
}

export function parseMcSectorPerformanceResponse(raw: unknown): McSectorPerformanceResponse {
  if (!isRecord(raw) || toNumberOr(raw.success, 0) !== 1) {
    return { success: 0, data: [] };
  }

  const rows = toArray(raw.data).map((row) => {
    const r = isRecord(row) ? row : {};
    return {
      sector: toStringOr(r.sector),
      mcapPerChange: toNumberOr(r.mcapPerChange),
    };
  });

  return { success: 1, data: rows };
}

export interface McSectorStocksRow {
  stockName: string;
  scId: string;
  currPrice: number;
  perChange: number;
  marketCap: string;
  ttmEPS: string;
  debtToEq: string;
  techTrend: string;
  slug: string;
}

export interface McSectorStocksResponse {
  success: number;
  data: {
    name: string;
    baseUrl: string;
    data: McSectorStocksRow[];
  } | null;
}

export function parseMcSectorStocksResponse(raw: unknown): McSectorStocksResponse {
  if (!isRecord(raw) || toNumberOr(raw.success, 0) !== 1 || !isRecord(raw.data)) {
    return { success: 0, data: null };
  }
  const d = raw.data;
  return {
    success: 1,
    data: {
      name: toStringOr(d.name),
      baseUrl: toStringOr(d.baseUrl),
      data: toArray(d.data).map((row) => {
        const r = isRecord(row) ? row : {};
        return {
          stockName: toStringOr(r.stockName),
          scId: toStringOr(r.scId),
          currPrice: toNumberOr(r.currPrice),
          perChange: toNumberOr(r.perChange),
          marketCap: toStringOr(r.marketCap),
          ttmEPS: toStringOr(r.ttmEPS),
          debtToEq: toStringOr(r.debtToEq),
          techTrend: toStringOr(r.techTrend),
          slug: toStringOr(r.slug),
        };
      }),
    },
  };
}

export interface McAdRatioCategoryRow {
  bridgeSymbol: string;
  indexId: string;
  indexName: string;
  advance: number;
  decline: number;
  ltp: number;
  change: number;
  changePer: number;
  lastUpdated: string;
}

export interface McAdRatioCategoryResponse {
  success: number;
  data: McAdRatioCategoryRow[];
}

export function parseMcAdRatioCategoryResponse(raw: unknown): McAdRatioCategoryResponse {
  if (!isRecord(raw) || toNumberOr(raw.success, 0) !== 1) {
    return { success: 0, data: [] };
  }

  const rows = toArray(raw.data).map((row) => {
    const r = isRecord(row) ? row : {};
    return {
      bridgeSymbol: toStringOr(r.bridgeSymbol),
      indexId: toStringOr(r.indexId),
      indexName: toStringOr(r.indexName),
      advance: toNumberOr(r.advance),
      decline: toNumberOr(r.decline),
      ltp: toNumberOr(r.ltp),
      change: toNumberOr(r.change),
      changePer: toNumberOr(r.changePer),
      lastUpdated: toStringOr(r.lastUpdated),
    };
  });

  return { success: 1, data: rows };
}

export interface NtOptionChainRow {
  strike_price: number;
  expiry_date: string;
  index_close: number;
  last_price: number;
  calls_oi: number;
  calls_change_oi: number;
  calls_ltp: number;
  calls_volume: number;
  calls_iv: number;
  calls_builtup: string;
  calls_bid_price: number;
  calls_ask_price: number;
  puts_oi: number;
  puts_change_oi: number;
  puts_ltp: number;
  puts_volume: number;
  puts_iv: number;
  puts_builtup: string;
  puts_bid_price: number;
  puts_ask_price: number;
  call_delta: number;
  call_theta: number;
  call_vega: number;
  call_gamma: number;
  put_delta: number;
  put_theta: number;
  put_vega: number;
  put_gamma: number;
}

export interface NtOptionChainTotals {
  total_calls_oi: number;
  total_puts_oi: number;
  volume_pcr: number;
}

export interface NtOptionChainResponse {
  result: number;
  resultMessage: string;
  resultData: {
    opDatas: NtOptionChainRow[];
    expiryDates: string[];
    spotPrice: number;
    opTotals: { total_calls_puts: NtOptionChainTotals };
  } | null;
}

export function parseNtOptionChainResponse(raw: unknown): NtOptionChainResponse {
  if (!isRecord(raw) || toNumberOr(raw.result, 0) !== 1 || !isRecord(raw.resultData)) {
    return {
      result: 0,
      resultMessage: toStringOr(isRecord(raw) ? raw.resultMessage : undefined, 'invalid-response'),
      resultData: null,
    };
  }

  const rd = raw.resultData;
  const opDatasRaw = toArray(rd.opDatas || rd.optionChain);
  const opDatas: NtOptionChainRow[] = opDatasRaw.map((row) => {
    const r = isRecord(row) ? row : {};
    return {
      strike_price: toNumberOr(r.strike_price),
      expiry_date: toStringOr(r.expiry_date),
      index_close: toNumberOr(r.index_close),
      last_price: toNumberOr(r.last_price),
      calls_oi: toNumberOr(r.calls_oi),
      calls_change_oi: toNumberOr(r.calls_change_oi),
      calls_ltp: toNumberOr(r.calls_ltp),
      calls_volume: toNumberOr(r.calls_volume),
      calls_iv: toNumberOr(r.calls_iv),
      calls_builtup: toStringOr(r.calls_builtup),
      calls_bid_price: toNumberOr(r.calls_bid_price),
      calls_ask_price: toNumberOr(r.calls_ask_price),
      puts_oi: toNumberOr(r.puts_oi),
      puts_change_oi: toNumberOr(r.puts_change_oi),
      puts_ltp: toNumberOr(r.puts_ltp),
      puts_volume: toNumberOr(r.puts_volume),
      puts_iv: toNumberOr(r.puts_iv),
      puts_builtup: toStringOr(r.puts_builtup),
      puts_bid_price: toNumberOr(r.puts_bid_price),
      puts_ask_price: toNumberOr(r.puts_ask_price),
      call_delta: toNumberOr(r.call_delta),
      call_theta: toNumberOr(r.call_theta),
      call_vega: toNumberOr(r.call_vega),
      call_gamma: toNumberOr(r.call_gamma),
      put_delta: toNumberOr(r.put_delta),
      put_theta: toNumberOr(r.put_theta),
      put_vega: toNumberOr(r.put_vega),
      put_gamma: toNumberOr(r.put_gamma),
    };
  });

  const totalsRaw = isRecord(rd.opTotals) && isRecord(rd.opTotals.total_calls_puts)
    ? rd.opTotals.total_calls_puts
    : {};

  return {
    result: 1,
    resultMessage: toStringOr(raw.resultMessage, 'ok'),
    resultData: {
      opDatas,
      expiryDates: toArray(rd.expiryDates).map((d) => toStringOr(d)).filter(Boolean),
      spotPrice: toNumberOr(rd.spotPrice),
      opTotals: {
        total_calls_puts: {
          total_calls_oi: toNumberOr(totalsRaw.total_calls_oi),
          total_puts_oi: toNumberOr(totalsRaw.total_puts_oi),
          volume_pcr: toNumberOr(totalsRaw.volume_pcr),
        },
      },
    },
  };
}

export interface NtOiPcrPoint {
  time: string;
  expiry_date: string;
  pcr: number;
  volume_pcr: number;
  change_oi_pcr: number;
  index_close: number;
}

export interface NtOiPcrResponse {
  result: number;
  resultMessage: string;
  resultData: {
    oiExpiryDates: string[];
    oiDatas: NtOiPcrPoint[];
  } | null;
}

export function parseNtOiPcrResponse(raw: unknown): NtOiPcrResponse {
  if (!isRecord(raw) || toNumberOr(raw.result, 0) !== 1 || !isRecord(raw.resultData)) {
    return {
      result: 0,
      resultMessage: toStringOr(isRecord(raw) ? raw.resultMessage : undefined, 'invalid-response'),
      resultData: null,
    };
  }

  const rd = raw.resultData;
  const points: NtOiPcrPoint[] = toArray(rd.oiDatas).map((row) => {
    const r = isRecord(row) ? row : {};
    return {
      time: toStringOr(r.time),
      expiry_date: toStringOr(r.expiry_date),
      pcr: toNumberOr(r.pcr),
      volume_pcr: toNumberOr(r.volume_pcr),
      change_oi_pcr: toNumberOr(r.change_oi_pcr),
      index_close: toNumberOr(r.index_close),
    };
  });

  return {
    result: 1,
    resultMessage: toStringOr(raw.resultMessage, 'ok'),
    resultData: {
      oiExpiryDates: toArray(rd.oiExpiryDates).map((d) => toStringOr(d)).filter(Boolean),
      oiDatas: points,
    },
  };
}