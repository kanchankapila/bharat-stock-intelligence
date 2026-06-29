import { writeFile } from 'node:fs/promises';

type WireEntry = {
  field: number;
  wireType: number;
  value?: number | bigint;
  bytes?: Uint8Array;
};

type MarketStatsArgs = {
  category: string;
  type: string;
  view: string;
  deviceType: string;
  appVersion: string;
  exchange: string;
  indexId: string;
  duration: string;
  page: string;
  fields: string;
  stockLabel: string;
  sortBy: string;
  orderBy: string;
  hour: string;
  output?: string;
  raw: boolean;
};

const DEFAULT_ARGS: MarketStatsArgs = {
  category: 'gainers',
  type: 'hourly_gainers',
  view: 'overview',
  deviceType: 'W',
  appVersion: '180',
  exchange: 'N',
  indexId: '7',
  duration: '1d',
  page: '1',
  fields: '',
  stockLabel: 'true',
  sortBy: 'gainPer',
  orderBy: 'desc',
  hour: '7',
  raw: false,
};

const ROW_FIELD_NAMES: Record<number, string> = {
  1: 'shortName',
  2: 'stockName',
  3: 'currentPrice',
  4: 'stockPath',
  5: 'exchangeCode',
  6: 'tickerWithExchange',
  7: 'displayChangePercent',
  8: 'displayChange',
  9: 'high',
  10: 'low',
  13: 'currentHour',
  14: 'endHour',
  15: 'hour',
  16: 'volume',
  17: 'referencePrice',
  20: 'analysis',
  21: 'lastUpdated',
  22: 'isActive',
  24: 'nseSymbol',
  25: 'exchange',
  26: 'moneycontrolUrl',
  27: 'stockId',
  28: 'hourlyChange',
  29: 'hourlyGainPercent',
  37: 'deliveryVolume',
  39: 'previousReferencePrice',
  40: 'absoluteChange',
  41: 'percentChange',
  48: 'oneDayChange',
  49: 'oneWeekChange',
  50: 'instrumentType',
  51: 'tradedVolume',
  52: 'deliveryPercent',
  53: 'lastTradedPrice',
};

function parseArgs(argv: string[]): MarketStatsArgs {
  const args = { ...DEFAULT_ARGS };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const readValue = () => {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return next;
    };

    switch (arg) {
      case '--category':
        args.category = readValue();
        break;
      case '--type':
        args.type = readValue();
        break;
      case '--view':
        args.view = readValue();
        break;
      case '--index-id':
        args.indexId = readValue();
        break;
      case '--exchange':
        args.exchange = readValue();
        break;
      case '--duration':
        args.duration = readValue();
        break;
      case '--page':
        args.page = readValue();
        break;
      case '--fields':
        args.fields = readValue();
        break;
      case '--sort-by':
        args.sortBy = readValue();
        break;
      case '--order-by':
        args.orderBy = readValue();
        break;
      case '--hour':
        args.hour = readValue();
        break;
      case '--app-version':
        args.appVersion = readValue();
        break;
      case '--output':
        args.output = readValue();
        break;
      case '--raw':
        args.raw = true;
        break;
      case '--help':
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Fetch Moneycontrol market stats.

Usage:
  npm run fetch:mc-market-stats -- [options]

Options:
  --category <value>     Default: gainers
  --type <value>         Default: hourly_gainers
  --view <value>         Default: overview
  --index-id <value>     Default: 7
  --exchange <value>     Default: N
  --duration <value>     Default: 1d
  --page <value>         Default: 1
  --fields <csv>         Optional Moneycontrol fields query
  --sort-by <value>      Default: gainPer
  --order-by <value>     Default: desc
  --hour <value>         Default: 7
  --app-version <value>  Default: 180
  --output <path>        Write JSON to a file
  --raw                  Include decoded raw protobuf fields

Optional env:
  MONEYCONTROL_AUTH_TOKEN  Sent as auth-token when present; not required for the tested endpoint.
`);
}

function buildUrl(args: MarketStatsArgs) {
  const params = new URLSearchParams({
    deviceType: args.deviceType,
    appVersion: args.appVersion,
    ex: args.exchange,
    indexId: args.indexId,
    dur: args.duration,
    page: args.page,
    fields: args.fields,
    stocklbl: args.stockLabel,
    sortBy: args.sortBy,
    orderBy: args.orderBy,
    hour: args.hour,
  });

  return `https://api.moneycontrol.com/swiftapi/v1/markets/stats/${args.category}/${args.type}/${args.view}?${params}`;
}

function readVarint(buffer: Uint8Array, offset: { value: number }) {
  let result = 0n;
  let shift = 0n;

  while (offset.value < buffer.length) {
    const byte = BigInt(buffer[offset.value]);
    offset.value += 1;
    result |= (byte & 0x7fn) << shift;
    if ((byte & 0x80n) === 0n) return result;
    shift += 7n;
  }

  throw new Error('Invalid protobuf varint');
}

function readFixed(buffer: Uint8Array, offset: { value: number }, bytes: number) {
  if (offset.value + bytes > buffer.length) throw new Error('Invalid protobuf fixed-width value');
  let result = 0n;
  for (let i = 0; i < bytes; i += 1) {
    result |= BigInt(buffer[offset.value + i]) << BigInt(8 * i);
  }
  offset.value += bytes;
  return result;
}

function decodeMessage(buffer: Uint8Array): WireEntry[] {
  const offset = { value: 0 };
  const entries: WireEntry[] = [];

  while (offset.value < buffer.length) {
    const tag = Number(readVarint(buffer, offset));
    const field = tag >> 3;
    const wireType = tag & 7;

    if (wireType === 0) {
      const value = readVarint(buffer, offset);
      entries.push({ field, wireType, value: value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value });
    } else if (wireType === 1) {
      entries.push({ field, wireType, value: readFixed(buffer, offset, 8) });
    } else if (wireType === 2) {
      const length = Number(readVarint(buffer, offset));
      const end = offset.value + length;
      if (end > buffer.length) throw new Error('Invalid protobuf length-delimited value');
      entries.push({ field, wireType, bytes: buffer.slice(offset.value, end) });
      offset.value = end;
    } else if (wireType === 5) {
      entries.push({ field, wireType, value: readFixed(buffer, offset, 4) });
    } else {
      throw new Error(`Unsupported protobuf wire type: ${wireType}`);
    }
  }

  return entries;
}

function text(bytes: Uint8Array | undefined) {
  if (!bytes || bytes.length === 0) return '';
  return new TextDecoder().decode(bytes);
}

function decodeColumn(bytes: Uint8Array) {
  const entries = decodeMessage(bytes);
  return {
    label: text(entries.find((entry) => entry.field === 1)?.bytes),
    key: text(entries.find((entry) => entry.field === 2)?.bytes),
  };
}

function decodeRow(bytes: Uint8Array) {
  const row: Record<string, string | number | bigint> = {};
  const raw: Record<string, string | number | bigint> = {};

  for (const entry of decodeMessage(bytes)) {
    const value = entry.bytes ? text(entry.bytes) : entry.value ?? '';
    const rawKey = `field${entry.field}`;
    raw[rawKey] = value;
    row[ROW_FIELD_NAMES[entry.field] ?? rawKey] = value;
  }

  return { row, raw };
}

function decodeMarketStats(buffer: Uint8Array, includeRaw: boolean) {
  const root = decodeMessage(buffer);
  const payloadBytes = root.find((entry) => entry.field === 2)?.bytes;
  if (!payloadBytes) throw new Error('Moneycontrol response did not include a payload');

  const payload = decodeMessage(payloadBytes);
  const columns = payload
    .filter((entry) => entry.field === 1 && entry.bytes)
    .map((entry) => decodeColumn(entry.bytes!));

  const rows = payload
    .filter((entry) => entry.field === 2 && entry.bytes)
    .map((entry) => decodeRow(entry.bytes!));

  return {
    success: root.find((entry) => entry.field === 1)?.value === 1,
    columns,
    rows: rows.map(({ row, raw }) => (includeRaw ? { ...row, raw } : row)),
  };
}

async function fetchMarketStats(args: MarketStatsArgs) {
  const url = buildUrl(args);
  const headers: Record<string, string> = {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    referer: 'https://www.moneycontrol.com/',
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };

  if (process.env.MONEYCONTROL_AUTH_TOKEN) {
    headers['auth-token'] = process.env.MONEYCONTROL_AUTH_TOKEN;
  }

  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`Moneycontrol returned ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  const fetchedAt = new Date().toISOString();

  if (contentType.includes('application/json')) {
    return {
      url,
      fetchedAt,
      contentType,
      authTokenUsed: Boolean(process.env.MONEYCONTROL_AUTH_TOKEN),
      response: await response.json(),
    };
  }

  const buffer = new Uint8Array(await response.arrayBuffer());
  return {
    url,
    fetchedAt,
    contentType,
    authTokenUsed: Boolean(process.env.MONEYCONTROL_AUTH_TOKEN),
    ...decodeMarketStats(buffer, args.raw),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const data = await fetchMarketStats(args);
  const json = JSON.stringify(
    data,
    (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
    2
  );

  if (args.output) {
    await writeFile(args.output, `${json}\n`, 'utf8');
    console.log(`Wrote ${args.output}`);
  } else {
    console.log(json);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
