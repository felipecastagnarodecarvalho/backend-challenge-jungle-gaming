import { describe, expect, test } from 'bun:test';
import { db } from '../support/db';
import { createWallet, http, postWager, scrape, sumMetric, wager } from '../support/factories';
import { useApp } from '../support/harness';
import { walletBalance } from '../support/invariants';

const ctx = useApp('recon', { SQS_CONSUMER_ENABLED: 'false' });

describe('POST /wallets/:id/reconciliation', () => {
  test('consistent wallet', async () => {
    const w = await createWallet(ctx.url, '100.00');
    await postWager(ctx.url, wager(w, { money: { amount: '25.00', currency: 'BRL' } }));
    const r = await http('POST', `${ctx.url}/wallets/${w.id}/reconciliation`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      walletId: w.id,
      storedBalance: { amount: '75.00', currency: 'BRL' },
      calculatedBalance: { amount: '75.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
      issues: [],
    });
  });

  test('forced divergence is reported, counted in a metric and NOT corrected', async () => {
    const w = await createWallet(ctx.url, '100.00');
    const before = sumMetric(await scrape(ctx.url), 'wagering_reconciliation_mismatches_total');
    // Bypass every trigger (superuser-only) to simulate corruption the schema would otherwise prevent.
    await db().begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`UPDATE wallets SET balance = 130.00 WHERE id = ${w.id}`;
    });
    const r = await http('POST', `${ctx.url}/wallets/${w.id}/reconciliation`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      consistent: false,
      storedBalance: { amount: '130.00' },
      calculatedBalance: { amount: '100.00' },
      difference: { amount: '30.00', currency: 'BRL' },
      issues: expect.arrayContaining(['BALANCE_DIFFERS_FROM_LEDGER_SUM', 'LAST_ENTRY_MISMATCH']),
    });
    const after = sumMetric(await scrape(ctx.url), 'wagering_reconciliation_mismatches_total');
    expect(after).toBe(before + 1);
    expect(await walletBalance(w.id)).toBe('130.00');
  });

  test('unknown wallet -> 404', async () => {
    expect((await http('POST', `${ctx.url}/wallets/${crypto.randomUUID()}/reconciliation`)).status).toBe(404);
  });
});
