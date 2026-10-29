import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { OutboxMessage } from '../../application/messaging/outbox-message';
import type { MessagePublisher, PublishResult } from '../../application/ports/system';
import type { QueueRegistry } from './queue-registry';

const SQS_BATCH_LIMIT = 10;

/**
 * Publishes outbox messages to the FIFO events queue. `MessageGroupId` =
 * wallet id (per-wallet ordering as best effort), `MessageDeduplicationId` =
 * eventId (broker-side dedup within 5 min — an optimisation; consumers must
 * still dedupe by eventId).
 */
export class SqsMessagePublisher implements MessagePublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queues: QueueRegistry,
    private readonly queueName: string,
  ) {}

  async publishBatch(messages: OutboxMessage[]): Promise<PublishResult[]> {
    const url = await this.queues.url(this.queueName);
    const results: PublishResult[] = [];
    for (let i = 0; i < messages.length; i += SQS_BATCH_LIMIT) {
      const chunk = messages.slice(i, i + SQS_BATCH_LIMIT);
      try {
        const response = await this.client.send(
          new SendMessageBatchCommand({
            QueueUrl: url,
            Entries: chunk.map((m, idx) => ({
              Id: String(idx),
              MessageBody: JSON.stringify(m.payload),
              MessageGroupId: m.partitionKey,
              MessageDeduplicationId: m.id,
              MessageAttributes: {
                eventType: { DataType: 'String', StringValue: m.eventType },
                eventId: { DataType: 'String', StringValue: m.id },
                correlationId: { DataType: 'String', StringValue: m.correlationId },
              },
            })),
          }),
        );
        const failed = new Map((response.Failed ?? []).map((f) => [f.Id, f.Message ?? f.Code ?? 'failed']));
        chunk.forEach((m, idx) => {
          const error = failed.get(String(idx));
          results.push(error ? { id: m.id, ok: false, error } : { id: m.id, ok: true });
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        for (const m of chunk) results.push({ id: m.id, ok: false, error });
      }
    }
    return results;
  }
}
