/** `min(base * 2^(attempt-1), max)` for attempt >= 1 (attempt 1 waits `base`). */
export function exponentialBackoffMs(attempt: number, baseMs: number, maxMs: number): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(baseMs * 2 ** exponent, maxMs);
}
