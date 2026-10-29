import { describe, expect, test } from 'bun:test';
import { wagerRequestSchema } from '../../../src/interface/shared/wager-request.schema';
import { parseEnvelope } from '../../../src/interface/sqs/sqs-envelope.schema';

const valid = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('wagerRequestSchema', () => {
  test('accepts the challenge example and strips unknown fields', () => {
    const r = wagerRequestSchema.safeParse({ ...valid, extra: 'ignored' });
    expect(r.success).toBe(true);
    expect(r.data && 'extra' in r.data).toBe(false);
  });

  test.each([
    ['numeric amount', { money: { amount: 25, currency: 'BRL' } }],
    ['3 decimals', { money: { amount: '25.000', currency: 'BRL' } }],
    ['negative', { money: { amount: '-1.00', currency: 'BRL' } }],
    ['lowercase currency', { money: { amount: '1.00', currency: 'brl' } }],
    ['OPENING kind', { kind: 'OPENING' }],
    ['unknown kind', { kind: 'JACKPOT' }],
    ['internal provider', { providerId: 'internal' }],
    ['provider with spaces', { providerId: 'prov a' }],
    ['non-uuid wallet', { walletId: 'abc' }],
    ['empty external id', { externalTransactionId: '' }],
    ['space in external id', { externalTransactionId: 'a b' }],
    ['BET with reference', { referenceExternalTransactionId: 'x' }],
    ['REFUND without reference', { kind: 'REFUND' }],
    ['ROLLBACK without reference', { kind: 'ROLLBACK' }],
    ['self reference', { kind: 'WIN', referenceExternalTransactionId: 'transaction-123' }],
    ['zero BET', { money: { amount: '0.00', currency: 'BRL' } }],
  ])('rejects %s', (_label, patch) => {
    expect(wagerRequestSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });

  test('LOSS may be zero; reversals with reference are valid', () => {
    expect(
      wagerRequestSchema.safeParse({ ...valid, kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } }).success,
    ).toBe(true);
    expect(
      wagerRequestSchema.safeParse({ ...valid, kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-1' }).success,
    ).toBe(true);
  });
});

describe('SQS envelope', () => {
  const env = (data: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      messageId: 'msg-1',
      type: 'WagerTransactionRequested',
      occurredAt: '2026-07-29T15:00:00.000Z',
      data,
      ...extra,
    });

  test('accepts the challenge message', () => {
    expect(parseEnvelope(env({ ...valid, idempotencyKey: 'provider-a:transaction-123' })).messageId).toBe('msg-1');
  });

  test.each([
    ['not json', '{oops'],
    ['empty', ''],
    ['missing idempotencyKey', env(valid)],
    ['unknown type', env({ ...valid, idempotencyKey: 'k' }, { type: 'Other' })],
    ['bad occurredAt', env({ ...valid, idempotencyKey: 'k' }, { occurredAt: 'yesterday' })],
    ['invalid data', env({ ...valid, idempotencyKey: 'k', kind: 'OPENING' })],
  ])('rejects %s', (_label, body) => {
    expect(() => parseEnvelope(body)).toThrow();
  });
});
