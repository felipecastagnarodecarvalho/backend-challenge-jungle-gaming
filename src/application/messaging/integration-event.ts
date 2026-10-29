export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

/** Per-operation context used to stamp events (ids, correlation/causation, time). */
export interface EventContext {
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  nextId: () => string;
}

export interface IntegrationEventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

/**
 * Envelope of every integration event written to the outbox. Subclasses fix
 * `eventType`/`version` in the type (not as loose strings at the call site)
 * and carry only JSON-stable data (`MoneyProps`, never `Money`).
 */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  /** Aggregate family, stored in the outbox for routing/diagnostics. */
  abstract readonly aggregateType: 'WagerTransaction' | 'Wallet';

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = Object.freeze({ ...props.data });
  }

  /** Ordering/grouping key on the broker (FIFO MessageGroupId): always the wallet id. */
  abstract get partitionKey(): string;

  /** Serialized envelope stored as the outbox payload. */
  toJSON(): IntegrationEventEnvelope<T> {
    const envelope: IntegrationEventEnvelope<T> = {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: { ...this.data } as T,
    };
    if (this.causationId !== undefined) {
      envelope.causationId = this.causationId;
    }
    return envelope;
  }
}
