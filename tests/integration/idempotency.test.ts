import { describe, expect, test } from 'bun:test';
import { db } from '../support/db';
import { createWallet, keyOf, postWager, wager } from '../support/factories';
import { useApp } from '../support/harness';
import { assertWalletConsistent, ledgerEntries, walletBalance } from '../support/invariants';
import { queueDepth, sendWager } from '../support/sqs';
import { waitFor } from '../support/wait-for';

const ctx = useApp('idem');
const BRL = (amount: string) => ({ amount, currency: 'BRL' });

describe('persistent idempotency', () => {
  test('replay returns the ORIGINAL result and balance even after later operations', async () => {
    const w = await createWallet(ctx.url, '100.00');
    const bet = wager(w, { money: BRL('25.00') });
    const first = await postWager(ctx.url, bet);
    expect(first.status).toBe(201);
    await postWager(ctx.url, wager(w, { money: BRL('10.00') }));
    await postWager(ctx.url, wager(w, { kind: 'WIN', money: BRL('500.00') }));
    const replay = await postWager(ctx.url, bet);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({
      transactionId: first.body.transactionId,
      status: 'PROCESSED',
      balance: BRL('75.00'),
      idempotentReplay: true,
    });
    expect(await walletBalance(w.id)).toBe('565.00');
    await assertWalletConsistent(w.id);
  });

  test('same key + different payload -> 409 PAYLOAD_MISMATCH (not a replay, no effect)', async () => {
    const w = await createWallet(ctx.url, '100.00');
    const bet = wager(w, { money: BRL('25.00') });
    await postWager(ctx.url, bet);
    for (const changed of [{ money: BRL('26.00') }, { roundId: 'other' }, { gameId: 'other' }]) {
      const r = await postWager(ctx.url, { ...bet, ...changed }, keyOf(bet));
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({
        error: { code: 'IDEMPOTENCY_CONFLICT', details: { reason: 'PAYLOAD_MISMATCH' } },
      });
    }
    expect(await ledgerEntries(w.id)).toHaveLength(2);
  });

  test('external id already bound to another key -> 409 EXTERNAL_ID_BOUND_TO_OTHER_KEY', async () => {
    const w = await createWallet(ctx.url, '100.00');
    const bet = wager(w);
    await postWager(ctx.url, bet);
    const r = await postWager(ctx.url, bet, 'some-other-key');
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: { details: { reason: 'EXTERNAL_ID_BOUND_TO_OTHER_KEY' } } });
  });

  test('cross-channel: HTTP first, then the same operation via SQS is a replay (no second effect)', async () => {
    const w = await createWallet(ctx.url, '100.00');
    const bet = wager(w, { money: BRL('30.00') });
    const httpResult = await postWager(ctx.url, bet);
    expect(httpResult.status).toBe(201);
    const messageId = `msg-${crypto.randomUUID()}`;
    await sendWager(ctx.queues.urls.wager, messageId, { ...bet, idempotencyKey: keyOf(bet) });
    const inbox = await waitFor(async () => {
      const [row] = await db()`SELECT transaction_id, processed_at FROM inbox_messages WHERE message_id = ${messageId}`;
      return row?.processed_at ? row : undefined;
    });
    expect(inbox.transaction_id).toBe(httpResult.body.transactionId);
    await waitFor(async () => (await queueDepth(ctx.queues.urls.wager)).total === 0);
    expect(await walletBalance(w.id)).toBe('70.00');
    expect(await ledgerEntries(w.id)).toHaveLength(2);
    await assertWalletConsistent(w.id);
  });

  test('cross-channel: SQS first, then HTTP replay returns the SQS result', async () => {
    const w = await createWallet(ctx.url, '100.00');
    const bet = wager(w, { money: BRL('30.00') });
    await sendWager(ctx.queues.urls.wager, `msg-${crypto.randomUUID()}`, { ...bet, idempotencyKey: keyOf(bet) });
    await waitFor(async () => (await walletBalance(w.id)) === '70.00');
    const replay = await postWager(ctx.url, bet);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ idempotentReplay: true, balance: BRL('70.00') });
    await assertWalletConsistent(w.id);
  });

  test('PENDING_REFERENCE replays 202 until resolved, then replays the final 200 result', async () => {
    const w = await createWallet(ctx.url, '100.00');
    const bet = wager(w, { money: BRL('40.00') });
    const rollback = wager(w, {
      kind: 'ROLLBACK',
      money: BRL('40.00'),
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const pending = await postWager(ctx.url, rollback);
    expect(pending.status).toBe(202);
    const pendingReplay = await postWager(ctx.url, rollback);
    expect(pendingReplay.status).toBe(202);
    expect(pendingReplay.body).toMatchObject({ status: 'PENDING_REFERENCE', idempotentReplay: true });

    expect((await postWager(ctx.url, bet)).status).toBe(201);
    const final = await waitFor(async () => {
      const r = await postWager(ctx.url, rollback);
      return r.status === 200 ? r : undefined;
    });
    expect(final.body).toMatchObject({ status: 'PROCESSED', balance: BRL('100.00'), idempotentReplay: true });
    await assertWalletConsistent(w.id);
  });
});
