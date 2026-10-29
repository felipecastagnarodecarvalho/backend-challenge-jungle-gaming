import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { closeDb, db } from '../support/db';
import { createWallet, postWager, wager } from '../support/factories';
import { type InProcessApp, startInProcessApp } from '../support/in-process-app';
import { createTestQueues, deleteTestQueues, receiveAll, type TestQueues } from '../support/sqs';
import { waitFor } from '../support/wait-for';

let queues: TestQueues;
let helper: InProcessApp;
const noWorkers = {
  SQS_CONSUMER_ENABLED: 'false',
  OUTBOX_PUBLISHER_ENABLED: 'false',
  PENDING_REF_WORKER_ENABLED: 'false',
};

beforeAll(async () => {
  queues = await createTestQueues('outbox');
  helper = await startInProcessApp({ ...queues.env, ...noWorkers });
});

afterAll(async () => {
  await helper?.close();
  await deleteTestQueues(queues);
  await closeDb();
});

async function pendingFor(walletId: string): Promise<number> {
  const [r] =
    await db()`SELECT COUNT(*)::int AS n FROM outbox_messages WHERE partition_key = ${walletId} AND published_at IS NULL`;
  return r?.n ?? 0;
}

describe('outbox publisher', () => {
  test('publishes committed events to the FIFO events queue with the full envelope', async () => {
    const w = await createWallet(helper.url, '100.00');
    const r = await postWager(helper.url, wager(w, { money: { amount: '10.00', currency: 'BRL' } }));
    expect(await pendingFor(w.id)).toBe(4);
    const publisher = await startInProcessApp({
      ...queues.env,
      SQS_CONSUMER_ENABLED: 'false',
      PENDING_REF_WORKER_ENABLED: 'false',
    });
    try {
      await waitFor(async () => (await pendingFor(w.id)) === 0);
    } finally {
      await publisher.close();
    }
    const messages = (await receiveAll(queues.urls.events, { consume: true })).filter(
      (m) => m.Attributes?.MessageGroupId === w.id,
    );
    expect(messages).toHaveLength(4);
    const bodies = messages.map((m) => JSON.parse(m.Body ?? '{}'));
    expect(bodies.map((b) => b.eventType).sort()).toEqual([
      'WagerTransactionProcessed',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WalletBalanceChanged',
    ]);
    const balanceChanged = bodies.find(
      (b) => b.eventType === 'WalletBalanceChanged' && b.data.transactionId === r.body.transactionId,
    );
    expect(balanceChanged).toMatchObject({
      version: 1,
      aggregateId: w.id,
      data: {
        walletId: w.id,
        direction: 'DEBIT',
        money: { amount: '10.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '90.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
    expect(typeof balanceChanged.occurredAt).toBe('string');
    for (const m of messages) {
      const body = JSON.parse(m.Body ?? '{}');
      expect(m.Attributes?.MessageDeduplicationId).toBe(body.eventId);
      expect(m.MessageAttributes?.eventType?.StringValue).toBe(body.eventType);
    }
  });

  test('broker unavailable: attempts/backoff grow and nothing is lost; once fixed, everything is published', async () => {
    const w = await createWallet(helper.url, '100.00');
    const broken = await startInProcessApp({
      ...queues.env,
      SQS_EVENTS_QUEUE_NAME: `missing-${Date.now()}.fifo`,
      SQS_CONSUMER_ENABLED: 'false',
      PENDING_REF_WORKER_ENABLED: 'false',
    });
    try {
      await waitFor(async () => {
        const rows =
          await db()`SELECT attempts, published_at, last_error FROM outbox_messages WHERE partition_key = ${w.id}`;
        return rows.length === 2 && rows.every((r: { attempts: number }) => r.attempts >= 2) ? rows : undefined;
      });
    } finally {
      await broken.close();
    }
    const rows = await db()`SELECT attempts, published_at, last_error, next_attempt_at > occurred_at AS backed_off
                             FROM outbox_messages WHERE partition_key = ${w.id}`;
    for (const r of rows as Array<{ published_at: Date | null; last_error: string; backed_off: boolean }>) {
      expect(r.published_at).toBeNull();
      expect(r.last_error).toBeString();
      expect(r.backed_off).toBe(true);
    }
    const fixed = await startInProcessApp({
      ...queues.env,
      SQS_CONSUMER_ENABLED: 'false',
      PENDING_REF_WORKER_ENABLED: 'false',
    });
    try {
      await waitFor(async () => (await pendingFor(w.id)) === 0, { timeoutMs: 20_000 });
    } finally {
      await fixed.close();
    }
    const delivered = (await receiveAll(queues.urls.events, { consume: true })).filter(
      (m) => m.Attributes?.MessageGroupId === w.id,
    );
    expect(delivered).toHaveLength(2);
  }, 60_000);

  test('two concurrent publishers over the same outbox: every event published, none lost', async () => {
    const tag = `bulk-${crypto.randomUUID()}`;
    const ids: string[] = [];
    await db().begin(async (tx) => {
      for (let i = 0; i < 200; i++) {
        const id = Bun.randomUUIDv7();
        ids.push(id);
        const payload = {
          eventId: id,
          eventType: 'TestEvent',
          aggregateId: tag,
          correlationId: tag,
          occurredAt: new Date().toISOString(),
          version: 1,
          data: { i },
        };
        await tx`INSERT INTO outbox_messages (id, aggregate_type, aggregate_id, partition_key, event_type, event_version, payload,
                   correlation_id, occurred_at, attempts, next_attempt_at)
                 VALUES (${id}, 'Wallet', ${tag}, ${`${tag}-${i % 10}`}, 'TestEvent', 1, ${payload}, ${tag}, now(), 0, now())`;
      }
    });
    const env = {
      ...queues.env,
      SQS_CONSUMER_ENABLED: 'false',
      PENDING_REF_WORKER_ENABLED: 'false',
      OUTBOX_BATCH_SIZE: '20',
    };
    const [p1, p2] = await Promise.all([startInProcessApp(env), startInProcessApp(env)]);
    try {
      await waitFor(async () => {
        const [r] =
          await db()`SELECT COUNT(*)::int AS n FROM outbox_messages WHERE aggregate_id = ${tag} AND published_at IS NULL`;
        return r?.n === 0;
      });
    } finally {
      await Promise.all([p1?.close(), p2?.close()]);
    }
    const received = (await receiveAll(queues.urls.events, { consume: true }))
      .map((m) => JSON.parse(m.Body ?? '{}'))
      .filter((b) => b.aggregateId === tag);
    const receivedIds = received.map((b) => b.eventId as string);
    const unique = new Set(receivedIds);
    expect([...unique].sort()).toEqual([...ids].sort());
    // Duplicates are allowed by at-least-once delivery but should not happen without crashes/lease expiry.
    console.log(`two publishers: ${receivedIds.length} delivered, ${receivedIds.length - unique.size} duplicates`);
  }, 60_000);
});
