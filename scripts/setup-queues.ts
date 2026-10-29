/** Creates the FIFO queues (main + DLQ with redrive, events). Idempotent; used by compose `sqs-init` and locally. */
import { loadConfig } from '../src/bootstrap/config';
import { ensureQueues } from '../src/infrastructure/messaging/queue-provisioner';
import { createSqsClient } from '../src/infrastructure/messaging/sqs-client';

const config = loadConfig();
const client = createSqsClient(config.aws);
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (let attempt = 1; ; attempt++) {
  try {
    const urls = await ensureQueues(
      client,
      {
        wagerQueue: config.sqs.wagerQueueName,
        wagerDlq: config.sqs.wagerDlqName,
        eventsQueue: config.sqs.eventsQueueName,
      },
      { visibilityTimeoutS: config.sqs.visibilityTimeoutS, maxReceiveCount: config.sqs.maxReceiveCount },
    );
    console.log(JSON.stringify({ queues: urls }));
    break;
  } catch (err) {
    if (attempt >= 10) throw err;
    console.warn(`queue setup failed (attempt ${attempt}): ${err instanceof Error ? err.message : String(err)}`);
    await delay(1000 * attempt);
  }
}
client.destroy();
