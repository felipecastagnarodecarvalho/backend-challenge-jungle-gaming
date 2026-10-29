import { describe, expect, test } from 'bun:test';
import { useCluster } from '../support/cluster';
import { db } from '../support/db';
import { createWallet, keyOf, postWager, type WagerBody, wager } from '../support/factories';
import { assertWalletConsistent, walletBalance } from '../support/invariants';
import { centsToAmount, mulberry32 } from '../support/money-math';
import { queueDepth, sendWagerBatch } from '../support/sqs';
import { waitFor } from '../support/wait-for';

/**
 * Scenario 4: three full instances (HTTP + consumer + outbox publisher +
 * pending-reference worker) process 300 operations on 5 wallets — half via
 * HTTP, half via SQS — plus deliberate duplicates through both channels.
 */
const cluster = useCluster('c04', 3);

describe('scenario 4 — three instances, mixed HTTP and SQS with cross-channel duplicates', () => {
  test('all operations applied exactly once, queues and outbox drained, ≥2 instances did work', async () => {
    const random = mulberry32(7);
    const wallets = await Promise.all(Array.from({ length: 5 }, () => createWallet(cluster.next(), '10000.00')));
    const expected = new Map(wallets.map((w) => [w.id, 1_000_000n]));
    const httpOps: WagerBody[] = [];
    const sqsOps: WagerBody[] = [];
    for (let i = 0; i < 300; i++) {
      const w = wallets[i % 5]!;
      const cents = BigInt(1 + Math.floor(random() * 500));
      const isBet = random() < 0.7;
      const op = wager(w, { kind: isBet ? 'BET' : 'WIN', money: { amount: centsToAmount(cents), currency: 'BRL' } });
      expected.set(w.id, (expected.get(w.id) as bigint) + (isBet ? -cents : cents));
      (i % 2 === 0 ? httpOps : sqsOps).push(op);
    }
    const toMessage = (op: WagerBody) => ({
      messageId: `msg-${crypto.randomUUID()}`,
      data: { ...op, idempotencyKey: keyOf(op) },
    });

    // Duplicates: 30 HTTP ops also sent via SQS, 30 SQS ops also sent via HTTP, 30 SQS ops re-sent with a new messageId.
    const sqsMessages = [
      ...sqsOps.map(toMessage),
      ...httpOps.slice(0, 30).map(toMessage),
      ...sqsOps.slice(0, 30).map(toMessage),
    ];
    const httpRequests = [...httpOps, ...sqsOps.slice(30, 60)];

    const [httpResponses] = await Promise.all([
      Promise.all(httpRequests.map((op) => postWager(cluster.next(), op))),
      sendWagerBatch(cluster.queues.urls.wager, sqsMessages),
    ]);
    expect(httpResponses.every((r) => r.status === 201 || r.status === 200)).toBe(true);

    const walletIds = wallets.map((w) => w.id);
    await waitFor(
      async () => {
        const depth = await queueDepth(cluster.queues.urls.wager);
        const [r] = await db()`SELECT COUNT(*)::int AS n FROM wager_transactions
                                WHERE wallet_id IN ${db()(walletIds)} AND kind <> 'OPENING'`;
        return depth.total === 0 && r?.n === 300;
      },
      { timeoutMs: 60_000, intervalMs: 250, description: 'all 300 operations applied and queue empty' },
    );
    await waitFor(
      async () => {
        const [r] = await db()`SELECT COUNT(*)::int AS n FROM outbox_messages
                                WHERE partition_key IN ${db()(walletIds)} AND published_at IS NULL`;
        return r?.n === 0;
      },
      { timeoutMs: 30_000, description: 'outbox drained' },
    );
    expect((await queueDepth(cluster.queues.urls.dlq)).total).toBe(0);

    const dupes = await db()`SELECT provider_id, external_transaction_id, COUNT(*)::int AS n FROM wager_transactions
                              WHERE wallet_id IN ${db()(walletIds)} GROUP BY 1, 2 HAVING COUNT(*) > 1`;
    expect(dupes).toEqual([]);
    for (const w of wallets) {
      expect(await walletBalance(w.id)).toBe(centsToAmount(expected.get(w.id) as bigint));
      await assertWalletConsistent(w.id);
    }

    // Work was really spread across processes (SQS consumption included).
    const workers = new Set<string>();
    for (const app of cluster.apps) {
      if (app.logs.some((l) => l.includes('"msg":"wager transaction handled"') && l.includes('"messageId"'))) {
        workers.add(app.name);
      }
    }
    expect(workers.size).toBeGreaterThanOrEqual(2);
  }, 150_000);
});
