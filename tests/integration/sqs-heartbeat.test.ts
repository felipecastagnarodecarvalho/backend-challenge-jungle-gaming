import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { closeDb, db } from '../support/db';
import { createWallet, keyOf, scrape, sumMetric, wager } from '../support/factories';
import { type InProcessApp, startInProcessApp } from '../support/in-process-app';
import { assertWalletConsistent, ledgerEntries } from '../support/invariants';
import { createTestQueues, deleteTestQueues, queueDepth, sendWager, type TestQueues } from '../support/sqs';
import { waitFor } from '../support/wait-for';

/**
 * Visibility heartbeat: a message whose processing outlasts the visibility
 * timeout (2 s here, processing ≥ 5 s) must stay invisible — another consumer
 * must never receive it, so ApproximateReceiveCount does not creep towards the
 * redrive limit for a perfectly valid message.
 */
let queues: TestQueues;
const apps: InProcessApp[] = [];

beforeAll(async () => {
  queues = await createTestQueues('heartbeat');
});
afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
  await deleteTestQueues(queues);
  await closeDb();
});

describe('SQS visibility heartbeat', () => {
  test('a slow message is never redelivered to another instance while it is being processed', async () => {
    const slow = await startInProcessApp({
      ...queues.env,
      SQS_VISIBILITY_TIMEOUT_S: '2',
      FAULT_DELAY_IN_TX_MS: '5000',
      OUTBOX_PUBLISHER_ENABLED: 'false',
      PENDING_REF_WORKER_ENABLED: 'false',
    });
    apps.push(slow);
    const w = await createWallet(slow.url, '100.00');
    const bet = wager(w, { money: { amount: '10.00', currency: 'BRL' } });
    const messageId = `msg-hb-${crypto.randomUUID()}`;
    await sendWager(queues.urls.wager, messageId, { ...bet, idempotencyKey: keyOf(bet) });
    await waitFor(async () => (await queueDepth(queues.urls.wager)).inflight === 1);

    // A second, fast instance polls the same queue during the whole slow processing.
    const other = await startInProcessApp({
      ...queues.env,
      SQS_VISIBILITY_TIMEOUT_S: '2',
      OUTBOX_PUBLISHER_ENABLED: 'false',
      PENDING_REF_WORKER_ENABLED: 'false',
    });
    apps.push(other);

    await waitFor(
      async () => {
        const [r] = await db()`SELECT processed_at FROM inbox_messages WHERE message_id = ${messageId}`;
        return r?.processed_at;
      },
      { timeoutMs: 20_000 },
    );
    await waitFor(async () => (await queueDepth(queues.urls.wager)).total === 0);

    const otherMetrics = await scrape(other.url);
    expect(sumMetric(otherMetrics, 'wagering_sqs_messages_total')).toBe(0);
    expect(sumMetric(otherMetrics, 'wagering_duplicates_total', { type: 'inbox' })).toBe(0);
    expect(sumMetric(await scrape(slow.url), 'wagering_sqs_messages_total', { result: 'ack' })).toBe(1);
    expect((await ledgerEntries(w.id)).filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
    await assertWalletConsistent(w.id);
  }, 60_000);
});
