import { describe, expect, test } from 'bun:test';
import { db } from '../support/db';
import { createWallet, postWager, wager } from '../support/factories';
import { useApp } from '../support/harness';
import { assertWalletConsistent, ledgerEntries, walletBalance } from '../support/invariants';

const ctx = useApp('rules', { SQS_CONSUMER_ENABLED: 'false', PENDING_REF_WORKER_ENABLED: 'false' });

const BRL = (amount: string) => ({ amount, currency: 'BRL' });

async function eventsOf(transactionId: string): Promise<string[]> {
  const rows = await db()`SELECT event_type FROM outbox_messages
                           WHERE aggregate_id = ${transactionId} OR (payload->'data'->>'transactionId') = ${transactionId}
                           ORDER BY event_type`;
  return rows.map((r: { event_type: string }) => r.event_type);
}

describe('BET / WIN / LOSS', () => {
  test('BET debits, WIN credits, LOSS records without moving money; events per outcome', async () => {
    const w = await createWallet(ctx.url, '100.00');
    const bet = wager(w, { money: BRL('40.00'), roundId: 'r1' });
    const b = await postWager(ctx.url, bet);
    expect(b.body).toMatchObject({ status: 'PROCESSED', balance: BRL('60.00') });
    expect(await eventsOf(b.body.transactionId)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);

    const win = await postWager(
      ctx.url,
      wager(w, {
        kind: 'WIN',
        money: BRL('100.00'),
        roundId: 'r1',
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    expect(win.status).toBe(201);
    expect(win.body).toMatchObject({ status: 'PROCESSED', balance: BRL('160.00') });

    const loss = await postWager(ctx.url, wager(w, { kind: 'LOSS', money: BRL('0.00'), roundId: 'r2' }));
    expect(loss.status).toBe(201);
    expect(loss.body).toMatchObject({ status: 'PROCESSED', balance: BRL('160.00') });
    // LOSS: Processed only, no WalletBalanceChanged
    expect(await eventsOf(loss.body.transactionId)).toEqual(['WagerTransactionProcessed']);

    expect(await walletBalance(w.id)).toBe('160.00');
    expect((await ledgerEntries(w.id)).map((e) => e.direction)).toEqual(['CREDIT', 'DEBIT', 'CREDIT']);
    await assertWalletConsistent(w.id);
  });

  test('INSUFFICIENT_FUNDS: rejected, no ledger, Rejected event only', async () => {
    const w = await createWallet(ctx.url, '20.00');
    const r = await postWager(ctx.url, wager(w, { money: BRL('80.00') }));
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: BRL('20.00') });
    expect(await eventsOf(r.body.transactionId)).toEqual(['WagerTransactionRejected']);
    expect(await ledgerEntries(w.id)).toHaveLength(1);
    await assertWalletConsistent(w.id);
  });

  test('WIN referencing a WIN is INVALID_REFERENCE_KIND', async () => {
    const w = await createWallet(ctx.url, '20.00');
    const win = wager(w, { kind: 'WIN', money: BRL('5.00') });
    await postWager(ctx.url, win);
    const r = await postWager(
      ctx.url,
      wager(w, { kind: 'WIN', money: BRL('5.00'), referenceExternalTransactionId: win.externalTransactionId }),
    );
    expect(r.body).toMatchObject({ failureCode: 'INVALID_REFERENCE_KIND' });
  });
});

describe('REFUND / ROLLBACK', () => {
  test('REFUND of a BET credits it back exactly once (second REFUND or ROLLBACK -> ALREADY_REVERSED)', async () => {
    const w = await createWallet(ctx.url, '100.00');
    const bet = wager(w, { money: BRL('25.00') });
    await postWager(ctx.url, bet);
    const refund = await postWager(
      ctx.url,
      wager(w, { kind: 'REFUND', money: BRL('25.00'), referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(refund.status).toBe(201);
    expect(refund.body).toMatchObject({ status: 'PROCESSED', balance: BRL('100.00') });
    const again = await postWager(
      ctx.url,
      wager(w, { kind: 'REFUND', money: BRL('25.00'), referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(again.status).toBe(422);
    expect(again.body).toMatchObject({ failureCode: 'ALREADY_REVERSED' });
    const rollback = await postWager(
      ctx.url,
      wager(w, { kind: 'ROLLBACK', money: BRL('25.00'), referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(rollback.body).toMatchObject({ failureCode: 'ALREADY_REVERSED' });
    expect(await walletBalance(w.id)).toBe('100.00');
    const [ref] =
      await db()`SELECT reference_transaction_id FROM wager_transactions WHERE id = ${refund.body.transactionId}`;
    expect(ref?.reference_transaction_id).toBeString();
    await assertWalletConsistent(w.id);
  });

  test('ROLLBACK of BET credits; ROLLBACK of WIN debits; ROLLBACK of REFUND debits', async () => {
    const w = await createWallet(ctx.url, '100.00');
    const bet = wager(w, { money: BRL('10.00') });
    await postWager(ctx.url, bet);
    const rb = await postWager(
      ctx.url,
      wager(w, { kind: 'ROLLBACK', money: BRL('10.00'), referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(rb.body).toMatchObject({ status: 'PROCESSED', balance: BRL('100.00') });

    const win = wager(w, { kind: 'WIN', money: BRL('30.00') });
    await postWager(ctx.url, win);
    const rbWin = await postWager(
      ctx.url,
      wager(w, { kind: 'ROLLBACK', money: BRL('30.00'), referenceExternalTransactionId: win.externalTransactionId }),
    );
    expect(rbWin.body).toMatchObject({ status: 'PROCESSED', balance: BRL('100.00') });

    const bet2 = wager(w, { money: BRL('5.00') });
    await postWager(ctx.url, bet2);
    const refund = wager(w, {
      kind: 'REFUND',
      money: BRL('5.00'),
      referenceExternalTransactionId: bet2.externalTransactionId,
    });
    await postWager(ctx.url, refund);
    const rbRefund = await postWager(
      ctx.url,
      wager(w, { kind: 'ROLLBACK', money: BRL('5.00'), referenceExternalTransactionId: refund.externalTransactionId }),
    );
    expect(rbRefund.body).toMatchObject({ status: 'PROCESSED', balance: BRL('95.00') });
    await assertWalletConsistent(w.id);
  });

  test('REVERSAL_INSUFFICIENT_FUNDS is distinct from INSUFFICIENT_FUNDS and auditable', async () => {
    const w = await createWallet(ctx.url, '10.00');
    const win = wager(w, { kind: 'WIN', money: BRL('50.00') });
    await postWager(ctx.url, win); // 60
    await postWager(ctx.url, wager(w, { money: BRL('55.00') })); // 5
    const r = await postWager(
      ctx.url,
      wager(w, { kind: 'ROLLBACK', money: BRL('50.00'), referenceExternalTransactionId: win.externalTransactionId }),
    );
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REVERSAL_INSUFFICIENT_FUNDS',
      balance: BRL('5.00'),
    });
    const [row] = await db()`SELECT status, failure_code FROM wager_transactions WHERE id = ${r.body.transactionId}`;
    expect(row).toEqual({ status: 'REJECTED', failure_code: 'REVERSAL_INSUFFICIENT_FUNDS' });
    expect(await eventsOf(r.body.transactionId)).toEqual(['WagerTransactionRejected']);
    await assertWalletConsistent(w.id);
  });

  test('AMOUNT_MISMATCH, INVALID_REFERENCE_KIND, REFERENCE_MISMATCH, REFERENCE_NOT_PROCESSED', async () => {
    const w = await createWallet(ctx.url, '100.00');
    const bet = wager(w, { money: BRL('10.00'), roundId: 'r1' });
    await postWager(ctx.url, bet);
    const partial = await postWager(
      ctx.url,
      wager(w, {
        kind: 'REFUND',
        money: BRL('5.00'),
        roundId: 'r1',
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    expect(partial.body).toMatchObject({ failureCode: 'AMOUNT_MISMATCH' });

    const win = wager(w, { kind: 'WIN', money: BRL('10.00'), roundId: 'r1' });
    await postWager(ctx.url, win);
    const refundOfWin = await postWager(
      ctx.url,
      wager(w, {
        kind: 'REFUND',
        money: BRL('10.00'),
        roundId: 'r1',
        referenceExternalTransactionId: win.externalTransactionId,
      }),
    );
    expect(refundOfWin.body).toMatchObject({ failureCode: 'INVALID_REFERENCE_KIND' });

    const otherRound = await postWager(
      ctx.url,
      wager(w, {
        kind: 'REFUND',
        money: BRL('10.00'),
        roundId: 'r2',
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    expect(otherRound.body).toMatchObject({ failureCode: 'REFERENCE_MISMATCH' });

    const other = await createWallet(ctx.url, '100.00');
    const crossWallet = await postWager(
      ctx.url,
      wager(other, {
        kind: 'REFUND',
        money: BRL('10.00'),
        roundId: 'r1',
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    expect(crossWallet.body).toMatchObject({ failureCode: 'REFERENCE_MISMATCH' });

    const rejectedBet = wager(w, { money: BRL('9999.00'), roundId: 'r1' });
    await postWager(ctx.url, rejectedBet);
    const refundRejected = await postWager(
      ctx.url,
      wager(w, {
        kind: 'REFUND',
        money: BRL('9999.00'),
        roundId: 'r1',
        referenceExternalTransactionId: rejectedBet.externalTransactionId,
      }),
    );
    expect(refundRejected.body).toMatchObject({ failureCode: 'REFERENCE_NOT_PROCESSED' });
    await assertWalletConsistent(w.id);
    await assertWalletConsistent(other.id);
  });
});

describe('ownership and currency', () => {
  test('CURRENCY_MISMATCH and WALLET_PLAYER_MISMATCH do not expose the balance', async () => {
    const w = await createWallet(ctx.url, '100.00');
    const usd = await postWager(ctx.url, wager(w, { money: { amount: '1.00', currency: 'USD' } }));
    expect(usd.status).toBe(422);
    expect(usd.body).toMatchObject({ failureCode: 'CURRENCY_MISMATCH', balance: null });
    const foreign = await postWager(ctx.url, wager({ id: w.id, playerId: crypto.randomUUID() }));
    expect(foreign.status).toBe(422);
    expect(foreign.body).toMatchObject({ failureCode: 'WALLET_PLAYER_MISMATCH', balance: null });
    expect(await walletBalance(w.id)).toBe('100.00');
    await assertWalletConsistent(w.id);
  });
});
