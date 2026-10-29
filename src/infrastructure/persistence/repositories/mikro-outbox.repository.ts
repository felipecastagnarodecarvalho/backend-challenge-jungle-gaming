import type { EntityManager } from '@mikro-orm/postgresql';
import type { OutboxMessage } from '../../../application/messaging/outbox-message';
import type { OutboxRepository } from '../../../application/ports/outbox-repository';
import { OutboxMessageMapper } from '../mappers';
import { type OutboxMessageRecord, OutboxMessageSchema } from '../schemas/outbox-message.schema';
import { asRows, camelRow } from './sql-rows';

export class MikroOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async enqueue(messages: OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.em.insertMany(OutboxMessageSchema, messages.map(OutboxMessageMapper.toRecord));
  }

  /**
   * Claim + lease in one short transaction. `FOR UPDATE SKIP LOCKED` makes
   * concurrent publishers take disjoint batches; pushing `next_attempt_at`
   * forward hides the claimed rows while they are published *outside* any
   * transaction. If the publisher dies, the rows become due again after the lease.
   */
  async claimDue(limit: number, leaseMs: number): Promise<OutboxMessage[]> {
    const rows = asRows(
      await this.em.execute(
        `WITH due AS (
           SELECT id FROM outbox_messages
            WHERE published_at IS NULL AND next_attempt_at <= now()
            ORDER BY next_attempt_at, occurred_at
            LIMIT ? FOR UPDATE SKIP LOCKED)
         UPDATE outbox_messages o SET next_attempt_at = now() + (? * interval '1 millisecond')
           FROM due WHERE o.id = due.id
         RETURNING o.*`,
        [limit, leaseMs],
        'all',
      ),
    );
    return rows
      .map((row) => OutboxMessageMapper.toDomain(camelRow<OutboxMessageRecord>(row)))
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  }

  /** Idempotent: only flips rows still unpublished. */
  async markPublished(ids: string[], at: Date): Promise<number> {
    if (ids.length === 0) return 0;
    return this.em.nativeUpdate(OutboxMessageSchema, { id: { $in: ids }, publishedAt: null }, { publishedAt: at });
  }

  async saveRetry(message: OutboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      OutboxMessageSchema,
      { id: message.id, publishedAt: null },
      {
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt ?? new Date(),
        lastError: message.lastError ?? null,
      },
    );
  }
}
