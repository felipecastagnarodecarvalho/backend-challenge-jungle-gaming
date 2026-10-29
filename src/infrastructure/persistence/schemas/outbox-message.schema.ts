import { EntitySchema } from '@mikro-orm/core';

export interface OutboxMessageRecord {
  id: string;
  aggregateType: string;
  aggregateId: string;
  partitionKey: string;
  eventType: string;
  eventVersion: number;
  payload: Record<string, unknown>;
  correlationId: string;
  causationId: string | null;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt: Date | null;
  lastError: string | null;
}

const tz = { type: 'datetime', columnType: 'timestamptz' } as const;

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  name: 'OutboxMessageRecord',
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateType: { type: 'text' },
    aggregateId: { type: 'text' },
    partitionKey: { type: 'text' },
    eventType: { type: 'text' },
    eventVersion: { type: 'integer' },
    payload: { type: 'json', columnType: 'jsonb' },
    correlationId: { type: 'text' },
    causationId: { type: 'text', nullable: true },
    occurredAt: { ...tz },
    attempts: { type: 'integer' },
    nextAttemptAt: { ...tz },
    publishedAt: { ...tz, nullable: true },
    lastError: { type: 'text', nullable: true },
  },
});
