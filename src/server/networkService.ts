/**
 * Resilient HTTP Client Service
 *
 * Implements native fetch wrapping with AbortController timeouts,
 * exponential backoff, and error retries for reliable integration with
 * external APIs (Yahoo Finance, MoneyControl, Trendlyne, Finnhub, etc.).
 */

export interface FetchOptions extends RequestInit {
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
}

/**
 * Perform a resilient HTTP fetch with timeout and exponential backoff retry.
 *
 * @param url Target endpoint URL
 * @param options Native RequestInit + resilience parameters
 */
export async function resilientFetch(url: string, options: FetchOptions = {}): Promise<Response> {
  const { timeoutMs = 8000, retries = 3, backoffMs = 500, ...fetchOptions } = options;
  
  let lastError: any = null;
  
  for (let attempt = 0; attempt < retries; attempt++) {
    const controller = new AbortController();
    const timerId = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
      const response = await fetch(url, {
        ...fetchOptions,
        signal: controller.signal,
      });
      
      // Clear the timeout gate immediately
      clearTimeout(timerId);
      
      // If request was successful, return response
      if (response.ok) {
        return response;
      }
      
      // If we are rate-limited (429) or hit server side errors (5xx), wait and retry
      if (response.status === 429 || response.status >= 500) {
        const delay = backoffMs * Math.pow(2, attempt);
        console.warn(`[FETCH] HTTP ${response.status} on ${url}. Retrying in ${delay}ms (attempt ${attempt + 1}/${retries})...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      
      // Other client-side errors (400, 404, etc.) should fail immediately
      throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
    } catch (err: any) {
      clearTimeout(timerId);
      lastError = err;
      
      if (err.name === 'AbortError') {
        console.warn(`[FETCH] Timeout after ${timeoutMs}ms on attempt ${attempt + 1}/${retries} for ${url}`);
      } else {
        console.warn(`[FETCH] Connection error on attempt ${attempt + 1}/${retries} for ${url}: ${err.message}`);
      }
      
      if (attempt < retries - 1) {
        const delay = backoffMs * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError || new Error(`Failed to fetch ${url} after ${retries} attempts`);
}

/**
 * Perform a fetch, parsed directly as JSON, with resilient fetching fallback.
 */
export async function resilientFetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const response = await resilientFetch(url, options);
  return response.json() as Promise<T>;
}
