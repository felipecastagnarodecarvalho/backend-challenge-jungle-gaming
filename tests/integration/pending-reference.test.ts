import { describe, expect, test } from 'bun:test';
import { db } from '../support/db';
import { createWallet, http, postWager, wager } from '../support/factories';
import { useApp } from '../support/harness';
import { assertWalletConsistent, ledgerEntries, walletBalance } from '../support/invariants';
import { waitFor } from '../support/wait-for';

const ctx = useApp('pending', { SQS_CONSUMER_ENABLED: 'false' });
const BRL = (amount: string) => ({ amount, currency: 'BRL' });

async function txRow(id: string) {
  const [r] =
    await db()`SELECT status, failure_code, reference_attempts, reference_transaction_id FROM wager_transactions WHERE id = ${id}`;
  return r as {
    status: string;
    failure_code: string | null;
    reference_attempts: number;
    reference_transaction_id: string | null;
  };
}

async function eventTypes(transactionId: string): Promise<string[]> {
  const rows =
    await db()`SELECT event_type FROM outbox_messages WHERE aggregate_id = ${transactionId} ORDER BY occurred_at, event_type`;
  return rows.map((r: { event_type: string }) => r.event_type);
}

describe('out-of-order references (PENDING_REFERENCE worker)', () => {
  test('ROLLBACK before its BET: accepted 202, resolved by the worker once the BET arrives', async () => {
    const w = await createWallet(ctx.url, '100.00');
    const bet = wager(w, { money: BRL('30.00') });
    const rollback = wager(w, {
      kind: 'ROLLBACK',
      money: BRL('30.00'),
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const accepted = await postWager(ctx.url, rollback);
    expect(accepted.status).toBe(202);
    expect(accepted.body).toMatchObject({ status: 'PENDING_REFERENCE', balance: BRL('100.00') });

    const b = await postWager(ctx.url, bet);
    expect(b.body).toMatchObject({ status: 'PROCESSED', balance: BRL('70.00') });

    await waitFor(async () => (await txRow(accepted.body.transactionId)).status === 'PROCESSED');
    const row = await txRow(accepted.body.transactionId);
    expect(row.reference_transaction_id).toBe(b.body.transactionId);
    expect(await walletBalance(w.id)).toBe('100.00');
    expect((await ledgerEntries(w.id)).map((e) => e.direction)).toEqual(['CREDIT', 'DEBIT', 'CREDIT']);
    expect(await eventTypes(accepted.body.transactionId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
    ]);
    const view = await http('GET', `${ctx.url}/wagering/transactions/${accepted.body.transactionId}`);
    expect(view.body).toMatchObject({ status: 'PROCESSED', balanceAfter: BRL('100.00') });
    await assertWalletConsistent(w.id);
  });

  test('REFUND whose BET never arrives expires as REJECTED/REFERENCE_NOT_FOUND after max attempts', async () => {
    const w = await createWallet(ctx.url, '100.00');
    const refund = wager(w, {
      kind: 'REFUND',
      money: BRL('10.00'),
      referenceExternalTransactionId: `never-${crypto.randomUUID()}`,
    });
    const accepted = await postWager(ctx.url, refund);
    expect(accepted.status).toBe(202);
    await waitFor(async () => (await txRow(accepted.body.transactionId)).status === 'REJECTED', { timeoutMs: 20_000 });
    const row = await txRow(accepted.body.transactionId);
    expect(row).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND', reference_attempts: 3 });
    expect(await eventTypes(accepted.body.transactionId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    // the provider's replay now gets the final answer
    const replay = await postWager(ctx.url, refund);
    expect(replay.status).toBe(422);
    expect(replay.body).toMatchObject({ failureCode: 'REFERENCE_NOT_FOUND', idempotentReplay: true });
    expect(await walletBalance(w.id)).toBe('100.00');
    await assertWalletConsistent(w.id);
  }, 30_000);

  test('a chain arriving fully out of order converges (ROLLBACK of WIN of BET)', async () => {
    const w = await createWallet(ctx.url, '100.00');
    const bet = wager(w, { money: BRL('10.00'), roundId: 'chain' });
    const win = wager(w, {
      kind: 'WIN',
      money: BRL('50.00'),
      roundId: 'chain',
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const rollback = wager(w, {
      kind: 'ROLLBACK',
      money: BRL('50.00'),
      roundId: 'chain',
      referenceExternalTransactionId: win.externalTransactionId,
    });
    expect((await postWager(ctx.url, rollback)).status).toBe(202);
    expect((await postWager(ctx.url, win)).status).toBe(202);
    expect((await postWager(ctx.url, bet)).status).toBe(201);
    await waitFor(async () => {
      const rows =
        await db()`SELECT status FROM wager_transactions WHERE wallet_id = ${w.id} AND kind IN ('WIN','ROLLBACK')`;
      return rows.length === 2 && rows.every((r: { status: string }) => r.status === 'PROCESSED');
    });
    expect(await walletBalance(w.id)).toBe('90.00');
    await assertWalletConsistent(w.id);
  });
});
