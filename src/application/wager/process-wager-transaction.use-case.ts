import { InvalidMoneyError, Money } from '../../domain/money/money';
import { DomainError } from '../../domain/shared/domain-error';
import { InvalidWagerTransactionError } from '../../domain/wager/wager.errors';
import { WagerTransaction } from '../../domain/wager/wager-transaction';
import { ValidationError } from '../errors';
import { InboxMessage } from '../messaging/inbox-message';
import type { EventContext } from '../messaging/integration-event';
import type { MetricsPort } from '../ports/metrics';
import type { Clock, FaultInjector, IdGenerator, LoggerPort } from '../ports/system';
import type { TransactionScope, UnitOfWork } from '../ports/unit-of-work';
import { KeyedSerializer } from '../shared/keyed-serializer';
import { type RetryPolicy, withTransientRetry } from '../shared/transient-retry';
import { computeWagerPayloadHash } from './payload-hash';
import type { ProcessWagerCommand } from './process-wager-command';
import type { WagerEvaluator } from './wager-evaluator';
import { type ProcessWagerResult, toResultFromTransaction } from './wager-result';

export interface ProcessWagerDeps {
  uow: UnitOfWork;
  evaluator: WagerEvaluator;
  clock: Clock;
  ids: IdGenerator;
  metrics: MetricsPort;
  logger: LoggerPort;
  faults: FaultInjector;
  retry: RetryPolicy;
  /** Per-wallet in-process queue shared with the pending-reference worker (optimisation only). */
  walletGate?: KeyedSerializer;
}

/**
 * The single entry point for provider operations — used verbatim by the HTTP
 * controller and the SQS consumer.
 *
 * Everything happens in ONE SQL transaction: inbox dedup (SQS), wallet row
 * lock, idempotency lookup, decision, transaction row, balance, ledger and
 * outbox events. Correctness rests on the database, not on the broker:
 * - the wallet `FOR UPDATE` lock serializes all writers of one wallet across
 *   any number of instances (no global lock);
 * - idempotency is checked *after* acquiring the lock, so the second of two
 *   concurrent identical requests sees the first one's committed row and replays;
 * - `UNIQUE(idempotency_key)` + `ON CONFLICT DO NOTHING` cover the residual race
 *   (same key, different wallet ids), resolved by a retry;
 * - events are only written to the outbox — never published before COMMIT.
 */
export class ProcessWagerTransactionUseCase {
  private readonly gate: KeyedSerializer;

  constructor(private readonly deps: ProcessWagerDeps) {
    this.gate = deps.walletGate ?? new KeyedSerializer();
  }

  async execute(rawCmd: ProcessWagerCommand): Promise<ProcessWagerResult> {
    // Ids are canonical lowercase UUIDs before hashing/comparing (edges normalise too; this is the safety net).
    const cmd: ProcessWagerCommand = {
      ...rawCmd,
      playerId: rawCmd.playerId.toLowerCase(),
      walletId: rawCmd.walletId.toLowerCase(),
    };
    const startedAt = performance.now();
    const payloadHash = computeWagerPayloadHash(cmd);
    // Fail fast on invalid commands, before opening a transaction (and before touching the inbox).
    this.buildTransaction(cmd, payloadHash, this.deps.clock.now());

    const sourceLabel = cmd.source.type === 'SQS' ? 'sqs' : 'http';
    // Same-wallet requests queue in-process first (no DB connection held while waiting); the row lock
    // inside the transaction remains the cross-instance guarantee.
    const result = await this.gate.run(cmd.walletId, () =>
      withTransientRetry(
        () => this.deps.uow.run((scope) => this.attempt(scope, cmd, payloadHash)),
        this.deps.retry,
        this.deps.metrics,
        'process_wager',
      ),
    );
    this.observe(cmd, result, sourceLabel, performance.now() - startedAt);
    return result;
  }

  private async attempt(
    scope: TransactionScope,
    cmd: ProcessWagerCommand,
    payloadHash: string,
  ): Promise<ProcessWagerResult> {
    const { clock, metrics, logger, faults, evaluator } = this.deps;
    const now = clock.now();

    // 1. Inbox: dedupe the *message* (redelivery) before anything else.
    let inbox: InboxMessage | undefined;
    if (cmd.source.type === 'SQS') {
      inbox = InboxMessage.receive({
        consumerName: cmd.source.consumerName,
        messageId: cmd.source.messageId,
        payloadHash: cmd.source.messageHash,
        receivedAt: now,
      });
      const received = await scope.inbox.tryReceive(inbox);
      if (received.status === 'DUPLICATE') {
        if (received.existingPayloadHash !== cmd.source.messageHash) {
          logger.warn(
            { messageId: cmd.source.messageId, correlationId: cmd.correlationId },
            'messageId reused with a different body',
          );
        }
        return { outcome: 'DUPLICATE_MESSAGE' };
      }
    }

    await faults.delayInTransaction();

    // 2. Serialize on the wallet row.
    const lockStartedAt = performance.now();
    const wallet = await scope.wallets.findByIdForUpdate(cmd.walletId);
    metrics.lockWait((performance.now() - lockStartedAt) / 1000);

    const finishInbox = async (transactionId?: string) => {
      if (inbox) {
        const at = new Date(Math.max(clock.now().getTime(), inbox.receivedAt.getTime()));
        inbox.markProcessed(at, transactionId);
        await scope.inbox.markProcessed(inbox);
      }
    };

    // 3. Idempotency, re-checked under the lock (sees every commit that preceded it).
    const existing = await scope.transactions.findForIdempotency(
      cmd.idempotencyKey,
      cmd.providerId,
      cmd.externalTransactionId,
    );
    if (existing.length > 0) {
      const byKey = existing.find((t) => t.idempotencyKey === cmd.idempotencyKey);
      const byExternal = existing.find(
        (t) => t.providerId === cmd.providerId && t.externalTransactionId === cmd.externalTransactionId,
      );
      const row = byKey ?? byExternal;
      if (!row) throw new Error('unreachable: idempotency lookup returned unrelated rows');
      let conflict: 'PAYLOAD_MISMATCH' | 'EXTERNAL_ID_BOUND_TO_OTHER_KEY' | 'KEY_AND_EXTERNAL_ID_MISMATCH' | undefined;
      if (byKey && byExternal && byKey.id !== byExternal.id) conflict = 'KEY_AND_EXTERNAL_ID_MISMATCH';
      else if (row.idempotencyKey !== cmd.idempotencyKey) conflict = 'EXTERNAL_ID_BOUND_TO_OTHER_KEY';
      else if (!row.matchesPayload(payloadHash)) conflict = 'PAYLOAD_MISMATCH';

      await finishInbox(row.id);
      if (conflict) {
        return { outcome: 'IDEMPOTENCY_CONFLICT', reason: conflict, existingTransactionId: row.id };
      }
      return toResultFromTransaction(row, true);
    }

    if (!wallet) {
      await finishInbox();
      return { outcome: 'WALLET_NOT_FOUND' };
    }

    // 4. New transaction: decide and apply atomically.
    const tx = this.buildTransaction(cmd, payloadHash, now);
    const ctx: EventContext = {
      correlationId: cmd.correlationId,
      causationId: cmd.source.type === 'SQS' ? cmd.source.messageId : cmd.source.requestId,
      occurredAt: now,
      nextId: () => this.deps.ids.next(),
    };
    await evaluator.apply({ scope, tx, wallet, now, ctx, mode: { type: 'insert' } });
    await finishInbox(tx.id);
    return toResultFromTransaction(tx, false);
  }

  private buildTransaction(cmd: ProcessWagerCommand, payloadHash: string, now: Date): WagerTransaction {
    try {
      return WagerTransaction.create({
        id: this.deps.ids.next(),
        providerId: cmd.providerId,
        externalTransactionId: cmd.externalTransactionId,
        idempotencyKey: cmd.idempotencyKey,
        payloadHash,
        walletId: cmd.walletId,
        playerId: cmd.playerId,
        roundId: cmd.roundId,
        gameId: cmd.gameId,
        kind: cmd.kind,
        money: Money.from(cmd.money),
        referenceExternalTransactionId: cmd.referenceExternalTransactionId,
        source: cmd.source.type,
        correlationId: cmd.correlationId,
        createdAt: now,
      });
    } catch (err) {
      if (err instanceof InvalidMoneyError || err instanceof InvalidWagerTransactionError) {
        throw new ValidationError([{ path: err instanceof InvalidMoneyError ? 'money' : '', message: err.message }]);
      }
      if (err instanceof DomainError) {
        throw new ValidationError([{ path: '', message: err.message }]);
      }
      throw err;
    }
  }

  private observe(cmd: ProcessWagerCommand, result: ProcessWagerResult, source: 'http' | 'sqs', durationMs: number) {
    const { metrics, logger } = this.deps;
    const base = {
      correlationId: cmd.correlationId,
      providerId: cmd.providerId,
      walletId: cmd.walletId,
      externalTransactionId: cmd.externalTransactionId,
      kind: cmd.kind,
      ...(cmd.source.type === 'SQS' ? { messageId: cmd.source.messageId } : {}),
    };
    switch (result.outcome) {
      case 'TRANSACTION':
        metrics.transactionCompleted({
          kind: cmd.kind,
          status: result.status,
          source,
          replay: result.idempotentReplay,
          durationMs,
          outcome: result.outcome,
        });
        if (result.idempotentReplay) metrics.duplicate(source, 'replay');
        else if (result.failureCode) metrics.rejection(result.failureCode);
        logger.info(
          {
            ...base,
            transactionId: result.transactionId,
            status: result.status,
            failureCode: result.failureCode,
            replay: result.idempotentReplay,
          },
          'wager transaction handled',
        );
        break;
      case 'IDEMPOTENCY_CONFLICT':
        metrics.duplicate(source, 'conflict');
        metrics.transactionCompleted({
          kind: cmd.kind,
          status: 'CONFLICT',
          source,
          replay: false,
          durationMs,
          outcome: result.outcome,
        });
        logger.warn(
          { ...base, transactionId: result.existingTransactionId, reason: result.reason },
          'idempotency conflict',
        );
        break;
      case 'WALLET_NOT_FOUND':
        metrics.rejection('WALLET_NOT_FOUND');
        metrics.transactionCompleted({
          kind: cmd.kind,
          status: 'WALLET_NOT_FOUND',
          source,
          replay: false,
          durationMs,
          outcome: result.outcome,
        });
        logger.warn(base, 'wallet not found');
        break;
      case 'DUPLICATE_MESSAGE':
        metrics.duplicate('sqs', 'inbox');
        logger.info(base, 'duplicate message ignored (inbox)');
        break;
    }
  }
}
