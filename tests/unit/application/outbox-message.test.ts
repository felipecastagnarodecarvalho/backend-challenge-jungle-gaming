import { describe, expect, test } from 'bun:test';
import { WagerTransactionRejected } from '../../../src/application/messaging/events';
import { OutboxMessage } from '../../../src/application/messaging/outbox-message';
import { T0, wagerTx } from '../../support/domain-builders';

function message(): OutboxMessage {
  const tx = wagerTx();
  tx.reject({ code: 'INSUFFICIENT_FUNDS', at: T0 });
  return OutboxMessage.enqueue(
    WagerTransactionRejected.from(tx, { correlationId: 'c', occurredAt: T0, nextId: () => 'evt-1' }),
  );
}

describe('OutboxMessage', () => {
  test('enqueue copies envelope metadata and starts due now', () => {
    const m = message();
    expect(m.id).toBe('evt-1');
    expect(m.eventType).toBe('WagerTransactionRejected');
    expect(m.eventVersion).toBe(1);
    expect(m.aggregateType).toBe('WagerTransaction');
    expect(m.attempts).toBe(0);
    expect(m.nextAttemptAt).toEqual(T0);
    expect(m.isPending()).toBe(true);
    expect(m.isDue(T0)).toBe(true);
    expect(m.payload.eventId).toBe('evt-1');
    expect(typeof m.payload.occurredAt).toBe('string');
  });

  test('scheduleRetry uses exponential backoff capped at 300 s', () => {
    const m = message();
    const delays: number[] = [];
    for (let i = 0; i < 11; i++) {
      m.scheduleRetry(T0, 'boom');
      delays.push((m.nextAttemptAt as Date).getTime() - T0.getTime());
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000]);
    expect(m.attempts).toBe(11);
    expect(m.lastError).toBe('boom');
    expect(m.isDue(T0)).toBe(false);
    expect(m.isDue(new Date(T0.getTime() + 300_000))).toBe(true);
  });

  test('markPublished twice throws; published is never due', () => {
    const m = message();
    m.markPublished(T0);
    expect(m.isPending()).toBe(false);
    expect(m.isDue(new Date(T0.getTime() + 1e9))).toBe(false);
    expect(() => m.markPublished(T0)).toThrow();
    expect(() => m.scheduleRetry(T0)).toThrow();
  });
});
