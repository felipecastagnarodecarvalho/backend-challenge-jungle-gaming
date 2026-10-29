/**
 * Sends a sample `WagerTransactionRequested` message to the wager queue (manual demo).
 * Usage: bun scripts/send-sample-message.ts <walletId> <playerId> [kind=BET] [amount=10.00] [externalId]
 */
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { loadConfig } from '../src/bootstrap/config';
import { QueueRegistry } from '../src/infrastructure/messaging/queue-registry';
import { createSqsClient } from '../src/infrastructure/messaging/sqs-client';

const [walletId, playerId, kind = 'BET', amount = '10.00', externalId = `sqs-${crypto.randomUUID()}`] =
  process.argv.slice(2);
if (!walletId || !playerId) {
  console.error('usage: bun scripts/send-sample-message.ts <walletId> <playerId> [kind] [amount] [externalId]');
  process.exit(1);
}
const config = loadConfig();
const client = createSqsClient(config.aws);
const queues = new QueueRegistry(client);
const messageId = `msg-${crypto.randomUUID()}`;
const envelope = {
  messageId,
  type: 'WagerTransactionRequested',
  occurredAt: new Date().toISOString(),
  data: {
    providerId: 'provider-a',
    externalTransactionId: externalId,
    idempotencyKey: `provider-a:${externalId}`,
    playerId,
    walletId,
    roundId: 'round-demo',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
  },
};
await client.send(
  new SendMessageCommand({
    QueueUrl: await queues.url(config.sqs.wagerQueueName),
    MessageBody: JSON.stringify(envelope),
    MessageGroupId: walletId,
    MessageDeduplicationId: messageId,
    MessageAttributes: { correlationId: { DataType: 'String', StringValue: messageId } },
  }),
);
console.log(JSON.stringify({ sent: messageId, providerId: 'provider-a', externalTransactionId: externalId }));
client.destroy();
