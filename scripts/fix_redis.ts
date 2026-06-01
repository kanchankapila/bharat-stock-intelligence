import Redis from 'ioredis';

async function fixRedis() {
  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  
  try {
    await redis.config('SET', 'stop-writes-on-bgsave-error', 'no');
    console.log('[SUCCESS] Redis config stop-writes-on-bgsave-error disabled.');
  } catch (error) {
    console.error('[ERROR] Failed to configure Redis:', error);
  } finally {
    redis.quit();
  }
}

fixRedis();
