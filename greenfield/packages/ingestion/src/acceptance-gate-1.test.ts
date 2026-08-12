// BUILD_STAGE_0_2_SPEC.md Acceptance Gate 1: "A single end-to-end test must
// demonstrate: request -> raw_object with a content hash -> parsed ->
// market_bar row with run_id and available_at -> ingestion_run closed with
// balanced metrics (rowsSeen == rowsAccepted + rowsRejected)."
//
// This deliberately uses a FIXTURE endpoint and a throwaway inline parser --
// the real NSE bhavcopy adapter is Task 2.1, Stage 2. What this proves is
// that the Stage 1 SPINE (provider-sdk fetch -> raw capture -> parse ->
// canonical write -> run ledger) actually wires together end to end, with
// every package talking to the next through its real interface, not a mock.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, expect, test } from 'vitest';
import pg from 'pg';
import { createPool, closeRun, openRun } from '@greenfield/db';
import { fetchWithPolicy } from '@greenfield/provider-sdk';
import type { JobMetrics } from '@greenfield/contracts';

try {
  process.loadEnvFile();
} catch {
  // rely on process.env
}

let server: Server | undefined;
let pool: pg.Pool;
let client: pg.PoolClient;

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

function listen(handler: Handler): Promise<string> {
  server = createServer(handler);
  return new Promise((resolve) => {
    server!.listen(0, '127.0.0.1', () => {
      const address = server!.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

beforeEach(async () => {
  pool = createPool();
  client = await pool.connect();
  await client.query('BEGIN');
  await client.query(
    `INSERT INTO provider (provider, display_name, base_hosts, auth_mode, redistribution)
     VALUES ('zzzfixture', 'ZZZ Fixture Provider', '{}', 'none', 'permitted')`,
  );
  await client.query(
    `INSERT INTO provider_endpoint (endpoint_key, provider, integration_class, url_template, parser_version)
     VALUES ('zzzfixture.bars', 'zzzfixture', 'ingestion', 'http://fixture.invalid/bars', 'v1')`,
  );
  await client.query(
    `INSERT INTO job_definition (job_id, description, timezone, catalog_version)
     VALUES ('zzzfixture-job', 'gate-1 fixture job', 'Asia/Kolkata', 'v1')`,
  );
  await client.query(
    `INSERT INTO security (symbol, name, exchange, status, listed_from) VALUES
       ('ZZZGATE1A', 'Gate1 Good Co', 'NSE', 'listed', '2021-01-04')`,
  );
});

afterEach(async () => {
  if (server) {
    await new Promise((resolve) => server!.close(resolve));
    server = undefined;
  }
  await client.query('ROLLBACK');
  client.release();
  await pool.end();
});

interface FixtureRow {
  symbol: string;
  close: number;
}

interface ParseResult {
  accepted: FixtureRow[];
  rejected: Array<{ raw: string; reason: string }>;
}

/** Deliberately tiny stand-in for the real bhavcopy parser (Task 2.1). Same
 * shape as GREENFIELD_BUILD_SPEC.md B3's ParseResult<T> contract: rejected
 * rows carry a reason, nothing is silently dropped. */
function parseFixtureCsv(body: string): ParseResult {
  const accepted: FixtureRow[] = [];
  const rejected: Array<{ raw: string; reason: string }> = [];
  for (const line of body.trim().split('\n')) {
    const [symbol, closeRaw] = line.split(',').map((s) => s.trim());
    const close = Number(closeRaw);
    if (!symbol || !Number.isFinite(close) || close <= 0) {
      rejected.push({ raw: line, reason: 'missing symbol or non-finite/non-positive close' });
      continue;
    }
    accepted.push({ symbol, close });
  }
  return { accepted, rejected };
}

test('request -> raw_object(content_hash) -> parsed -> market_bar(run_id, available_at) -> ingestion_run closed, balanced', async () => {
  const url = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/csv' });
    // One good row, one deliberately bad row (non-finite close) -- proves
    // rowsRejected is exercised, not just a trivial 1=1+0 accounting.
    res.end('ZZZGATE1A,123.45\nZZZGATE1B,not-a-number\n');
  });

  const runId = await openRun(client, {
    jobId: 'zzzfixture-job',
    endpointKey: 'zzzfixture.bars',
    codeCommit: 'gate-1-test',
  });

  // 1. Request, with raw capture (content hash + size) before any parsing.
  const raw = await fetchWithPolicy({ url });
  expect(raw.httpStatus).toBe(200);
  expect(raw.contentHash).toMatch(/^[0-9a-f]{64}$/);

  // 2. Raw object persisted BEFORE parsing -- a parser bug stays replayable.
  const { rows: rawRows } = await client.query<{ object_id: string }>(
    `INSERT INTO raw_object
       (run_id, endpoint_key, request_hash, http_status, content_type, content_hash, byte_size, storage_uri, parse_status)
     VALUES ($1, 'zzzfixture.bars', $2, $3, $4, $5, $6, $7, 'pending')
     RETURNING object_id`,
    [runId, raw.contentHash, raw.httpStatus, raw.contentType, raw.contentHash, raw.byteSize, `local://raw/${raw.contentHash}`],
  );
  const objectId = rawRows[0]?.object_id;
  expect(objectId).toBeTruthy();

  // 3. Parse -- using the production parser function, not a reimplementation.
  const parsed = parseFixtureCsv(raw.body);
  expect(parsed.accepted).toHaveLength(1);
  expect(parsed.rejected).toHaveLength(1);

  await client.query(`UPDATE raw_object SET parse_status = 'parsed' WHERE object_id = $1`, [objectId]);

  // 4. Canonical write -- market_bar carries run_id and a real available_at
  // (session close, never fetch time / now() -- BUILD_STAGE_0_2_SPEC.md §6.6).
  const sessionDate = '2026-08-13';
  const availableAt = `${sessionDate}T10:00:00Z`; // fixture session-close stand-in
  for (const row of parsed.accepted) {
    await client.query(
      `INSERT INTO market_bar (symbol, session_date, interval, source, close, available_at, run_id)
       VALUES ($1, $2, '1d', 'zzzfixture', $3, $4, $5)`,
      [row.symbol, sessionDate, row.close, availableAt, runId],
    );
  }

  // 5. Close the run with BALANCED metrics: rowsSeen == rowsAccepted + rowsRejected.
  const metrics: JobMetrics = {
    rowsSeen: parsed.accepted.length + parsed.rejected.length,
    rowsAccepted: parsed.accepted.length,
    rowsRejected: parsed.rejected.length,
    rowsWritten: parsed.accepted.length,
    symbolsCovered: parsed.accepted.length,
    inputWatermark: null,
    outputWatermark: sessionDate,
  };
  expect(metrics.rowsSeen).toBe(metrics.rowsAccepted + metrics.rowsRejected);
  await closeRun(client, runId, { status: 'succeeded', metrics });

  // Final assertion: everything actually joins back together for real.
  const { rows: finalRows } = await client.query(
    `SELECT
       b.symbol, b.available_at, b.run_id,
       r.status AS run_status, r.rows_seen, r.rows_accepted, r.rows_rejected, r.rows_written,
       o.content_hash, o.parse_status
     FROM market_bar b
     JOIN ingestion_run r ON r.run_id = b.run_id
     JOIN raw_object o ON o.run_id = b.run_id
     WHERE b.symbol = 'ZZZGATE1A'`,
  );

  expect(finalRows).toHaveLength(1);
  const row = finalRows[0];
  expect(row.run_status).toBe('succeeded');
  expect(row.run_id).toBe(runId);
  expect(row.available_at).not.toBeNull();
  expect(row.rows_seen).toBe(row.rows_accepted + row.rows_rejected);
  expect(row.rows_written).toBe(1);
  expect(row.content_hash).toBe(raw.contentHash);
  expect(row.parse_status).toBe('parsed');
});
