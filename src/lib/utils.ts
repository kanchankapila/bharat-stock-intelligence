import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * MoneyControl index URLs end in "-<indexId>.html" -- pull that id out for click-through
 * navigation to the Index Detail page. Shared by IndicesPage.tsx and MarketInsights.tsx.
 */
export function extractIndexId(url: string): string | null {
  const m = url?.match(/-(\d+)\.html$/);
  return m ? m[1] : null;
}
/**
 * Generate a random jitter value to avoid thundering herd problem
 * @param baseMs - Base milliseconds to add jitter to
 * @param jitterPercent - Percentage of jitter to add (0-100)
 * @returns Jittered delay in milliseconds
 */
export function getJitteredDelay(baseMs: number, jitterPercent: number = 10): number {
  const jitterAmount = (baseMs * jitterPercent) / 100;
  const randomJitter = Math.random() * jitterAmount * 2 - jitterAmount;
  return Math.max(100, baseMs + randomJitter);
}

/**
 * Apply exponential backoff with jitter for retries
 * @param attempt - Current attempt number (0-based)
 * @param baseDelayMs - Base delay in milliseconds
 * @param maxDelayMs - Maximum delay in milliseconds
 * @returns Delay in milliseconds
 */
export function getExponentialBackoffWithJitter(
  attempt: number,
  baseDelayMs: number = 100,
  maxDelayMs: number = 5000
): number {
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);
  return getJitteredDelay(cappedDelay, 15);
}