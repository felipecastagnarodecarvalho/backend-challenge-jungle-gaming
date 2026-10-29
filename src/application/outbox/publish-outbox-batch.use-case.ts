import type { OutboxBackoff } from '../messaging/outbox-message';
import type { MetricsPort } from '../ports/metrics';
import type { Clock, FaultInjector, LoggerPort, MessagePublisher, PublishResult } from '../ports/system';
import type { UnitOfWork } from '../ports/unit-of-work';

export interface PublishOutboxDeps {
  uow: UnitOfWork;
  publisher: MessagePublisher;
  clock: Clock;
  metrics: MetricsPort;
  logger: LoggerPort;
  faults: FaultInjector;
  batchSize: number;
  leaseMs: number;
  backoff: OutboxBackoff;
}

/**
 * One outbox publishing cycle: claim (short tx) → publish (no tx open during
 * network I/O) → mark published / schedule retry (short tx).
 *
 * Delivery is at-least-once: a crash after publishing but before marking, or a
 * lease that expires mid-publish, yields a duplicate — consumers dedupe by
 * eventId (also the FIFO MessageDeduplicationId). Nothing is ever dropped:
 * failures back off exponentially without an attempt limit.
 */
export class PublishOutboxBatchUseCase {
  constructor(private readonly deps: PublishOutboxDeps) {}

  /** Returns how many messages were claimed (a full batch means "run again now"). */
  async runOnce(): Promise<number> {
    const { uow, publisher, clock, metrics, logger, faults, batchSize, leaseMs, backoff } = this.deps;
    const claimed = await uow.run((s) => s.outbox.claimDue(batchSize, leaseMs));
    if (claimed.length === 0) return 0;

    faults.afterOutboxClaim();

    let results: PublishResult[];
    try {
      results = await publisher.publishBatch(claimed);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      results = claimed.map((m) => ({ id: m.id, ok: false, error }));
    }
    const byId = new Map(results.map((r) => [r.id, r]));
    const now = clock.now();
    const published = claimed.filter((m) => byId.get(m.id)?.ok === true);
    const failed = claimed.filter((m) => byId.get(m.id)?.ok !== true);

    await uow.run(async (s) => {
      if (published.length > 0)
        await s.outbox.markPublished(
          published.map((m) => m.id),
          now,
        );
      for (const message of failed) {
        message.scheduleRetry(now, byId.get(message.id)?.error ?? 'not published', backoff);
        await s.outbox.saveRetry(message);
      }
    });

    for (const message of published) {
      metrics.outboxPublished(message.eventType, Math.max(0, (now.getTime() - message.occurredAt.getTime()) / 1000));
    }
    for (const message of failed) {
      metrics.outboxFailure();
      const log = message.attempts >= 10 ? logger.error.bind(logger) : logger.warn.bind(logger);
      log(
        { eventId: message.id, eventType: message.eventType, attempts: message.attempts, error: message.lastError },
        'outbox publish failed; retry scheduled',
      );
    }
    return claimed.length;
  }
}
