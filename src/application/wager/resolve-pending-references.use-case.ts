import { FailureCode } from '../../domain/wager/failure-code';
import { WagerTransactionStatus } from '../../domain/wager/wager-transaction-status';
import { TransientInfrastructureError } from '../errors';
import { WagerTransactionFailed } from '../messaging/events';
import type { EventContext } from '../messaging/integration-event';
import { OutboxMessage } from '../messaging/outbox-message';
import type { MetricsPort } from '../ports/metrics';
import type { Clock, IdGenerator, LoggerPort } from '../ports/system';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { PendingReferenceClaim } from '../ports/wager-transaction-repository';
import { type RetryPolicy, withTransientRetry } from '../shared/transient-retry';
import type { WagerEvaluator } from './wager-evaluator';

export interface ResolvePendingReferencesDeps {
  uow: UnitOfWork;
  evaluator: WagerEvaluator;
  clock: Clock;
  ids: IdGenerator;
  metrics: MetricsPort;
  logger: LoggerPort;
  retry: RetryPolicy;
  batchSize: number;
  leaseMs: number;
}

const CAUSATION = 'pending-reference-worker';

/**
 * Re-evaluates PENDING_REFERENCE transactions whose next check is due.
 *
 * Claim (short tx, `SKIP LOCKED` + lease) → one transaction per item that
 * locks wallet then tx (same lock order as submissions, so no deadlock cycle)
 * and re-runs the same evaluator. Safe with many instances: a row already
 * resolved by someone else is simply skipped; a crashed worker's lease expires.
 */
export class ResolvePendingReferencesUseCase {
  constructor(private readonly deps: ResolvePendingReferencesDeps) {}

  /** Processes one batch; returns how many items were claimed. */
  async runOnce(): Promise<number> {
    const { uow, batchSize, leaseMs } = this.deps;
    const claims = await uow.run((s) => s.transactions.claimDuePendingReferences(batchSize, leaseMs));
    for (const claim of claims) {
      await this.resolveSafely(claim);
    }
    return claims.length;
  }

  private async resolveSafely(claim: PendingReferenceClaim): Promise<void> {
    const { logger, metrics, retry } = this.deps;
    const log = logger.child({ transactionId: claim.id, walletId: claim.walletId });
    try {
      await withTransientRetry(() => this.resolve(claim), retry, metrics, 'resolve_pending_reference');
    } catch (err) {
      if (err instanceof TransientInfrastructureError) {
        // Leave it: the lease expires and the item is retried later.
        log.warn({ reason: err.reason }, 'pending reference resolution postponed (transient failure)');
        return;
      }
      // Unexpected permanent error: park the transaction as FAILED instead of looping forever.
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'pending reference resolution failed');
      await this.failItem(claim).catch((failErr: unknown) =>
        log.error({ err: failErr instanceof Error ? failErr.message : String(failErr) }, 'could not mark FAILED'),
      );
    }
  }

  private async resolve(claim: PendingReferenceClaim): Promise<void> {
    const { uow, clock, evaluator, metrics, logger } = this.deps;
    const outcome = await uow.run(async (scope) => {
      const wallet = await scope.wallets.findByIdForUpdate(claim.walletId);
      const tx = await scope.transactions.findByIdForUpdate(claim.id);
      if (!wallet || !tx || tx.status !== WagerTransactionStatus.PendingReference) {
        return undefined; // already resolved by another instance
      }
      const now = clock.now();
      const result = await evaluator.apply({
        scope,
        tx,
        wallet,
        now,
        ctx: this.context(tx.correlationId ?? tx.id, now),
        mode: { type: 'resolve' },
      });
      return { result, tx };
    });
    if (!outcome) return;
    const { result, tx } = outcome;
    const log = logger.child({
      transactionId: tx.id,
      walletId: tx.walletId,
      providerId: tx.providerId,
      correlationId: tx.correlationId,
    });
    if (result.kind === 'REFERENCE_MISS') {
      if (result.expired) {
        metrics.pendingReferenceExpired();
        metrics.rejection(FailureCode.ReferenceNotFound);
        log.warn({ attempts: tx.referenceAttempts }, 'pending reference expired: REFERENCE_NOT_FOUND');
      } else {
        metrics.pendingReferenceRetry();
        log.debug({ attempts: tx.referenceAttempts }, 'reference still missing, rescheduled');
      }
      return;
    }
    if (tx.failureCode) metrics.rejection(tx.failureCode);
    metrics.transactionCompleted({
      kind: tx.kind,
      status: tx.status,
      source: 'worker',
      replay: false,
      durationMs: 0,
      outcome: 'TRANSACTION',
    });
    log.info({ status: tx.status, failureCode: tx.failureCode ?? null }, 'pending reference resolved');
  }

  private async failItem(claim: PendingReferenceClaim): Promise<void> {
    const { uow, clock } = this.deps;
    await uow.run(async (scope) => {
      await scope.wallets.findByIdForUpdate(claim.walletId);
      const tx = await scope.transactions.findByIdForUpdate(claim.id);
      if (!tx || tx.status !== WagerTransactionStatus.PendingReference) return;
      const now = clock.now();
      tx.fail({ code: FailureCode.ProcessingError, at: now });
      await scope.transactions.update(tx, WagerTransactionStatus.PendingReference);
      await scope.outbox.enqueue([
        OutboxMessage.enqueue(WagerTransactionFailed.from(tx, this.context(tx.correlationId ?? tx.id, now))),
      ]);
    });
  }

  private context(correlationId: string, now: Date): EventContext {
    return { correlationId, causationId: CAUSATION, occurredAt: now, nextId: () => this.deps.ids.next() };
  }
}
