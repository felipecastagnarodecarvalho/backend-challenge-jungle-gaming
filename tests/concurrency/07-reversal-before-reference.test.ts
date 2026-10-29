import { describe, expect, test } from 'bun:test';
import { useCluster } from '../support/cluster';
import { db } from '../support/db';
import { createWallet, postWager, wager } from '../support/factories';
import { assertWalletConsistent, ledgerEntries, walletBalance } from '../support/invariants';
import { waitFor } from '../support/wait-for';

/**
 * Scenario 7: ROLLBACK / REFUND delivered before the referenced BET (and also
 * racing with it), on a 3-instance cluster with the pending-reference worker
 * running everywhere.
 */
const cluster = useCluster('c07', 3, { SQS_CONSUMER_ENABLED: 'false' });
const BRL = (amount: string) => ({ amount, currency: 'BRL' });

async function statusOf(id: string): Promise<string | undefined> {
  const [r] = await db()`SELECT status FROM wager_transactions WHERE id = ${id}`;
  return r?.status;
}

describe('scenario 7 — reversal before its reference', () => {
  test.each(['ROLLBACK', 'REFUND'] as const)(
    '%s arriving first is accepted (202) and applied after the BET',
    async (kind) => {
      const w = await createWallet(cluster.next(), '100.00');
      const bet = wager(w, { money: BRL('35.00') });
      const reversal = wager(w, {
        kind,
        money: BRL('35.00'),
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      const accepted = await postWager(cluster.next(), reversal);
      expect(accepted.status).toBe(202);
      expect((await postWager(cluster.next(), bet)).status).toBe(201);
      await waitFor(async () => (await statusOf(accepted.body.transactionId)) === 'PROCESSED');

      expect(await walletBalance(w.id)).toBe('100.00');
      expect((await ledgerEntries(w.id)).map((e) => e.direction)).toEqual(['CREDIT', 'DEBIT', 'CREDIT']);
      const events =
        await db()`SELECT event_type FROM outbox_messages WHERE aggregate_id = ${accepted.body.transactionId}
                               ORDER BY occurred_at`;
      expect(events.map((e: { event_type: string }) => e.event_type)).toEqual([
        'WagerTransactionPendingReference',
        'WagerTransactionProcessed',
      ]);
      // A second reversal of the same BET is refused.
      const second = await postWager(
        cluster.next(),
        wager(w, { kind: 'ROLLBACK', money: BRL('35.00'), referenceExternalTransactionId: bet.externalTransactionId }),
      );
      expect(second.body).toMatchObject({ status: 'REJECTED', failureCode: 'ALREADY_REVERSED' });
      await assertWalletConsistent(w.id);
    },
    60_000,
  );

  test('reversal racing with its BET on different instances (20 wallets) always converges to one debit + one credit', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => createWallet(cluster.next(), '100.00')));
    const urls = cluster.apps.map((a) => a.url);
    const results = await Promise.all(
      wallets.map(async (w, i) => {
        const bet = wager(w, { money: BRL('50.00') });
        const reversal = wager(w, {
          kind: i % 2 === 0 ? 'ROLLBACK' : 'REFUND',
          money: BRL('50.00'),
          referenceExternalTransactionId: bet.externalTransactionId,
        });
        const [rr, rb] = await Promise.all([
          postWager(urls[i % 3] as string, reversal),
          postWager(urls[(i + 1) % 3] as string, bet),
        ]);
        return { w, rr, rb };
      }),
    );
    for (const { rr, rb } of results) {
      expect(rb.status).toBe(201);
      expect([201, 202]).toContain(rr.status);
    }
    await waitFor(async () => {
      const [r] = await db()`SELECT COUNT(*)::int AS n FROM wager_transactions
                              WHERE wallet_id IN ${db()(wallets.map((w) => w.id))} AND status = 'PENDING_REFERENCE'`;
      return r?.n === 0;
    });
    for (const { w } of results) {
      expect(await walletBalance(w.id)).toBe('100.00');
      expect((await ledgerEntries(w.id)).map((e) => e.direction)).toEqual(['CREDIT', 'DEBIT', 'CREDIT']);
      await assertWalletConsistent(w.id);
    }
  }, 90_000);
});
