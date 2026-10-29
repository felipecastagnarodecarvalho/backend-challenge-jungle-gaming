import type { OutboxMessage } from '../messaging/outbox-message';

export interface OutboxRepository {
  enqueue(messages: OutboxMessage[]): Promise<void>;
  /**
   * Claims due messages with `FOR UPDATE SKIP LOCKED` and pushes `next_attempt_at`
   * by `leaseMs`, so concurrent publishers get disjoint batches and a crashed
   * publisher's claim expires on its own.
   */
  claimDue(limit: number, leaseMs: number): Promise<OutboxMessage[]>;
  markPublished(ids: string[], at: Date): Promise<number>;
  saveRetry(message: OutboxMessage): Promise<void>;
}
