import { describe, expect, test } from 'bun:test';
import { IntegrityViolationError, TransientDatabaseError } from '../../../src/application/errors';
import type { TransactionScope, UnitOfWork } from '../../../src/application/ports/unit-of-work';
import { ResolvePendingReferencesUseCase } from '../../../src/application/wager/resolve-pending-references.use-case';
import { WagerEvaluator } from '../../../src/application/wager/wager-evaluator';
import { Money } from '../../../src/domain/money/money';
import { ReferenceRetryPolicy } from '../../../src/domain/wager/reference-retry-policy';
import { WagerTransaction } from '../../../src/domain/wager/wager-transaction';
import { Wallet } from '../../../src/domain/wallet/wallet';
import { FixedClock, InMemoryUnitOfWork, recordingMetrics, SequentialIds, silentLogger } from '../../support/fakes';

const brl = (a: string) => Money.from({ amount: a, currency: 'BRL' });
const PLAYER = 'p-1';

function setup(failLedger?: () => Error) {
  const inner = new InMemoryUnitOfWork();
  const clock = new FixedClock();
  const ids = new SequentialIds();
  const wallet = Wallet.rehydrate({
    id: 'w-1',
    playerId: PLAYER,
    currency: 'BRL',
    balance: brl('100.00'),
    version: 1,
    createdAt: clock.now(),
    updatedAt: clock.now(),
  });
  inner.store.wallets.set(wallet.id, wallet);
  const base = {
    providerId: 'provider-a',
    payloadHash: 'a'.repeat(64),
    walletId: wallet.id,
    playerId: PLAYER,
    roundId: 'r',
    gameId: 'g',
    source: 'HTTP' as const,
    createdAt: clock.now(),
  };
  const bet = WagerTransaction.create({
    ...base,
    id: 'bet',
    externalTransactionId: 'bet-1',
    idempotencyKey: 'k1',
    kind: 'BET',
    money: brl('10.00'),
  });
  bet.markProcessed({ at: clock.now(), balanceAfter: brl('90.00'), walletVersion: 2 });
  const rollback = WagerTransaction.create({
    ...base,
    id: 'rb',
    externalTransactionId: 'rb-1',
    idempotencyKey: 'k2',
    kind: 'ROLLBACK',
    money: brl('10.00'),
    referenceExternalTransactionId: 'bet-1',
  });
  rollback.markPendingReference({
    at: clock.now(),
    nextCheckAt: clock.now(),
    observedBalance: brl('100.00'),
    walletVersion: 1,
  });
  inner.store.transactions.set(bet.id, bet);
  inner.store.transactions.set(rollback.id, rollback);

  const uow: UnitOfWork = {
    run: (work) =>
      inner.run((scope: TransactionScope) =>
        work({
          ...scope,
          ledger: {
            append: async (e) => {
              const err = failLedger?.();
              if (err) throw err;
              await scope.ledger.append(e);
            },
          },
        }),
      ),
  };
  const metrics = recordingMetrics();
  const useCase = new ResolvePendingReferencesUseCase({
    uow,
    evaluator: new WagerEvaluator(ids, new ReferenceRetryPolicy({ baseDelayMs: 100, maxDelayMs: 400, maxAttempts: 3 })),
    clock,
    ids,
    metrics,
    logger: silentLogger,
    retry: { maxAttempts: 2, sleep: async () => undefined },
    batchSize: 10,
    leaseMs: 1000,
  });
  return { inner, useCase, metrics };
}

describe('ResolvePendingReferences', () => {
  test('resolves when the reference is now processed', async () => {
    const { inner, useCase } = setup();
    expect(await useCase.runOnce()).toBe(1);
    expect(inner.store.transactions.get('rb')?.status).toBe('PROCESSED');
    expect(inner.store.ledger).toHaveLength(1);
  });

  test('unexpected permanent error parks the transaction as FAILED with an event (no infinite loop)', async () => {
    const { inner, useCase } = setup(() => new IntegrityViolationError('boom'));
    await useCase.runOnce();
    const tx = inner.store.transactions.get('rb');
    expect(tx?.status).toBe('FAILED');
    expect(tx?.failureCode).toBe('PROCESSING_ERROR');
    expect(inner.store.outbox.map((m) => m.eventType)).toEqual(['WagerTransactionFailed']);
    expect(inner.store.ledger).toHaveLength(0);
  });

  test('transient errors leave the item pending for a later attempt', async () => {
    const { inner, useCase } = setup(() => new TransientDatabaseError('deadlock'));
    await useCase.runOnce();
    expect(inner.store.transactions.get('rb')?.status).toBe('PENDING_REFERENCE');
    expect(inner.store.outbox).toHaveLength(0);
  });
});
