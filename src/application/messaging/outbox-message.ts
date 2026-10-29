import { exponentialBackoffMs } from './backoff';
import type { IntegrationEvent } from './integration-event';

export interface OutboxBackoff {
  baseMs: number;
  maxMs: number;
}

export const DEFAULT_OUTBOX_BACKOFF: OutboxBackoff = { baseMs: 1_000, maxMs: 300_000 };

export interface OutboxMessageState {
  id: string;
  aggregateType: string;
  aggregateId: string;
  partitionKey: string;
  eventType: string;
  eventVersion: number;
  payload: Readonly<Record<string, unknown>>;
  correlationId: string;
  causationId: string | undefined;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | undefined;
  publishedAt: Date | undefined;
  lastError: string | undefined;
}

/**
 * Transactional-outbox row: an integration event persisted in the *same* SQL
 * transaction as the financial change, published later by a worker
 * (at-least-once; consumers dedupe by `id` = eventId). Retries never give up:
 * a committed event is never discarded.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateType: string,
    public readonly aggregateId: string,
    public readonly partitionKey: string,
    public readonly eventType: string,
    public readonly eventVersion: number,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly correlationId: string,
    public readonly causationId: string | undefined,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _publishedAt: Date | undefined,
    private _lastError: string | undefined,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    // JSON round-trip guarantees a plain, JSON-stable object (no class instances, no Dates).
    const payload = JSON.parse(JSON.stringify(event.toJSON())) as Record<string, unknown>;
    return new OutboxMessage(
      event.eventId,
      event.aggregateType,
      event.aggregateId,
      event.partitionKey,
      event.eventType,
      event.version,
      payload,
      event.correlationId,
      event.causationId,
      event.occurredAt,
      0,
      event.occurredAt,
      undefined,
      undefined,
    );
  }

  static rehydrate(s: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      s.id,
      s.aggregateType,
      s.aggregateId,
      s.partitionKey,
      s.eventType,
      s.eventVersion,
      s.payload,
      s.correlationId,
      s.causationId,
      s.occurredAt,
      s.attempts,
      s.nextAttemptAt,
      s.publishedAt,
      s.lastError,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }
  get lastError(): string | undefined {
    return this._lastError;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime());
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new Error(`outbox message ${this.id} already published`);
    }
    this._publishedAt = at;
  }

  /** Increments attempts and schedules the next try with exponential backoff (1 s, 2 s, 4 s … 300 s). */
  scheduleRetry(now: Date, error?: string, backoff: OutboxBackoff = DEFAULT_OUTBOX_BACKOFF): void {
    if (!this.isPending()) {
      throw new Error(`outbox message ${this.id} already published`);
    }
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + exponentialBackoffMs(this._attempts, backoff.baseMs, backoff.maxMs));
    this._lastError = error?.slice(0, 500);
  }
}
