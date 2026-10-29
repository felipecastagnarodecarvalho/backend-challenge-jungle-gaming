import { describe, expect, test } from 'bun:test';
import { useCluster } from '../support/cluster';
import { createWallet, postWager, type WagerBody, wager } from '../support/factories';
import { assertWalletConsistent, ledgerEntries, walletBalance } from '../support/invariants';
import { centsToAmount, mulberry32 } from '../support/money-math';

/** Scenario 3: 20 wallets × 25 mixed operations, everything in parallel across 3 instances. */
const cluster = useCluster('c03', 3, { SQS_CONSUMER_ENABLED: 'false' });

describe('scenario 3 — distinct wallets in parallel', () => {
  test('every wallet ends at its expected balance with the expected number of entries', async () => {
    const random = mulberry32(42);
    const wallets = await Promise.all(Array.from({ length: 20 }, () => createWallet(cluster.next(), '1000.00')));
    const plan = wallets.map((w) => {
      let expected = 100_000n; // cents
      let moving = 1; // opening entry
      const ops: WagerBody[] = [];
      for (let i = 0; i < 25; i++) {
        const roll = random();
        const cents = BigInt(1 + Math.floor(random() * 1000)); // 0.01 .. 10.00
        if (roll < 0.6) {
          ops.push(wager(w, { kind: 'BET', money: { amount: centsToAmount(cents), currency: 'BRL' } }));
          expected -= cents;
          moving++;
        } else if (roll < 0.85) {
          ops.push(wager(w, { kind: 'WIN', money: { amount: centsToAmount(cents), currency: 'BRL' } }));
          expected += cents;
          moving++;
        } else {
          ops.push(wager(w, { kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } }));
        }
      }
      return { w, ops, expected, moving };
    });

    const responses = await Promise.all(plan.flatMap((p) => p.ops.map((op) => postWager(cluster.next(), op))));
    expect(responses.every((r) => r.status === 201)).toBe(true);

    for (const p of plan) {
      expect(await walletBalance(p.w.id)).toBe(centsToAmount(p.expected));
      expect(await ledgerEntries(p.w.id)).toHaveLength(p.moving);
      await assertWalletConsistent(p.w.id);
    }
  }, 90_000);
});
