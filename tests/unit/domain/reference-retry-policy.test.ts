import { describe, expect, test } from 'bun:test';
import { ReferenceRetryPolicy } from '../../../src/domain/wager/reference-retry-policy';

describe('ReferenceRetryPolicy', () => {
  const policy = new ReferenceRetryPolicy({ baseDelayMs: 2_000, maxDelayMs: 300_000, maxAttempts: 10 });

  test('initial delay is the base', () => {
    expect(policy.initialDelayMs()).toBe(2_000);
  });

  test('delays double per miss and are capped', () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => policy.delayAfterMiss(n));
    expect(delays).toEqual([4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000]);
  });

  test('total window is ~18.5 minutes', () => {
    let total = policy.initialDelayMs();
    for (let n = 1; n < 10; n++) total += policy.delayAfterMiss(n);
    expect(total).toBe(1_110_000);
  });

  test('expires at maxAttempts', () => {
    expect(policy.isExhausted(9)).toBe(false);
    expect(policy.isExhausted(10)).toBe(true);
  });
});
