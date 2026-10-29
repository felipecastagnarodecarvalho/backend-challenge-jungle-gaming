import type { EntityManager } from '@mikro-orm/postgresql';
import type { InboxMessage } from '../../../application/messaging/inbox-message';
import type { InboxReceiveResult, InboxRepository } from '../../../application/ports/inbox-repository';
import { InboxMessageSchema } from '../schemas/inbox-message.schema';
import { asRows } from './sql-rows';

export class MikroInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  /**
   * Inserts the dedup row first thing in the transaction. If another
   * transaction is inserting the same (consumer, messageId), Postgres blocks
   * this INSERT until it ends: commit → DUPLICATE here; rollback → we insert.
   */
  async tryReceive(message: InboxMessage): Promise<InboxReceiveResult> {
    const inserted = asRows(
      await this.em.execute(
        `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, transaction_id, received_at, processed_at)
         VALUES (?, ?, ?, NULL, ?, NULL)
         ON CONFLICT (consumer_name, message_id) DO NOTHING
         RETURNING message_id`,
        [message.consumerName, message.messageId, message.payloadHash, message.receivedAt],
        'all',
      ),
    );
    if (inserted.length === 1) return { status: 'RECEIVED' };
    const existing = await this.em.findOne(
      InboxMessageSchema,
      { consumerName: message.consumerName, messageId: message.messageId },
      { disableIdentityMap: true },
    );
    return { status: 'DUPLICATE', existingPayloadHash: existing?.payloadHash ?? '' };
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      InboxMessageSchema,
      { consumerName: message.consumerName, messageId: message.messageId },
      { processedAt: message.processedAt ?? null, transactionId: message.transactionId ?? null },
    );
  }
}
