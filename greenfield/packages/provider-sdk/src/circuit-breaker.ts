// Per-endpoint circuit breaker. Opens after N consecutive failures so a
// provider outage degrades to a loud, fast per-call rejection instead of
// every job in the queue individually re-discovering the same outage via a
// full timeout+retry cycle each.
export type CircuitState = 'closed' | 'open' | 'half-open';

export class CircuitOpenError extends Error {
  constructor(key: string) {
    super(`Circuit breaker is open for '${key}'`);
    this.name = 'CircuitOpenError';
  }
}

export interface CircuitBreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
}

interface CircuitEntry {
  state: CircuitState;
  consecutiveFailures: number;
  openedAt: number | null;
}

export class CircuitBreaker {
  private readonly circuits = new Map<string, CircuitEntry>();

  constructor(private readonly options: CircuitBreakerOptions) {}

  private entry(key: string): CircuitEntry {
    let e = this.circuits.get(key);
    if (!e) {
      e = { state: 'closed', consecutiveFailures: 0, openedAt: null };
      this.circuits.set(key, e);
    }
    return e;
  }

  async execute<T>(key: string, fn: () => Promise<T>, now: () => number = Date.now): Promise<T> {
    const e = this.entry(key);

    if (e.state === 'open') {
      if (now() - (e.openedAt ?? 0) >= this.options.cooldownMs) {
        e.state = 'half-open';
      } else {
        throw new CircuitOpenError(key);
      }
    }

    try {
      const result = await fn();
      e.state = 'closed';
      e.consecutiveFailures = 0;
      e.openedAt = null;
      return result;
    } catch (error) {
      e.consecutiveFailures += 1;
      if (e.consecutiveFailures >= this.options.failureThreshold) {
        e.state = 'open';
        e.openedAt = now();
      }
      throw error;
    }
  }

  stateOf(key: string): CircuitState {
    return this.entry(key).state;
  }
}
