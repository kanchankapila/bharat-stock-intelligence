import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let redisProcess: ChildProcess | null = null;

/**
 * Starts the Redis server if it's not already running.
 * This looks for redis-server.exe in the ./redis directory.
 */
export async function startRedis(): Promise<boolean> {
  return new Promise((resolve) => {
    // 1. Check if Redis is already running by trying to connect (this is done by cacheService)
    // Here we focus on launching the process.
    
    const projectRoot = process.cwd();
    const redisPath = path.resolve(projectRoot, 'redis', 'redis-server.exe');
    const configPath = path.resolve(projectRoot, 'redis', 'redis.windows.conf');

    if (!fs.existsSync(redisPath)) {
      console.warn(`[REDIS] redis-server.exe not found at ${redisPath}. Manual startup required.`);
      return resolve(false);
    }

    console.log(`[REDIS] Attempting to start Redis from ${redisPath}...`);

    try {
      // Spawn Redis process
      redisProcess = spawn(redisPath, [configPath], {
        cwd: path.resolve(projectRoot, 'redis'),
        detached: false,
        stdio: 'ignore' // We don't want to clutter the main logs with Redis output unless debugging
      });

      redisProcess.on('error', (err) => {
        console.error('[REDIS] Failed to start process:', err.message);
        resolve(false);
      });

      // Give it a moment to start up
      setTimeout(() => {
        if (redisProcess && !redisProcess.killed) {
          console.log('[REDIS] Redis process spawned successfully.');
          resolve(true);
        } else {
          resolve(false);
        }
      }, 1500);

    } catch (error) {
      console.error('[REDIS] Error during spawn:', error);
      resolve(false);
    }
  });
}

/**
 * Stops the Redis server process if it was started by this manager.
 */
export async function stopRedis(): Promise<void> {
  if (redisProcess) {
    console.log('[REDIS] Shutting down Redis process...');
    redisProcess.kill();
    redisProcess = null;
  }
}
