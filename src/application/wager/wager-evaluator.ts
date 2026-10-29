import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import { FailureCode } from '../../domain/wager/failure-code';
import type { ReferenceRetryPolicy } from '../../domain/wager/reference-retry-policy';
import { type WagerDecision, WagerPolicy } from '../../domain/wager/wager-policy';
import type { WagerTransaction } from '../../domain/wager/wager-transaction';
import { WagerTransactionStatus } from '../../domain/wager/wager-transaction-status';
import type { Wallet } from '../../domain/wallet/wallet';
import { IdempotencyRaceError } from '../errors';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../messaging/events';
import type { EventContext, IntegrationEvent } from '../messaging/integration-event';
import { OutboxMessage } from '../messaging/outbox-message';
import type { IdGenerator } from '../ports/system';
import type { TransactionScope } from '../ports/unit-of-work';

/**
 * How the evaluated transaction is persisted:
 * - `insert`: a new submission (row inserted directly in its resulting state);
 * - `resolve`: the pending-reference worker re-evaluating a PENDING_REFERENCE row.
 */
export type EvaluationMode = { type: 'insert' } | { type: 'resolve' };

export interface EvaluationInput {
  scope: TransactionScope;
  tx: WagerTransaction;
  /** Locked by the caller (`SELECT … FOR UPDATE`). */
  wallet: Wallet;
  now: Date;
  ctx: EventContext;
  mode: EvaluationMode;
}

export type EvaluationOutcome =
  | { kind: 'DECIDED'; decision: WagerDecision; entry: WalletLedgerEntry | undefined }
  /** Worker only: reference still missing, attempt counted (and maybe expired). */
  | { kind: 'REFERENCE_MISS'; expired: boolean };

/**
 * Applies a {@link WagerPolicy} decision inside the caller's transaction —
 * shared by the submission use case and the pending-reference worker, so both
 * paths produce exactly the same ledger/outbox effects. Order of writes
 * respects FKs and the lock order (wallet already locked → tx row → ledger → outbox).
 */
export class WagerEvaluator {
  constructor(
    private readonly ids: IdGenerator,
    private readonly referencePolicy: ReferenceRetryPolicy,
  ) {}

  async apply(input: EvaluationInput): Promise<EvaluationOutcome> {
    const { scope, tx, wallet, now, ctx, mode } = input;

    // Reference resolution happens under the wallet lock: every mutation of
    // this wallet's transactions (including the reference's) is serialized by it.
    let reference: WagerTransaction | null = null;
    let alreadyReversed = false;
    if (tx.referenceExternalTransactionId !== undefined) {
      reference = await scope.transactions.findByProviderExternalId(tx.providerId, tx.referenceExternalTransactionId);
      if (reference && tx.isReversal()) {
        alreadyReversed = await scope.transactions.hasProcessedReversal(reference.id);
      }
    }

    const decision = WagerPolicy.decide({
      transaction: tx,
      wallet,
      reference,
      referenceAlreadyReversed: alreadyReversed,
    });
    const expectedStatus = tx.status;
    const expectedVersion = wallet.version;
    const events: IntegrationEvent<unknown>[] = [];
    let entry: WalletLedgerEntry | undefined;

    switch (decision.type) {
      case 'APPLY': {
        const movement = { entryId: this.ids.next(), transactionId: tx.id, money: tx.money, at: now };
        entry = decision.direction === 'DEBIT' ? wallet.debit(movement) : wallet.credit(movement);
        tx.markProcessed({
          referenceTransactionId: decision.referenceTransactionId,
          at: now,
          balanceAfter: wallet.balance,
          walletVersion: wallet.version,
        });
        events.push(WagerTransactionProcessed.from(tx, ctx), WalletBalanceChanged.from(wallet, entry, ctx));
        break;
      }
      case 'RECORD_ONLY':
        tx.markProcessed({
          referenceTransactionId: decision.referenceTransactionId,
          at: now,
          balanceAfter: wallet.balance,
          walletVersion: wallet.version,
        });
        events.push(WagerTransactionProcessed.from(tx, ctx));
        break;
      case 'REJECT':
        tx.reject({
          code: decision.failureCode,
          at: now,
          observedBalance: decision.exposeBalance ? wallet.balance : undefined,
          walletVersion: decision.exposeBalance ? wallet.version : undefined,
          referenceTransactionId: decision.referenceTransactionId,
        });
        events.push(WagerTransactionRejected.from(tx, ctx));
        break;
      case 'AWAIT_REFERENCE': {
        if (mode.type === 'insert') {
          tx.markPendingReference({
            at: now,
            nextCheckAt: new Date(now.getTime() + this.referencePolicy.initialDelayMs()),
            observedBalance: wallet.balance,
            walletVersion: wallet.version,
          });
          events.push(WagerTransactionPendingReference.from(tx, ctx));
          break;
        }
        // Worker: count the miss; expire as REFERENCE_NOT_FOUND once the window is exhausted.
        const attempts = tx.referenceAttempts + 1;
        const expired = this.referencePolicy.isExhausted(attempts);
        if (expired) {
          tx.reject({
            code: FailureCode.ReferenceNotFound,
            at: now,
            observedBalance: wallet.balance,
            walletVersion: wallet.version,
            countAttempt: true,
          });
          events.push(WagerTransactionRejected.from(tx, ctx));
        } else {
          tx.recordReferenceMiss({
            at: now,
            nextCheckAt: new Date(now.getTime() + this.referencePolicy.delayAfterMiss(attempts)),
          });
        }
        await scope.transactions.update(tx, expectedStatus);
        await scope.outbox.enqueue(events.map((e) => OutboxMessage.enqueue(e)));
        return { kind: 'REFERENCE_MISS', expired };
      }
    }

    // 1) the transaction row (the ledger FK points at it)
    if (mode.type === 'insert') {
      const inserted = await scope.transactions.insertIfAbsent(tx);
      if (!inserted) throw new IdempotencyRaceError();
    } else {
      await scope.transactions.update(tx, expectedStatus);
    }
    // 2) balance + ledger, only when money moved
    if (entry) {
      await scope.wallets.saveBalance(wallet, expectedVersion);
      await scope.ledger.append(entry);
    }
    // 3) wake up transactions waiting for this one (optimisation; the worker's schedule is the guarantee)
    if (tx.status === WagerTransactionStatus.Processed) {
      await scope.transactions.nudgeAwaiting(tx.providerId, tx.externalTransactionId, tx.walletId);
    }
    // 4) integration events in the same SQL transaction (transactional outbox)
    await scope.outbox.enqueue(events.map((e) => OutboxMessage.enqueue(e)));
    return { kind: 'DECIDED', decision, entry };
  }
}
