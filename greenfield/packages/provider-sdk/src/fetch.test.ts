// Task 1.2 Verify: "contract tests for timeout, 500-then-success retry, 404
// no-retry, oversized response, and circuit-breaker opening." Each spins up
// a real local HTTP server so behavior is deterministic and needs no network
// access -- not a mock of fetch() itself, which could pass while the real
// request-handling logic is broken.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, expect, test } from 'vitest';
import { fetchWithPolicy, HttpStatusError, ResponseTooLargeError } from './fetch.js';
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker.js';

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise((resolve) => server!.close(resolve));
    server = undefined;
  }
});

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

test('timeout: a server that never responds is aborted at timeoutMs', async () => {
  const url = await listen(() => {
    // never call res.end() -- simulates a hung upstream
  });
  await expect(
    fetchWithPolicy({ url, timeoutMs: 200, retry: { attempts: 1, backoffMs: 10, jitter: false } }),
  ).rejects.toThrow();
});

test('500-then-success: retries a 5xx and returns the eventual success', async () => {
  let calls = 0;
  const url = await listen((_req, res) => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(503);
      res.end('unavailable');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });

  const result = await fetchWithPolicy({
    url,
    retry: { attempts: 3, backoffMs: 10, jitter: false },
  });

  expect(calls).toBe(2);
  expect(result.httpStatus).toBe(200);
  expect(result.body).toBe('ok');
});

test('404 no-retry: a single call is made and the 404 is returned, not thrown', async () => {
  let calls = 0;
  const url = await listen((_req, res) => {
    calls += 1;
    res.writeHead(404);
    res.end('not found');
  });

  const result = await fetchWithPolicy({
    url,
    retry: { attempts: 3, backoffMs: 10, jitter: false },
  });

  expect(calls).toBe(1);
  expect(result.httpStatus).toBe(404);
});

test('oversized response: aborts once the byte cap is exceeded', async () => {
  const url = await listen((_req, res) => {
    res.writeHead(200);
    res.end('x'.repeat(1000));
  });

  await expect(
    fetchWithPolicy({ url, maxBytes: 100, retry: { attempts: 1, backoffMs: 10, jitter: false } }),
  ).rejects.toThrow(ResponseTooLargeError);
});

test('circuit breaker: opens after the failure threshold and short-circuits further calls', async () => {
  let calls = 0;
  const url = await listen((_req, res) => {
    calls += 1;
    res.writeHead(503);
    res.end('unavailable');
  });

  const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 60_000 });
  const attempt = () =>
    breaker.execute('test-endpoint', () =>
      fetchWithPolicy({ url, retry: { attempts: 1, backoffMs: 5, jitter: false } }),
    );

  await expect(attempt()).rejects.toThrow(HttpStatusError);
  await expect(attempt()).rejects.toThrow(HttpStatusError);
  expect(breaker.stateOf('test-endpoint')).toBe('open');

  const callsBeforeOpen = calls;
  await expect(attempt()).rejects.toThrow(CircuitOpenError);
  // The breaker short-circuited: no new request reached the server.
  expect(calls).toBe(callsBeforeOpen);
});
