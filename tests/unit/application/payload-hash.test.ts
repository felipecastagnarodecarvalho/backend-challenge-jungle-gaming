import { describe, expect, test } from 'bun:test';
import { canonicalWagerPayload, computeWagerPayloadHash } from '../../../src/application/wager/payload-hash';
import type { WagerRequestData } from '../../../src/application/wager/process-wager-command';

const sample: WagerRequestData = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('payload hash', () => {
  test('documented test vector', () => {
    expect(canonicalWagerPayload(sample)).toBe(
      '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"},"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","providerId":"provider-a","referenceExternalTransactionId":null,"roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}',
    );
    expect(computeWagerPayloadHash(sample)).toBe('6ff120b653ab29c549944171b99b9bd2781fd142504011f05029c37c3d9c8974');
  });

  test('input key order is irrelevant', () => {
    const reordered = {
      money: { currency: 'BRL', amount: '25.00' },
      kind: 'BET',
      gameId: 'fortune-chimp',
      roundId: 'round-987',
      walletId: sample.walletId,
      playerId: sample.playerId,
      externalTransactionId: 'transaction-123',
      providerId: 'provider-a',
    } as WagerRequestData;
    expect(computeWagerPayloadHash(reordered)).toBe(computeWagerPayloadHash(sample));
  });

  test('absent reference is equivalent to null/undefined', () => {
    expect(computeWagerPayloadHash({ ...sample, referenceExternalTransactionId: undefined })).toBe(
      computeWagerPayloadHash(sample),
    );
  });

  test('changing any business field changes the hash', () => {
    const base = computeWagerPayloadHash(sample);
    const variants: WagerRequestData[] = [
      { ...sample, providerId: 'provider-b' },
      { ...sample, externalTransactionId: 'transaction-124' },
      { ...sample, playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a2' },
      { ...sample, walletId: '0192f291-27dd-7d3f-8071-5f8685deef38' },
      { ...sample, roundId: 'round-988' },
      { ...sample, gameId: 'other' },
      { ...sample, kind: 'WIN' },
      { ...sample, money: { amount: '25.01', currency: 'BRL' } },
      { ...sample, money: { amount: '25.00', currency: 'USD' } },
      { ...sample, referenceExternalTransactionId: 'x' },
    ];
    for (const v of variants) {
      expect(computeWagerPayloadHash(v)).not.toBe(base);
    }
  });

  test('transport fields (idempotencyKey, correlationId, messageId) are not hashed', () => {
    const withTransport = {
      ...sample,
      idempotencyKey: 'whatever',
      correlationId: 'c',
      messageId: 'm',
    } as WagerRequestData;
    expect(computeWagerPayloadHash(withTransport)).toBe(computeWagerPayloadHash(sample));
  });
});
