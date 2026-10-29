import { describe, expect, test } from 'bun:test';
import { InboxMessage } from '../../../src/application/messaging/inbox-message';
import { T0 } from '../../support/domain-builders';

describe('InboxMessage', () => {
  test('receive -> markProcessed', () => {
    const m = InboxMessage.receive({ messageId: 'm1', consumerName: 'c', payloadHash: 'h', receivedAt: T0 });
    expect(m.isProcessed()).toBe(false);
    const at = new Date(T0.getTime() + 5);
    m.markProcessed(at, 'tx-1');
    expect(m.isProcessed()).toBe(true);
    expect(m.processedAt).toEqual(at);
    expect(m.transactionId).toBe('tx-1');
    expect(() => m.markProcessed(at)).toThrow();
  });

  test('processedAt cannot precede receivedAt; ids are required', () => {
    const m = InboxMessage.receive({ messageId: 'm1', consumerName: 'c', payloadHash: 'h', receivedAt: T0 });
    expect(() => m.markProcessed(new Date(T0.getTime() - 1))).toThrow();
    expect(() =>
      InboxMessage.receive({ messageId: '', consumerName: 'c', payloadHash: 'h', receivedAt: T0 }),
    ).toThrow();
  });

  test('rehydrate', () => {
    const m = InboxMessage.rehydrate({
      messageId: 'm',
      consumerName: 'c',
      payloadHash: 'h',
      receivedAt: T0,
      processedAt: T0,
      transactionId: undefined,
    });
    expect(m.isProcessed()).toBe(true);
  });
});
