import { describe, expect, test } from 'bun:test';
import { useCluster } from '../support/cluster';
import { createWallet, postWager, scrape, sumMetric, wager } from '../support/factories';
import { assertWalletConsistent, ledgerEntries, walletBalance } from '../support/invariants';

/** Scenario 1: the same BET sent 50 times in parallel across 3 instances → exactly one debit. */
const cluster = useCluster('c01', 3, { SQS_CONSUMER_ENABLED: 'false' });

describe('scenario 1 — same bet 50x in parallel', () => {
  test('single debit; every response carries the same transaction and original balance', async () => {
    const w = await createWallet(cluster.next(), '1000.00');
    const bet = wager(w, { money: { amount: '10.00', currency: 'BRL' } });
    const duplicatesBefore = (await Promise.all(cluster.apps.map((a) => scrape(a.url)))).reduce(
      (s, t) => s + sumMetric(t, 'wagering_duplicates_total', { type: 'replay' }),
      0,
    );

    const responses = await Promise.all(Array.from({ length: 50 }, () => postWager(cluster.next(), bet)));

    expect(responses.every((r) => r.status === 201 || r.status === 200)).toBe(true);
    expect(responses.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(new Set(responses.map((r) => r.body.transactionId)).size).toBe(1);
    expect(responses.every((r) => r.body.balance?.amount === '990.00')).toBe(true);

    const debits = (await ledgerEntries(w.id)).filter((e) => e.direction === 'DEBIT');
    expect(debits).toHaveLength(1);
    expect(await walletBalance(w.id)).toBe('990.00');

    const duplicatesAfter = (await Promise.all(cluster.apps.map((a) => scrape(a.url)))).reduce(
      (s, t) => s + sumMetric(t, 'wagering_duplicates_total', { type: 'replay' }),
      0,
    );
    expect(duplicatesAfter - duplicatesBefore).toBeGreaterThanOrEqual(49);
    await assertWalletConsistent(w.id);
  }, 60_000);
});
