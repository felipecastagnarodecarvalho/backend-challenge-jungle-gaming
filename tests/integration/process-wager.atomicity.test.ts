import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { NoopMetrics } from '../../src/application/ports/metrics';
import { NoopFaultInjector } from '../../src/application/ports/system';
import type { TransactionScope, UnitOfWork } from '../../src/application/ports/unit-of-work';
import type { ProcessWagerCommand } from '../../src/application/wager/process-wager-command';
import { ProcessWagerTransactionUseCase } from '../../src/application/wager/process-wager-transaction.use-case';
import { WagerEvaluator } from '../../src/application/wager/wager-evaluator';
import { CreateWalletUseCase } from '../../src/application/wallet/create-wallet.use-case';
import { ReferenceRetryPolicy } from '../../src/domain/wager/reference-retry-policy';
import { MikroUnitOfWork } from '../../src/infrastructure/persistence/mikro-unit-of-work';
import { createOrm } from '../../src/infrastructure/persistence/orm';
import { SystemClock } from '../../src/infrastructure/system/system-clock';
import { UuidV7IdGenerator } from '../../src/infrastructure/system/uuidv7-id-generator';
import { closeDb, db } from '../support/db';
import { TEST_DATABASE_URL } from '../support/env';
import { silentLogger } from '../support/fakes';
import { assertWalletConsistent, walletBalance } from '../support/invariants';

/**
 * Wallet, transaction, ledger, inbox and outbox commit together or not at all:
 * a failure injected after the ledger write (or at the outbox) must leave no trace.
 */
let orm: MikroORM;
let realUow: UnitOfWork;
const ids = new UuidV7IdGenerator();
const clock = new SystemClock();
const retry = { maxAttempts: 3 };

class FailingUnitOfWork implements UnitOfWork {
  constructor(
    private readonly inner: UnitOfWork,
    private readonly failAt: 'ledger' | 'outbox',
  ) {}
  run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> {
    return this.inner.run((scope) =>
      work({
        ...scope,
        ledger: {
          append: async (e) => {
            await scope.ledger.append(e);
            if (this.failAt === 'ledger') throw new Error('injected failure after ledger append');
          },
        },
        outbox: {
          ...scope.outbox,
          enqueue: async (m) => {
            if (this.failAt === 'outbox') throw new Error('injected outbox failure');
            await scope.outbox.enqueue(m);
          },
        },
      }),
    );
  }
}

function useCase(uow: UnitOfWork) {
  return new ProcessWagerTransactionUseCase({
    uow,
    evaluator: new WagerEvaluator(ids, new ReferenceRetryPolicy({ baseDelayMs: 100, maxDelayMs: 400, maxAttempts: 3 })),
    clock,
    ids,
    metrics: NoopMetrics,
    logger: silentLogger,
    faults: NoopFaultInjector,
    retry,
  });
}

beforeAll(async () => {
  orm = await createOrm({ url: TEST_DATABASE_URL, poolMax: 5 });
  realUow = new MikroUnitOfWork(orm, { lockTimeoutMs: 5000, statementTimeoutMs: 15000 });
});

afterAll(async () => {
  await orm.close(true);
  await closeDb();
});

async function counts(walletId: string, messageId: string) {
  const [r] = await db()`SELECT
      (SELECT COUNT(*) FROM wager_transactions WHERE wallet_id = ${walletId})::int AS txs,
      (SELECT COUNT(*) FROM wallet_ledger_entries WHERE wallet_id = ${walletId})::int AS ledger,
      (SELECT COUNT(*) FROM outbox_messages WHERE partition_key = ${walletId})::int AS outbox,
      (SELECT COUNT(*) FROM inbox_messages WHERE message_id = ${messageId})::int AS inbox,
      (SELECT version FROM wallets WHERE id = ${walletId}) AS version`;
  return r as { txs: number; ledger: number; outbox: number; inbox: number; version: number };
}

describe('atomicity of wallet + ledger + inbox + outbox', () => {
  test.each(['ledger', 'outbox'] as const)(
    'failure at %s rolls back everything; retry without failure commits all',
    async (failAt) => {
      const wallet = await new CreateWalletUseCase({
        uow: realUow,
        clock,
        ids,
        metrics: NoopMetrics,
        logger: silentLogger,
        retry,
      }).execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
        correlationId: 'c',
      });
      const messageId = `msg-${crypto.randomUUID()}`;
      const ext = `ext-${crypto.randomUUID()}`;
      const command: ProcessWagerCommand = {
        idempotencyKey: `provider-a:${ext}`,
        providerId: 'provider-a',
        externalTransactionId: ext,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'r1',
        gameId: 'g1',
        kind: 'BET',
        money: { amount: '30.00', currency: 'BRL' },
        correlationId: 'corr',
        source: { type: 'SQS', consumerName: 'atomicity-test', messageId, messageHash: 'f'.repeat(64) },
      };

      const before = await counts(wallet.id, messageId);
      expect(before).toEqual({ txs: 1, ledger: 1, outbox: 2, inbox: 0, version: 1 });

      await expect(useCase(new FailingUnitOfWork(realUow, failAt)).execute(command)).rejects.toThrow('injected');
      expect(await counts(wallet.id, messageId)).toEqual(before);
      expect(await walletBalance(wallet.id)).toBe('100.00');

      const ok = await useCase(realUow).execute(command);
      expect(ok).toMatchObject({ outcome: 'TRANSACTION', status: 'PROCESSED', balance: { amount: '70.00' } });
      expect(await counts(wallet.id, messageId)).toEqual({ txs: 2, ledger: 2, outbox: 4, inbox: 1, version: 2 });
      const [inbox] =
        await db()`SELECT processed_at IS NOT NULL AS done, transaction_id FROM inbox_messages WHERE message_id = ${messageId}`;
      expect(inbox).toMatchObject({ done: true });
      await assertWalletConsistent(wallet.id);
    },
  );
});
