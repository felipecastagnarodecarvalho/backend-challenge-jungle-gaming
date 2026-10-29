import { beforeEach, describe, expect, test } from 'bun:test';
import { ValidationError } from '../../../src/application/errors';
import { NoopFaultInjector } from '../../../src/application/ports/system';
import type { ProcessWagerCommand } from '../../../src/application/wager/process-wager-command';
import { ProcessWagerTransactionUseCase } from '../../../src/application/wager/process-wager-transaction.use-case';
import { WagerEvaluator } from '../../../src/application/wager/wager-evaluator';
import { Money } from '../../../src/domain/money/money';
import { ReferenceRetryPolicy } from '../../../src/domain/wager/reference-retry-policy';
import { Wallet } from '../../../src/domain/wallet/wallet';
import { FixedClock, InMemoryUnitOfWork, recordingMetrics, SequentialIds, silentLogger } from '../../support/fakes';

const PLAYER = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
const WALLET = '0192f291-27dd-7d3f-8071-5f8685deef37';

let uow: InMemoryUnitOfWork;
let useCase: ProcessWagerTransactionUseCase;
let metrics: ReturnType<typeof recordingMetrics>;

function cmd(overrides: Partial<ProcessWagerCommand> = {}): ProcessWagerCommand {
  return {
    idempotencyKey: 'provider-a:tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'tx-1',
    playerId: PLAYER,
    walletId: WALLET,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    correlationId: 'corr',
    source: { type: 'HTTP', requestId: 'req' },
    ...overrides,
  };
}

beforeEach(() => {
  uow = new InMemoryUnitOfWork();
  const ids = new SequentialIds();
  const clock = new FixedClock();
  metrics = recordingMetrics();
  const { wallet } = Wallet.open({
    id: WALLET,
    playerId: PLAYER,
    initialBalance: Money.from({ amount: '0.00', currency: 'BRL' }),
    at: clock.now(),
  });
  // seed 1000.00 through a credit so the fake wallet has a real version history
  wallet.credit({
    entryId: 'seed',
    transactionId: 'seed',
    money: Money.from({ amount: '1000.00', currency: 'BRL' }),
    at: clock.now(),
  });
  uow.store.wallets.set(WALLET, wallet);
  useCase = new ProcessWagerTransactionUseCase({
    uow,
    evaluator: new WagerEvaluator(ids, new ReferenceRetryPolicy({ baseDelayMs: 100, maxDelayMs: 400, maxAttempts: 3 })),
    clock,
    ids,
    metrics,
    logger: silentLogger,
    faults: NoopFaultInjector,
    retry: { maxAttempts: 3, sleep: async () => undefined },
  });
});

describe('ProcessWagerTransaction idempotency (fakes)', () => {
  test('same key + same payload replays the original result, including the original balance', async () => {
    const first = await useCase.execute(cmd());
    expect(first).toMatchObject({
      outcome: 'TRANSACTION',
      status: 'PROCESSED',
      idempotentReplay: false,
      balance: { amount: '975.00' },
    });

    // other operations move the balance afterwards
    await useCase.execute(
      cmd({
        idempotencyKey: 'provider-a:tx-2',
        externalTransactionId: 'tx-2',
        money: { amount: '100.00', currency: 'BRL' },
      }),
    );

    const replay = await useCase.execute(cmd());
    expect(replay).toMatchObject({
      outcome: 'TRANSACTION',
      status: 'PROCESSED',
      idempotentReplay: true,
      balance: { amount: '975.00' },
    });
    if (first.outcome === 'TRANSACTION' && replay.outcome === 'TRANSACTION') {
      expect(replay.transactionId).toBe(first.transactionId);
    }
    expect(uow.store.ledger.filter((e) => e.direction === 'DEBIT')).toHaveLength(2);
    expect(uow.store.wallets.get(WALLET)?.balance.toJSON().amount).toBe('875.00');
    expect(metrics.calls.some(([name, args]) => name === 'duplicate' && args[1] === 'replay')).toBe(true);
  });

  test('same key + different payload is a conflict, not a replay', async () => {
    await useCase.execute(cmd());
    const conflict = await useCase.execute(cmd({ money: { amount: '26.00', currency: 'BRL' } }));
    expect(conflict).toMatchObject({ outcome: 'IDEMPOTENCY_CONFLICT', reason: 'PAYLOAD_MISMATCH' });
    expect(uow.store.ledger).toHaveLength(1);
  });

  test('external id already bound to another key is a conflict', async () => {
    await useCase.execute(cmd());
    const conflict = await useCase.execute(cmd({ idempotencyKey: 'another-key' }));
    expect(conflict).toMatchObject({ outcome: 'IDEMPOTENCY_CONFLICT', reason: 'EXTERNAL_ID_BOUND_TO_OTHER_KEY' });
  });

  test('key and external id pointing at two different transactions is a conflict', async () => {
    await useCase.execute(cmd());
    await useCase.execute(cmd({ idempotencyKey: 'k2', externalTransactionId: 'tx-2' }));
    const conflict = await useCase.execute(cmd({ idempotencyKey: 'k2' }));
    expect(conflict).toMatchObject({ outcome: 'IDEMPOTENCY_CONFLICT', reason: 'KEY_AND_EXTERNAL_ID_MISMATCH' });
  });

  test('rejections replay identically (no new effects)', async () => {
    const big = cmd({ money: { amount: '5000.00', currency: 'BRL' } });
    const first = await useCase.execute(big);
    const again = await useCase.execute(big);
    expect(first).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', idempotentReplay: false });
    expect(again).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', idempotentReplay: true });
    expect(uow.store.ledger).toHaveLength(0);
    expect(uow.store.outbox.filter((m) => m.eventType === 'WagerTransactionRejected')).toHaveLength(1);
  });

  test('unknown wallet is WALLET_NOT_FOUND and nothing is persisted', async () => {
    const r = await useCase.execute(cmd({ walletId: '0192f291-27dd-7d3f-8071-000000000000' }));
    expect(r).toEqual({ outcome: 'WALLET_NOT_FOUND' });
    expect(uow.store.transactions.size).toBe(0);
  });

  test('SQS redelivery of the same messageId is DUPLICATE_MESSAGE', async () => {
    const sqs = cmd({ source: { type: 'SQS', consumerName: 'c', messageId: 'm-1', messageHash: 'h' } });
    expect((await useCase.execute(sqs)).outcome).toBe('TRANSACTION');
    expect(await useCase.execute(sqs)).toEqual({ outcome: 'DUPLICATE_MESSAGE' });
    expect(uow.store.ledger).toHaveLength(1);
  });

  test('invalid command (OPENING kind / bad amount) is a ValidationError', async () => {
    await expect(useCase.execute(cmd({ kind: 'OPENING' as 'BET' }))).rejects.toBeInstanceOf(ValidationError);
    await expect(useCase.execute(cmd({ money: { amount: '1.5', currency: 'BRL' } }))).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  test('currency conflict is a business rejection without exposing the balance', async () => {
    const r = await useCase.execute(cmd({ money: { amount: '1.00', currency: 'USD' } }));
    expect(r).toMatchObject({ status: 'REJECTED', failureCode: 'CURRENCY_MISMATCH', balance: null });
  });

  test('uppercase UUIDs are canonicalised: same operation, same hash, replay instead of conflict', async () => {
    const upper = cmd({ playerId: PLAYER.toUpperCase(), walletId: WALLET.toUpperCase() });
    const first = await useCase.execute(upper);
    expect(first).toMatchObject({ outcome: 'TRANSACTION', status: 'PROCESSED', idempotentReplay: false });
    const replay = await useCase.execute(cmd());
    expect(replay).toMatchObject({ outcome: 'TRANSACTION', idempotentReplay: true });
    expect(uow.store.ledger).toHaveLength(1);
  });

  test('idempotency keys are scoped per provider: no squatting, no cross-provider leakage', async () => {
    // provider-b uses the key provider-a will use, on its own (distinct) operation
    const squat = await useCase.execute(
      cmd({ providerId: 'provider-b', externalTransactionId: 'b-1', idempotencyKey: 'provider-a:tx-1' }),
    );
    expect(squat).toMatchObject({ outcome: 'TRANSACTION', status: 'PROCESSED', idempotentReplay: false });
    // provider-a's legitimate request with that key is NOT blocked and sees nothing of provider-b
    const legit = await useCase.execute(cmd());
    expect(legit).toMatchObject({ outcome: 'TRANSACTION', status: 'PROCESSED', idempotentReplay: false });
    if (squat.outcome === 'TRANSACTION' && legit.outcome === 'TRANSACTION') {
      expect(legit.transactionId).not.toBe(squat.transactionId);
    }
    // a conflict for provider-b never exposes provider-a's transaction id
    const conflict = await useCase.execute(
      cmd({
        providerId: 'provider-b',
        externalTransactionId: 'b-1',
        idempotencyKey: 'provider-a:tx-1',
        money: { amount: '1.00', currency: 'BRL' },
      }),
    );
    expect(conflict).toMatchObject({ outcome: 'IDEMPOTENCY_CONFLICT', reason: 'PAYLOAD_MISMATCH' });
    if (conflict.outcome === 'IDEMPOTENCY_CONFLICT' && squat.outcome === 'TRANSACTION') {
      expect(conflict.existingTransactionId).toBe(squat.transactionId);
    }
  });
});
