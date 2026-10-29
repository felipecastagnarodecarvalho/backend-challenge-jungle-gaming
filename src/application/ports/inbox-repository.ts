import type { InboxMessage } from '../messaging/inbox-message';

export type InboxReceiveResult = { status: 'RECEIVED' } | { status: 'DUPLICATE'; existingPayloadHash: string };

export interface InboxRepository {
  /**
   * `INSERT … ON CONFLICT DO NOTHING`. A concurrent insert of the same key
   * blocks until the other transaction ends; if it committed, this is DUPLICATE.
   */
  tryReceive(message: InboxMessage): Promise<InboxReceiveResult>;
  markProcessed(message: InboxMessage): Promise<void>;
}
