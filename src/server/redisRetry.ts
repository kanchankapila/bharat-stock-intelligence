// ioredis stops reconnecting for good when retryStrategy returns null, and a BullMQ worker on such
// a connection never runs another job while the rest of the server stays up, so pm2 never restarts
// it (2026-11-13: Redis down 42s in a Docker restart, no job ran for 13.4h, AF-20261114-02). Back
// off to 5s and keep trying; the jitter staggers ~88 connections reconnecting at once.
export function redisReconnectDelay(times: number): number {
  return Math.min(times * 200, 5000) + Math.floor(Math.random() * 200);
}
