import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { closeDb, db } from '../support/db';
import { createWallet, http, wager } from '../support/factories';
import { type InProcessApp, startInProcessApp } from '../support/in-process-app';
import { assertWalletConsistent, ledgerEntries } from '../support/invariants';
import { createTestQueues, deleteTestQueues, queueDepth, sendWagerBatch, type TestQueues } from '../support/sqs';
import { waitFor } from '../support/wait-for';

/**
 * SIGTERM semantics, exercised through `app.close()` (same Nest shutdown hooks
 * as the signal; portable to Windows): the message in progress finishes and is
 * acked, received-but-not-started messages are released immediately
 * (visibility 0), and another instance picks them up.
 */
let queues: TestQueues;
let helper: InProcessApp;

beforeAll(async () => {
  queues = await createTestQueues('shutdown');
  // Helper instance only for HTTP setup (no consumer, no workers).
  helper = await startInProcessApp({
    ...queues.env,
    SQS_CONSUMER_ENABLED: 'false',
    OUTBOX_PUBLISHER_ENABLED: 'false',
    PENDING_REF_WORKER_ENABLED: 'false',
  });
});

afterAll(async () => {
  await helper?.close();
  await deleteTestQueues(queues);
  await closeDb();
});

describe('graceful shutdown of the SQS consumer', () => {
  test('in-flight message completes and is acked; not-started messages are released to another instance', async () => {
    const w = await createWallet(helper.url, '100.00');
    const ids = [1, 2, 3].map((i) => `msg-${i}-${crypto.randomUUID()}`);
    await sendWagerBatch(
      queues.urls.wager,
      ids.map((messageId) => {
        const body = wager(w, { money: { amount: '10.00', currency: 'BRL' } });
        return { messageId, data: { ...body, idempotencyKey: `${body.providerId}:${body.externalTransactionId}` } };
      }),
    );

    // Instance A: every transaction sleeps 1.5 s while holding its locks.
    const a = await startInProcessApp({ ...queues.env, FAULT_DELAY_IN_TX_MS: '1500', SQS_VISIBILITY_TIMEOUT_S: '20' });
    await waitFor(async () => (await queueDepth(queues.urls.wager)).inflight === 3, { timeoutMs: 10_000 });
    await Bun.sleep(300); // first message is now inside its transaction

    const readyDuring = http('GET', `${a.url}/health/ready`).catch(() => undefined);
    const closing = a.close();
    await closing;
    await readyDuring;

    // A finished exactly the first message before shutting down.
    const processed =
      await db()`SELECT message_id FROM inbox_messages WHERE message_id IN ${db()(ids)} AND processed_at IS NOT NULL`;
    expect(processed.map((r: { message_id: string }) => r.message_id)).toEqual([ids[0]]);

    // The other two are visible again right away (visibility released, not timed out: timeout is 20 s).
    await waitFor(async () => (await queueDepth(queues.urls.wager)).visible === 2, { timeoutMs: 3_000 });

    // Instance B picks them up.
    const b = await startInProcessApp({ ...queues.env });
    try {
      await waitFor(async () => {
        const [c] =
          await db()`SELECT COUNT(*)::int AS n FROM inbox_messages WHERE message_id IN ${db()(ids)} AND processed_at IS NOT NULL`;
        return c?.n === 3;
      });
      await waitFor(async () => (await queueDepth(queues.urls.wager)).total === 0);
    } finally {
      await b.close();
    }
    expect((await ledgerEntries(w.id)).filter((e) => e.direction === 'DEBIT')).toHaveLength(3);
    await assertWalletConsistent(w.id);
  });
});
