import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type AppProcess, spawnApp } from '../support/app-process';
import { closeDb, db } from '../support/db';
import { createWallet, keyOf, scrape, sumMetric, wager } from '../support/factories';
import { assertWalletConsistent, ledgerEntries, walletBalance } from '../support/invariants';
import { createTestQueues, deleteTestQueues, queueDepth, sendWager, type TestQueues } from '../support/sqs';
import { waitFor } from '../support/wait-for';

/**
 * Scenario 5: the worker dies AFTER the SQL commit and BEFORE the SQS ack.
 * The message is redelivered to another instance, the inbox recognises it,
 * and it is acked without a second effect.
 */
let queues: TestQueues;
const procs: AppProcess[] = [];

beforeAll(async () => {
  queues = await createTestQueues('c05');
});
afterAll(async () => {
  await Promise.all(procs.map((p) => p.kill()));
  await deleteTestQueues(queues);
  await closeDb();
});

describe('scenario 5 — crash after commit, before ack', () => {
  test('redelivery is detected by the inbox: single debit, queue and DLQ empty', async () => {
    const crashId = `msg-crash-${crypto.randomUUID()}`;
    const a = await spawnApp('c05-a', {
      ...queues.env,
      FAULT_CRASH_AFTER_COMMIT_MESSAGE_IDS: crashId,
      OUTBOX_PUBLISHER_ENABLED: 'false',
      PENDING_REF_WORKER_ENABLED: 'false',
    });
    procs.push(a);
    await a.waitReady();
    const w = await createWallet(a.url, '100.00');
    const bet = wager(w, { money: { amount: '25.00', currency: 'BRL' } });
    await sendWager(queues.urls.wager, crashId, { ...bet, idempotencyKey: keyOf(bet) });

    expect(await a.exited).toBe(137);
    expect(a.logs.some((l) => l.includes('crashing after commit'))).toBe(true);

    // Committed: transaction, inbox and ledger are there…
    const [inbox] = await db()`SELECT processed_at, transaction_id FROM inbox_messages WHERE message_id = ${crashId}`;
    expect(inbox?.processed_at).not.toBeNull();
    const [tx] = await db()`SELECT status FROM wager_transactions WHERE id = ${inbox?.transaction_id}`;
    expect(tx?.status).toBe('PROCESSED');
    expect((await ledgerEntries(w.id)).filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
    // …but the message was never acked.
    expect((await queueDepth(queues.urls.wager)).total).toBe(1);

    const b = await spawnApp('c05-b', { ...queues.env });
    procs.push(b);
    await b.waitReady();
    await waitFor(
      async () => sumMetric(await scrape(b.url), 'wagering_duplicates_total', { source: 'sqs', type: 'inbox' }) >= 1,
      {
        timeoutMs: 20_000,
        description: 'redelivered message detected as inbox duplicate',
      },
    );
    await waitFor(async () => (await queueDepth(queues.urls.wager)).total === 0);
    expect((await queueDepth(queues.urls.dlq)).total).toBe(0);
    expect(b.logs.some((l) => l.includes('duplicate message ignored (inbox)') && l.includes(crashId))).toBe(true);
    expect((await ledgerEntries(w.id)).filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
    expect(await walletBalance(w.id)).toBe('75.00');
    await assertWalletConsistent(w.id);
  }, 90_000);
});
