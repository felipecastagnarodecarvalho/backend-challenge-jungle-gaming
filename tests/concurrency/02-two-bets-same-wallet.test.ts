import { describe, expect, test } from 'bun:test';
import { useCluster } from '../support/cluster';
import { createWallet, postWager, wager } from '../support/factories';
import { assertWalletConsistent, ledgerEntries, walletBalance } from '../support/invariants';

/**
 * Scenario 2 (challenge §8): balance 100.00, two different 80.00 BETs at the
 * same time on different instances → one PROCESSED, one INSUFFICIENT_FUNDS,
 * balance 20.00, exactly one DEBIT; retries change nothing. Repeated on 20
 * wallets concurrently to make the race real, not lucky.
 */
const cluster = useCluster('c02', 3, { SQS_CONSUMER_ENABLED: 'false' });

describe('scenario 2 — two bets compete for the same balance', () => {
  test('exactly one wins on each of 20 wallets; retries are replays', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => createWallet(cluster.next(), '100.00')));
    const pairs = wallets.map((w) => [
      wager(w, { money: { amount: '80.00', currency: 'BRL' } }),
      wager(w, { money: { amount: '80.00', currency: 'BRL' } }),
    ]);
    const urls = cluster.apps.map((a) => a.url);
    const results = await Promise.all(
      pairs.map(([a, b], i) =>
        Promise.all([postWager(urls[i % 3] as string, a!), postWager(urls[(i + 1) % 3] as string, b!)]),
      ),
    );

    for (const [i, w] of wallets.entries()) {
      const [ra, rb] = results[i]!;
      const statuses = [ra.status, rb.status].sort();
      expect(statuses).toEqual([201, 422]);
      const loser = ra.status === 422 ? ra : rb;
      expect(loser.body).toMatchObject({
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_FUNDS',
        balance: { amount: '20.00' },
      });
      expect(await walletBalance(w.id)).toBe('20.00');
      expect((await ledgerEntries(w.id)).filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
    }

    // Provider retries of both bets (any instance) replay the original outcomes; nothing moves.
    const retries = await Promise.all(
      pairs.flatMap(([a, b]) => [postWager(cluster.next(), a!), postWager(cluster.next(), b!)]),
    );
    expect(retries.every((r) => r.body.idempotentReplay === true)).toBe(true);
    expect(retries.filter((r) => r.status === 200)).toHaveLength(20);
    expect(retries.filter((r) => r.status === 422)).toHaveLength(20);
    for (const w of wallets) {
      expect(await walletBalance(w.id)).toBe('20.00');
      expect((await ledgerEntries(w.id)).filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
      await assertWalletConsistent(w.id);
    }
  }, 90_000);
});
