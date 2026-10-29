import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type AppProcess, spawnApp } from '../support/app-process';
import { closeDb, db } from '../support/db';
import { createWallet, postWager, wager } from '../support/factories';
import { assertWalletConsistent } from '../support/invariants';
import { createTestQueues, deleteTestQueues, receiveAll, type TestQueues } from '../support/sqs';
import { waitFor } from '../support/wait-for';

/**
 * Scenario 6: concurrent outbox publishers in separate processes, and a
 * publisher that dies right after claiming a batch (before publishing).
 * Invariant: no committed event is ever lost.
 */
let queues: TestQueues;
let helper: AppProcess;
const procs: AppProcess[] = [];
const onlyPublisher = { SQS_CONSUMER_ENABLED: 'false', PENDING_REF_WORKER_ENABLED: 'false' };

beforeAll(async () => {
  queues = await createTestQueues('c06');
  helper = await spawnApp('c06-helper', { ...queues.env, ...onlyPublisher, OUTBOX_PUBLISHER_ENABLED: 'false' });
  procs.push(helper);
  await helper.waitReady();
}, 60_000);
afterAll(async () => {
  await Promise.all(procs.map((p) => p.kill()));
  await deleteTestQueues(queues);
  await closeDb();
});

/** Creates wallets + bets with publishing disabled; returns wallet ids (6 events per wallet). */
async function generateEvents(wallets: number): Promise<string[]> {
  const ids: string[] = [];
  await Promise.all(
    Array.from({ length: wallets }, async () => {
      const w = await createWallet(helper.url, '100.00');
      ids.push(w.id);
      await postWager(helper.url, wager(w));
      await postWager(helper.url, wager(w));
    }),
  );
  return ids;
}

async function eventIdsFor(walletIds: string[]): Promise<string[]> {
  const rows = await db()`SELECT id FROM outbox_messages WHERE partition_key IN ${db()(walletIds)}`;
  return rows.map((r: { id: string }) => r.id).sort();
}

async function unpublished(walletIds: string[]): Promise<number> {
  const [r] =
    await db()`SELECT COUNT(*)::int AS n FROM outbox_messages WHERE partition_key IN ${db()(walletIds)} AND published_at IS NULL`;
  return r?.n ?? 0;
}

describe('scenario 6 — two publishers over the same outbox', () => {
  test('(a) two publisher processes drain 300 events: every eventId delivered', async () => {
    const walletIds = await generateEvents(50);
    const expected = await eventIdsFor(walletIds);
    expect(expected).toHaveLength(300);
    expect(await unpublished(walletIds)).toBe(300);

    const env = { ...queues.env, ...onlyPublisher, OUTBOX_BATCH_SIZE: '25' };
    const [p1, p2] = await Promise.all([spawnApp('c06-p1', env), spawnApp('c06-p2', env)]);
    procs.push(p1!, p2!);
    await Promise.all([p1!.waitReady(), p2!.waitReady()]);
    await waitFor(async () => (await unpublished(walletIds)) === 0, { timeoutMs: 30_000 });
    await Promise.all([p1!.kill(), p2!.kill()]);

    const received = (await receiveAll(queues.urls.events, { consume: true }))
      .map((m) => JSON.parse(m.Body ?? '{}') as { eventId: string; data: { walletId?: string }; aggregateId: string })
      .filter((b) => walletIds.includes(b.data.walletId ?? b.aggregateId));
    const unique = new Set(received.map((b) => b.eventId));
    expect([...unique].sort()).toEqual(expected);
    console.log(
      `scenario 6a: ${received.length} delivered for 300 events (${received.length - unique.size} duplicates)`,
    );
    for (const id of walletIds.slice(0, 10)) await assertWalletConsistent(id);
  }, 120_000);

  test('(b) a publisher killed after claiming: the batch is published by another after the lease', async () => {
    const walletIds = await generateEvents(5);
    const expected = await eventIdsFor(walletIds);
    const crasher = await spawnApp('c06-crash', {
      ...queues.env,
      ...onlyPublisher,
      FAULT_CRASH_AFTER_OUTBOX_CLAIM: 'true',
    });
    procs.push(crasher);
    expect(await crasher.exited).toBe(137);
    expect(crasher.logs.some((l) => l.includes('crashing after outbox claim'))).toBe(true);
    // Claimed (lease pushed next_attempt_at into the future) but not published.
    const [leased] = await db()`SELECT COUNT(*)::int AS n FROM outbox_messages
                                 WHERE partition_key IN ${db()(walletIds)} AND published_at IS NULL AND next_attempt_at > now()`;
    expect(leased?.n).toBeGreaterThan(0);

    const rescuer = await spawnApp('c06-rescuer', { ...queues.env, ...onlyPublisher });
    procs.push(rescuer);
    await rescuer.waitReady();
    await waitFor(async () => (await unpublished(walletIds)) === 0, {
      timeoutMs: 30_000,
      description: 'published after lease',
    });
    const received = (await receiveAll(queues.urls.events, { consume: true }))
      .map((m) => JSON.parse(m.Body ?? '{}') as { eventId: string; data: { walletId?: string }; aggregateId: string })
      .filter((b) => walletIds.includes(b.data.walletId ?? b.aggregateId));
    expect([...new Set(received.map((b) => b.eventId))].sort()).toEqual(expected);
  }, 120_000);
});
