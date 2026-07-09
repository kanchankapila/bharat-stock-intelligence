import { spawn, ChildProcess, execSync } from 'child_process';

let ollamaProcess: ChildProcess | null = null;

/**
 * Checks if Ollama is already running by trying to fetch the tags endpoint.
 */
async function isOllamaRunning(): Promise<boolean> {
  try {
    const response = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Starts the Ollama server if it's not already running.
 */
export async function startOllama(): Promise<boolean> {
  const alreadyRunning = await isOllamaRunning();
  if (alreadyRunning) {
    console.log('[OLLAMA] Ollama is already running.');
    return true;
  }

  if (process.env.DISABLE_OLLAMA_AUTO_START === 'true') {
    console.log('[OLLAMA] Auto-start is disabled (DISABLE_OLLAMA_AUTO_START=true). Skipping Ollama server auto-start.');
    return false;
  }

  return new Promise((resolve) => {
    console.log('[OLLAMA] Attempting to start Ollama server...');

    try {
      // Start 'ollama serve'
      // Using 'ollama serve' as it's the standard way to start the background server
      ollamaProcess = spawn('ollama', ['serve'], {
        detached: false,
        stdio: 'ignore',
        env: {
          ...process.env,
          OLLAMA_NUM_PARALLEL: '1',
          OLLAMA_MAX_LOADED_MODELS: '1',
        }
      });

      ollamaProcess.on('error', (err) => {
        console.error('[OLLAMA] Failed to start Ollama:', err.message);
        clearInterval(checkInterval);
        resolve(false);
      });

      // Give it some time to start up and check again
      let attempts = 0;
      const checkInterval = setInterval(async () => {
        attempts++;
        if (await isOllamaRunning()) {
          clearInterval(checkInterval);
          console.log('[OLLAMA] Ollama server started successfully.');
          resolve(true);
        } else if (attempts > 10) { // 10 attempts * 2s = 20s timeout
          clearInterval(checkInterval);
          console.warn('[OLLAMA] Ollama taking too long to start. Continuing anyway.');
          resolve(false);
        }
      }, 2000);

    } catch (error) {
      console.error('[OLLAMA] Error during spawn:', error);
      resolve(false);
    }
  });
}

/**
 * Stops the Ollama process if it was started by this manager.
 */
export async function stopOllama(): Promise<void> {
  if (ollamaProcess) {
    console.log('[OLLAMA] Shutting down Ollama process...');
    ollamaProcess.kill();
    ollamaProcess = null;
  }
}
