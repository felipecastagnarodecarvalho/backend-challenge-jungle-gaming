import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { QueueRegistry } from '../messaging/queue-registry';

/** Reads approximate depths of the main queue and its DLQ (captures redrive moves too). */
export function createQueueDepthSource(client: SQSClient, queues: QueueRegistry, names: { main: string; dlq: string }) {
  return async () => {
    const read = async (queue: 'main' | 'dlq', name: string) => {
      const r = await client.send(
        new GetQueueAttributesCommand({
          QueueUrl: await queues.url(name),
          AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
        }),
      );
      return {
        queue,
        visible: Number(r.Attributes?.ApproximateNumberOfMessages ?? 0),
        inflight: Number(r.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
      };
    };
    return Promise.all([read('main', names.main), read('dlq', names.dlq)]);
  };
}
