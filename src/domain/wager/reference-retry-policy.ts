export interface ReferenceRetryConfig {
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
}

/**
 * Backoff for PENDING_REFERENCE transactions (pure).
 *
 * First check after `base`; after the n-th miss (1-based) wait
 * `min(base * 2^n, max)`; give up once `attempts >= maxAttempts`.
 * Defaults (2 s, 300 s, 10) give a ~18.5 min window: long enough for provider
 * retries and short queue outages, short enough to avoid "zombie" reversals.
 */
export class ReferenceRetryPolicy {
  constructor(private readonly config: ReferenceRetryConfig) {}

  initialDelayMs(): number {
    return this.config.baseDelayMs;
  }

  delayAfterMiss(attempts: number): number {
    const raw = this.config.baseDelayMs * 2 ** attempts;
    return Math.min(raw, this.config.maxDelayMs);
  }

  isExhausted(attempts: number): boolean {
    return attempts >= this.config.maxAttempts;
  }
}
