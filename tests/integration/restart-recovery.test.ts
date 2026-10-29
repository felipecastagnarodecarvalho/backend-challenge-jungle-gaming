import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type AppProcess, spawnApp } from '../support/app-process';
import { closeDb, db } from '../support/db';
import { createWallet, postWager, wager } from '../support/factories';
import { assertWalletConsistent, walletBalance } from '../support/invariants';
import { createTestQueues, deleteTestQueues, receiveAll, type TestQueues } from '../support/sqs';
import { waitFor } from '../support/wait-for';

/**
 * Recovery after restart: a process commits work (outbox events, pending
 * references) and dies without finishing the asynchronous part; a fresh
 * process completes it from the database state alone.
 */
let queues: TestQueues;
const procs: AppProcess[] = [];

beforeAll(async () => {
  queues = await createTestQueues('restart');
});

afterAll(async () => {
  await Promise.all(procs.map((p) => p.kill()));
  await deleteTestQueues(queues);
  await closeDb();
});

describe('restart recovery', () => {
  test('outbox is drained and pending references resolved by a new process after a kill', async () => {
    const a = await spawnApp('restart-a', {
      ...queues.env,
      OUTBOX_PUBLISHER_ENABLED: 'false',
      PENDING_REF_WORKER_ENABLED: 'false',
      SQS_CONSUMER_ENABLED: 'false',
    });
    procs.push(a);
    await a.waitReady();

    const w = await createWallet(a.url, '100.00');
    const bet = wager(w, { money: { amount: '40.00', currency: 'BRL' } });
    const rollback = wager(w, {
      kind: 'ROLLBACK',
      money: { amount: '40.00', currency: 'BRL' },
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect((await postWager(a.url, rollback)).status).toBe(202);
    expect((await postWager(a.url, bet)).status).toBe(201);
    const [before] =
      await db()`SELECT COUNT(*)::int AS n FROM outbox_messages WHERE partition_key = ${w.id} AND published_at IS NULL`;
    expect(before?.n).toBe(5);
    expect(await walletBalance(w.id)).toBe('60.00');

    await a.kill();

    const b = await spawnApp('restart-b', { ...queues.env, SQS_CONSUMER_ENABLED: 'false' });
    procs.push(b);
    await b.waitReady();
    await waitFor(
      async () => {
        const [r] = await db()`SELECT
          (SELECT COUNT(*) FROM outbox_messages WHERE partition_key = ${w.id} AND published_at IS NULL)::int AS pending_events,
          (SELECT COUNT(*) FROM wager_transactions WHERE wallet_id = ${w.id} AND status = 'PENDING_REFERENCE')::int AS pending_refs`;
        return r?.pending_events === 0 && r?.pending_refs === 0;
      },
      { timeoutMs: 20_000 },
    );
    expect(await walletBalance(w.id)).toBe('100.00');
    const events = (await receiveAll(queues.urls.events, { consume: true })).filter(
      (m) => m.Attributes?.MessageGroupId === w.id,
    );
    expect(events.length).toBeGreaterThanOrEqual(7); // 5 committed by A + Processed/BalanceChanged of the resolved rollback
    await assertWalletConsistent(w.id);
    await b.kill();
  }, 90_000);
});
