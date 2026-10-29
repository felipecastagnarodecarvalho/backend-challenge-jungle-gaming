import { describe, expect, test } from 'bun:test';
import { spawnApp } from '../support/app-process';
import { useCluster, withFailover } from '../support/cluster';
import { db } from '../support/db';
import { createWallet, http, keyOf, postWager, type WagerBody, type WagerResponse, wager } from '../support/factories';
import { assertWalletConsistent, walletBalance } from '../support/invariants';
import { centsToAmount, mulberry32 } from '../support/money-math';
import { queueDepth, sendWagerBatch } from '../support/sqs';
import { waitFor } from '../support/wait-for';

/**
 * Scenario 8: 400 operations (HTTP + SQS) on 10 wallets while 2 of the 3
 * instances are killed mid-load and restarted. Requests cut by the crash are
 * retried by the "provider" with the same idempotency key. Final state must be
 * exactly-once and reconcile on every wallet.
 */
const cluster = useCluster('c08', 3);

describe('scenario 8 — restart with proof of final consistency', () => {
  test('kill 2 of 3 instances under load, restart them, everything converges exactly once', async () => {
    const random = mulberry32(2026);
    const wallets = await Promise.all(Array.from({ length: 10 }, () => createWallet(cluster.next(), '5000.00')));
    const expected = new Map(wallets.map((w) => [w.id, 500_000n]));
    const ops: Array<{ op: WagerBody; via: 'http' | 'sqs' }> = [];
    for (let i = 0; i < 400; i++) {
      const w = wallets[i % 10]!;
      const cents = BigInt(1 + Math.floor(random() * 300));
      const isBet = random() < 0.6;
      ops.push({
        op: wager(w, { kind: isBet ? 'BET' : 'WIN', money: { amount: centsToAmount(cents), currency: 'BRL' } }),
        via: i % 2 === 0 ? 'http' : 'sqs',
      });
      expected.set(w.id, (expected.get(w.id) as bigint) + (isBet ? -cents : cents));
    }

    // Live instance list that changes while instances die/restart.
    const live = [...cluster.apps];
    let rr = 0;
    const pick = () => {
      const app = live[rr++ % live.length];
      if (!app) throw new Error('no live instance');
      return app.url;
    };
    let failovers = 0;
    const send = (op: WagerBody) =>
      withFailover(async (url) => {
        try {
          const r = await postWager(url, op);
          if (r.status >= 500) throw new Error(`retryable ${r.status}`);
          return r;
        } catch (err) {
          failovers++;
          throw err;
        }
      }, pick);

    const httpOps = ops.filter((o) => o.via === 'http').map((o) => o.op);
    const sqsOps = ops.filter((o) => o.via === 'sqs').map((o) => o.op);
    const toMessage = (op: WagerBody) => ({
      messageId: `msg-${crypto.randomUUID()}`,
      data: { ...op, idempotencyKey: keyOf(op) },
    });

    // First half of the load.
    await sendWagerBatch(cluster.queues.urls.wager, sqsOps.slice(0, 100).map(toMessage));
    const firstHalf = Promise.all(httpOps.slice(0, 100).map(send));

    // Kill two instances while requests and messages are in flight.
    await Bun.sleep(150);
    const victims = [cluster.apps[1]!, cluster.apps[2]!];
    live.splice(1, 2);
    await Promise.all(victims.map((v) => v.kill()));

    const secondHalf = Promise.all(httpOps.slice(100).map(send));
    await sendWagerBatch(cluster.queues.urls.wager, sqsOps.slice(100).map(toMessage));

    // Restart them (fresh processes, same configuration).
    const restarted = await Promise.all(
      victims.map((victim) => spawnApp(`${victim.name}-restarted`, { ...cluster.queues.env })),
    );
    await Promise.all(restarted.map((r) => r.waitReady()));
    live.push(...restarted);
    cluster.apps.push(...restarted);

    const responses: Array<{ status: number; body: WagerResponse }> = [...(await firstHalf), ...(await secondHalf)];
    expect(responses.every((r) => r.status === 201 || r.status === 200)).toBe(true);
    const replays = responses.filter((r) => r.body.idempotentReplay).length;
    console.log(`scenario 8: ${failovers} requests failed over to another instance, ${replays} answered as replays`);

    const walletIds = wallets.map((w) => w.id);
    await waitFor(
      async () => {
        const depth = await queueDepth(cluster.queues.urls.wager);
        const [r] = await db()`SELECT
            (SELECT COUNT(*) FROM wager_transactions WHERE wallet_id IN ${db()(walletIds)} AND kind <> 'OPENING')::int AS txs,
            (SELECT COUNT(*) FROM outbox_messages WHERE partition_key IN ${db()(walletIds)} AND published_at IS NULL)::int AS outbox,
            (SELECT COUNT(*) FROM wager_transactions WHERE wallet_id IN ${db()(walletIds)} AND status = 'PENDING_REFERENCE')::int AS pending`;
        return depth.total === 0 && r?.txs === 400 && r?.outbox === 0 && r?.pending === 0;
      },
      { timeoutMs: 90_000, intervalMs: 500, description: 'system stabilised' },
    );
    expect((await queueDepth(cluster.queues.urls.dlq)).total).toBe(0);

    // Every accepted HTTP response has its effect, with the same transaction id.
    for (const r of responses) {
      const [row] = await db()`SELECT status FROM wager_transactions WHERE id = ${r.body.transactionId}`;
      expect(row?.status).toBe('PROCESSED');
    }
    for (const w of wallets) {
      expect(await walletBalance(w.id)).toBe(centsToAmount(expected.get(w.id) as bigint));
      await assertWalletConsistent(w.id);
      const rec = await http<{ consistent: boolean }>('POST', `${pick()}/wallets/${w.id}/reconciliation`);
      expect(rec.body.consistent).toBe(true);
    }
  }, 180_000);
});
