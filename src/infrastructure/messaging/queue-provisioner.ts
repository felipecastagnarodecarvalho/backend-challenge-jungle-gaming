import { CreateQueueCommand, GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';

export interface QueueNames {
  wagerQueue: string;
  wagerDlq: string;
  eventsQueue: string;
}

export interface QueueOptions {
  visibilityTimeoutS: number;
  maxReceiveCount: number;
}

/**
 * Idempotently creates the FIFO queues: DLQ first (to get its ARN), then the
 * main queue with a redrive policy (`maxReceiveCount`), then the events queue
 * used by the outbox publisher. Content-based dedup is off: producers set an
 * explicit MessageDeduplicationId (messageId / eventId).
 */
export async function ensureQueues(
  client: SQSClient,
  names: QueueNames,
  opts: QueueOptions,
): Promise<Record<string, string>> {
  const dlq = await client.send(
    new CreateQueueCommand({
      QueueName: names.wagerDlq,
      Attributes: { FifoQueue: 'true', MessageRetentionPeriod: '1209600', ContentBasedDeduplication: 'false' },
    }),
  );
  const dlqAttrs = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'] }),
  );
  const dlqArn = dlqAttrs.Attributes?.QueueArn;
  if (!dlqArn) throw new Error('DLQ ARN not available');
  const main = await client.send(
    new CreateQueueCommand({
      QueueName: names.wagerQueue,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        VisibilityTimeout: String(opts.visibilityTimeoutS),
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: opts.maxReceiveCount }),
      },
    }),
  );
  const events = await client.send(
    new CreateQueueCommand({
      QueueName: names.eventsQueue,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
    }),
  );
  return {
    [names.wagerDlq]: dlq.QueueUrl ?? '',
    [names.wagerQueue]: main.QueueUrl ?? '',
    [names.eventsQueue]: events.QueueUrl ?? '',
  };
}
