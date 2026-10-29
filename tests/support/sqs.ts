import {
  DeleteMessageBatchCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { ensureQueues } from '../../src/infrastructure/messaging/queue-provisioner';
import { TEST_AWS_ENDPOINT } from './env';

export const sqs = new SQSClient({
  region: 'us-east-1',
  endpoint: TEST_AWS_ENDPOINT,
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

export interface TestQueues {
  names: { wager: string; dlq: string; events: string };
  urls: { wager: string; dlq: string; events: string };
  /** Env vars pointing an app instance at these queues. */
  env: Record<string, string>;
}

/** Unique FIFO queues per test file (VisibilityTimeout=2 s, maxReceiveCount=3) — no cross-test interference. */
export async function createTestQueues(label: string): Promise<TestQueues> {
  const prefix = `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}-${label}`.slice(0, 50);
  const names = { wager: `${prefix}-wager.fifo`, dlq: `${prefix}-wager-dlq.fifo`, events: `${prefix}-events.fifo` };
  const urls = await ensureQueues(
    sqs,
    { wagerQueue: names.wager, wagerDlq: names.dlq, eventsQueue: names.events },
    { visibilityTimeoutS: 2, maxReceiveCount: 3 },
  );
  return {
    names,
    urls: { wager: urls[names.wager] as string, dlq: urls[names.dlq] as string, events: urls[names.events] as string },
    env: {
      SQS_WAGER_QUEUE_NAME: names.wager,
      SQS_WAGER_DLQ_NAME: names.dlq,
      SQS_EVENTS_QUEUE_NAME: names.events,
      SQS_MAX_RECEIVE_COUNT: '3',
    },
  };
}

export async function deleteTestQueues(q: TestQueues): Promise<void> {
  for (const url of Object.values(q.urls)) {
    await sqs.send(new DeleteQueueCommand({ QueueUrl: url })).catch(() => undefined);
  }
}

export interface WagerEnvelopeData {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export function envelope(messageId: string, data: WagerEnvelopeData) {
  return { messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data };
}

/** Sends one message. `dedupId` defaults to the messageId; pass a different one to force a broker-level duplicate. */
export async function sendRaw(url: string, body: string, groupId: string, dedupId: string): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: url,
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: dedupId,
    }),
  );
}

export async function sendWager(
  url: string,
  messageId: string,
  data: WagerEnvelopeData,
  dedupId = messageId,
): Promise<void> {
  await sendRaw(url, JSON.stringify(envelope(messageId, data)), data.walletId, dedupId);
}

export async function sendWagerBatch(
  url: string,
  items: Array<{ messageId: string; data: WagerEnvelopeData; dedupId?: string }>,
) {
  for (let i = 0; i < items.length; i += 10) {
    const chunk = items.slice(i, i + 10);
    const r = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: url,
        Entries: chunk.map((it, idx) => ({
          Id: String(idx),
          MessageBody: JSON.stringify(envelope(it.messageId, it.data)),
          MessageGroupId: it.data.walletId,
          MessageDeduplicationId: it.dedupId ?? it.messageId,
        })),
      }),
    );
    if (r.Failed && r.Failed.length > 0) throw new Error(`SendMessageBatch failed: ${JSON.stringify(r.Failed)}`);
  }
}

export async function queueDepth(url: string): Promise<{ visible: number; inflight: number; total: number }> {
  const r = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  const visible = Number(r.Attributes?.ApproximateNumberOfMessages ?? 0);
  const inflight = Number(r.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
  return { visible, inflight, total: visible + inflight };
}

/**
 * Reads a queue until `idleRounds` consecutive empty receives.
 * `consume: true` deletes what it reads — required to see *all* messages of a
 * FIFO group (a group stays blocked while earlier messages are in flight).
 */
export async function receiveAll(
  url: string,
  opts: { idleRounds?: number; visibilityTimeout?: number; consume?: boolean } = {},
): Promise<Message[]> {
  const out: Message[] = [];
  let idle = 0;
  while (idle < (opts.idleRounds ?? 2)) {
    const r = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        VisibilityTimeout: opts.visibilityTimeout ?? 60,
        MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: ['All'],
      }),
    );
    const msgs = r.Messages ?? [];
    if (msgs.length === 0) idle++;
    else {
      idle = 0;
      out.push(...msgs);
      if (opts.consume) {
        await sqs.send(
          new DeleteMessageBatchCommand({
            QueueUrl: url,
            Entries: msgs.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle })),
          }),
        );
      }
    }
  }
  return out;
}
