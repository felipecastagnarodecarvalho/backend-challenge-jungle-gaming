import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';
import type { MetricsPort } from '../../application/ports/metrics';

export interface GaugeSources {
  outboxPending(): Promise<{ count: number; oldestAgeSeconds: number }>;
  pendingReferences(): Promise<number>;
  queueDepths(): Promise<Array<{ queue: 'main' | 'dlq'; visible: number; inflight: number }>>;
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('gauge timeout')), ms))]);

/**
 * All `wagering_*` metrics. Counters/histograms are fed through the semantic
 * MetricsPort; gauges that need I/O (outbox lag, pending references, queue
 * depth) are computed lazily on scrape with a 1 s timeout — on failure they
 * keep their previous value.
 */
export class PrometheusMetrics implements MetricsPort {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wagering_transactions_total',
    help: 'Wager transactions handled, by kind/status/source/replay',
    labelNames: ['kind', 'status', 'source', 'replay'] as const,
    registers: [this.registry],
  });
  private readonly rejections = new Counter({
    name: 'wagering_transaction_rejections_total',
    help: 'Business rejections by failure code',
    labelNames: ['failure_code'] as const,
    registers: [this.registry],
  });
  private readonly duplicates = new Counter({
    name: 'wagering_duplicates_total',
    help: 'Duplicates detected (idempotent replay, idempotency conflict, inbox redelivery)',
    labelNames: ['source', 'type'] as const,
    registers: [this.registry],
  });
  private readonly retries = new Counter({
    name: 'wagering_processing_retries_total',
    help: 'Internal transient retries',
    labelNames: ['operation', 'reason'] as const,
    registers: [this.registry],
  });
  private readonly lockConflicts = new Counter({
    name: 'wagering_lock_conflicts_total',
    help: 'Lock timeouts, deadlocks and serialization failures',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });
  private readonly lockWaitHistogram = new Histogram({
    name: 'wagering_wallet_lock_wait_seconds',
    help: 'Time waiting for the wallet row lock',
    buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  private readonly processingDuration = new Histogram({
    name: 'wagering_processing_duration_seconds',
    help: 'End-to-end processing latency of the wager use case',
    labelNames: ['source', 'outcome'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });
  private readonly sqsMessages = new Counter({
    name: 'wagering_sqs_messages_total',
    help: 'SQS messages by handling result',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });
  private readonly dlqMessages = new Counter({
    name: 'wagering_sqs_dlq_messages_total',
    help: 'Messages explicitly sent to the DLQ (poison)',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });
  private readonly outboxPublishedCounter = new Counter({
    name: 'wagering_outbox_published_total',
    help: 'Outbox events published',
    labelNames: ['event_type'] as const,
    registers: [this.registry],
  });
  private readonly outboxFailures = new Counter({
    name: 'wagering_outbox_publish_failures_total',
    help: 'Outbox publish failures (retried with backoff)',
    registers: [this.registry],
  });
  private readonly outboxLag = new Histogram({
    name: 'wagering_outbox_publish_lag_seconds',
    help: 'Time between event occurrence (commit) and publication',
    labelNames: ['event_type'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300],
    registers: [this.registry],
  });
  private readonly pendingRefRetries = new Counter({
    name: 'wagering_pending_reference_retries_total',
    help: 'PENDING_REFERENCE re-checks where the reference was still missing',
    registers: [this.registry],
  });
  private readonly pendingRefExpired = new Counter({
    name: 'wagering_pending_reference_expired_total',
    help: 'PENDING_REFERENCE transactions rejected as REFERENCE_NOT_FOUND',
    registers: [this.registry],
  });
  private readonly reconciliationChecks = new Counter({
    name: 'wagering_reconciliation_checks_total',
    help: 'Reconciliation runs by result',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });
  private readonly reconciliationMismatches = new Counter({
    name: 'wagering_reconciliation_mismatches_total',
    help: 'Wallets found inconsistent by reconciliation',
    registers: [this.registry],
  });
  readonly httpDuration = new Histogram({
    name: 'wagering_http_request_duration_seconds',
    help: 'HTTP request latency',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  constructor(defaultLabels: Record<string, string> = {}) {
    this.registry.setDefaultLabels(defaultLabels);
    collectDefaultMetrics({ register: this.registry });
  }

  /** Registers the scrape-time gauges (called once the data sources exist). */
  registerGauges(sources: GaugeSources, onError: (what: string, err: unknown) => void): void {
    let lastOutbox = { count: 0, oldestAgeSeconds: 0 };
    let lastPending = 0;
    let lastQueues: Awaited<ReturnType<GaugeSources['queueDepths']>> = [];
    const refreshOutbox = async () => {
      try {
        lastOutbox = await withTimeout(sources.outboxPending(), 1000);
      } catch (err) {
        onError('outbox', err);
      }
    };
    new Gauge({
      name: 'wagering_outbox_pending_messages',
      help: 'Unpublished outbox messages',
      registers: [this.registry],
      async collect() {
        await refreshOutbox();
        this.set(lastOutbox.count);
      },
    });
    new Gauge({
      name: 'wagering_outbox_oldest_pending_age_seconds',
      help: 'Outbox lag: age of the oldest unpublished event',
      registers: [this.registry],
      async collect() {
        await refreshOutbox();
        this.set(lastOutbox.oldestAgeSeconds);
      },
    });
    new Gauge({
      name: 'wagering_pending_references',
      help: 'Transactions waiting for their reference',
      registers: [this.registry],
      async collect() {
        try {
          lastPending = await withTimeout(sources.pendingReferences(), 1000);
        } catch (err) {
          onError('pending_references', err);
        }
        this.set(lastPending);
      },
    });
    new Gauge({
      name: 'wagering_sqs_queue_messages',
      help: 'Approximate SQS queue depth (includes messages moved by redrive to the DLQ)',
      labelNames: ['queue', 'state'] as const,
      registers: [this.registry],
      async collect() {
        try {
          lastQueues = await withTimeout(sources.queueDepths(), 1000);
        } catch (err) {
          onError('sqs_queues', err);
        }
        for (const q of lastQueues) {
          this.set({ queue: q.queue, state: 'visible' }, q.visible);
          this.set({ queue: q.queue, state: 'inflight' }, q.inflight);
        }
      },
    });
  }

  // ---- MetricsPort ----------------------------------------------------------

  transactionCompleted(p: {
    kind: string;
    status: string;
    source: string;
    replay: boolean;
    durationMs: number;
    outcome: string;
  }): void {
    this.transactions.inc({ kind: p.kind, status: p.status, source: p.source, replay: String(p.replay) });
    if (p.durationMs > 0)
      this.processingDuration.observe({ source: p.source, outcome: p.outcome }, p.durationMs / 1000);
  }
  rejection(failureCode: string): void {
    this.rejections.inc({ failure_code: failureCode });
  }
  duplicate(source: 'http' | 'sqs', type: 'replay' | 'conflict' | 'inbox'): void {
    this.duplicates.inc({ source, type });
  }
  retry(operation: string, reason: string): void {
    this.retries.inc({ operation, reason });
  }
  lockConflict(reason: 'lock_timeout' | 'deadlock' | 'serialization'): void {
    this.lockConflicts.inc({ reason });
  }
  lockWait(seconds: number): void {
    this.lockWaitHistogram.observe(seconds);
  }
  sqsMessage(result: 'ack' | 'duplicate' | 'retry' | 'dlq'): void {
    this.sqsMessages.inc({ result });
  }
  dlq(reason: string): void {
    this.dlqMessages.inc({ reason });
  }
  outboxPublished(eventType: string, lagSeconds: number): void {
    this.outboxPublishedCounter.inc({ event_type: eventType });
    this.outboxLag.observe({ event_type: eventType }, lagSeconds);
  }
  outboxFailure(): void {
    this.outboxFailures.inc();
  }
  pendingReferenceRetry(): void {
    this.pendingRefRetries.inc();
  }
  pendingReferenceExpired(): void {
    this.pendingRefExpired.inc();
  }
  reconciliation(consistent: boolean): void {
    this.reconciliationChecks.inc({ result: consistent ? 'consistent' : 'inconsistent' });
    if (!consistent) this.reconciliationMismatches.inc();
  }
}
