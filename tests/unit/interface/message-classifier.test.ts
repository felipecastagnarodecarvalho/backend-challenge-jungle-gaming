import { describe, expect, test } from 'bun:test';
import {
  ConcurrencyInvariantError,
  IntegrityViolationError,
  TransientInfrastructureError,
  UniqueViolationError,
  ValidationError,
} from '../../../src/application/errors';
import { InsufficientFundsError } from '../../../src/domain/wallet/wallet.errors';
import {
  classifyMessage,
  heartbeatIntervalMs,
  retryVisibilitySeconds,
} from '../../../src/interface/sqs/message-classifier';
import { InvalidMessageError } from '../../../src/interface/sqs/sqs-envelope.schema';

const tx = (status: 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE' | 'FAILED', replay = false) =>
  ({
    outcome: 'TRANSACTION',
    transactionId: 't',
    status,
    failureCode: null,
    balance: null,
    walletVersion: null,
    idempotentReplay: replay,
  }) as const;

describe('classifyMessage', () => {
  test.each([
    ['processed', tx('PROCESSED'), false],
    ['rejected (business, terminal)', tx('REJECTED'), false],
    ['pending reference', tx('PENDING_REFERENCE'), false],
    ['failed', tx('FAILED'), false],
    ['replay', tx('PROCESSED', true), true],
  ])('%s -> ACK', (_label, result, duplicate) => {
    expect(classifyMessage({ result })).toEqual({ action: 'ACK', duplicate });
  });

  test('idempotency conflict, wallet not found and inbox duplicate -> ACK', () => {
    expect(
      classifyMessage({
        result: { outcome: 'IDEMPOTENCY_CONFLICT', reason: 'PAYLOAD_MISMATCH', existingTransactionId: 'x' },
      }),
    ).toEqual({ action: 'ACK', duplicate: false });
    expect(classifyMessage({ result: { outcome: 'WALLET_NOT_FOUND' } })).toEqual({ action: 'ACK', duplicate: false });
    expect(classifyMessage({ result: { outcome: 'DUPLICATE_MESSAGE' } })).toEqual({ action: 'ACK', duplicate: true });
  });

  test('invalid payload / validation -> DLQ (poison)', () => {
    expect(classifyMessage({ error: new InvalidMessageError('bad json') })).toMatchObject({
      action: 'DLQ',
      errorCode: 'INVALID_PAYLOAD',
    });
    expect(classifyMessage({ error: new ValidationError([]) })).toMatchObject({
      action: 'DLQ',
      errorCode: 'VALIDATION_ERROR',
    });
  });

  test('deterministic permanent errors -> DLQ immediately with their code', () => {
    expect(classifyMessage({ error: new IntegrityViolationError('chain broken') })).toMatchObject({
      action: 'DLQ',
      reason: 'permanent_error',
      errorCode: 'INTEGRITY_VIOLATION',
    });
    expect(classifyMessage({ error: new ConcurrencyInvariantError('x') })).toMatchObject({
      action: 'DLQ',
      errorCode: 'CONCURRENCY_INVARIANT',
    });
    expect(classifyMessage({ error: new InsufficientFundsError('w') })).toMatchObject({
      action: 'DLQ',
      errorCode: 'INSUFFICIENT_FUNDS',
    });
  });

  test('transient, unknown and non-race unique violations -> RETRY (redrive after maxReceiveCount)', () => {
    expect(classifyMessage({ error: new TransientInfrastructureError('lock_timeout') })).toEqual({
      action: 'RETRY',
      reason: 'TRANSIENT_FAILURE',
    });
    expect(classifyMessage({ error: new UniqueViolationError('ledger_wallet_version_uk') })).toEqual({
      action: 'RETRY',
      reason: 'UNIQUE_VIOLATION',
    });
    expect(classifyMessage({ error: new Error('bug') })).toEqual({ action: 'RETRY', reason: 'unknown' });
  });

  test('heartbeat interval is half the visibility timeout, at least 1 s', () => {
    expect(heartbeatIntervalMs(30)).toBe(15_000);
    expect(heartbeatIntervalMs(2)).toBe(1_000);
    expect(heartbeatIntervalMs(1)).toBe(1_000);
  });

  test('visibility backoff', () => {
    expect([1, 2, 3, 4, 5, 10].map((n) => retryVisibilitySeconds(n, 2, 300))).toEqual([2, 4, 8, 16, 32, 300]);
  });
});
