import { describe, expect, test } from 'bun:test';
import { db } from '../support/db';
import { createWallet, scrape, sumMetric, wager } from '../support/factories';
import { useApp } from '../support/harness';
import { assertWalletConsistent, ledgerEntries, walletBalance } from '../support/invariants';
import { queueDepth, receiveAll, sendRaw, sendWager, type WagerEnvelopeData } from '../support/sqs';
import { waitFor } from '../support/wait-for';

const TRANSIENT_ID = `msg-transient-${crypto.randomUUID()}`;
const ctx = useApp('sqs', { FAULT_TRANSIENT_MESSAGE_IDS: TRANSIENT_ID });

const data = (w: { id: string; playerId: string }, patch: Partial<WagerEnvelopeData> = {}): WagerEnvelopeData => {
  const body = wager(w, patch);
  return { ...body, idempotencyKey: `${body.providerId}:${body.externalTransactionId}`, ...patch };
};

async function inboxRow(messageId: string) {
  const [row] = await db()`SELECT transaction_id, processed_at FROM inbox_messages WHERE message_id = ${messageId}`;
  return row as { transaction_id: string | null; processed_at: Date | null } | undefined;
}

const drained = (url: string) => waitFor(async () => (await queueDepth(url)).total === 0, { timeoutMs: 20_000 });

describe('SQS consumer', () => {
  test('valid message: processed with the same use case, inbox recorded, acked after commit', async () => {
    const w = await createWallet(ctx.url, '100.00');
    const messageId = `msg-${crypto.randomUUID()}`;
    await sendWager(ctx.queues.urls.wager, messageId, data(w, { money: { amount: '15.00', currency: 'BRL' } }));
    const row = await waitFor(async () => {
      const r = await inboxRow(messageId);
      return r?.processed_at ? r : undefined;
    });
    expect(row.transaction_id).toBeString();
    const [tx] = await db()`SELECT status, source FROM wager_transactions WHERE id = ${row.transaction_id}`;
    expect(tx).toEqual({ status: 'PROCESSED', source: 'SQS' });
    await drained(ctx.queues.urls.wager);
    expect(await walletBalance(w.id)).toBe('85.00');
    await assertWalletConsistent(w.id);
  });

  test('redelivery of the same messageId (distinct broker dedup ids) has a single effect', async () => {
    const w = await createWallet(ctx.url, '100.00');
    const messageId = `msg-${crypto.randomUUID()}`;
    const d = data(w, { money: { amount: '10.00', currency: 'BRL' } });
    const before = sumMetric(await scrape(ctx.url), 'wagering_duplicates_total', { type: 'inbox' });
    await sendWager(ctx.queues.urls.wager, messageId, d, `${messageId}-a`);
    await sendWager(ctx.queues.urls.wager, messageId, d, `${messageId}-b`);
    await drained(ctx.queues.urls.wager);
    await waitFor(
      async () => sumMetric(await scrape(ctx.url), 'wagering_duplicates_total', { type: 'inbox' }) > before,
    );
    expect(await walletBalance(w.id)).toBe('90.00');
    expect((await ledgerEntries(w.id)).filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
    const [c] = await db()`SELECT COUNT(*)::int AS n FROM inbox_messages WHERE message_id = ${messageId}`;
    expect(c?.n).toBe(1);
    await assertWalletConsistent(w.id);
  });

  test('same operation with a different messageId is an idempotent replay (no second effect)', async () => {
    const w = await createWallet(ctx.url, '100.00');
    const d = data(w, { money: { amount: '10.00', currency: 'BRL' } });
    await sendWager(ctx.queues.urls.wager, `msg-${crypto.randomUUID()}`, d);
    await sendWager(ctx.queues.urls.wager, `msg-${crypto.randomUUID()}`, d);
    await drained(ctx.queues.urls.wager);
    await waitFor(async () => (await walletBalance(w.id)) === '90.00');
    expect((await ledgerEntries(w.id)).filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
    await assertWalletConsistent(w.id);
  });

  test('invalid payload goes straight to the DLQ with an errorCode attribute', async () => {
    const poisonId = `poison-${crypto.randomUUID()}`;
    await sendRaw(ctx.queues.urls.wager, '{"this is": "not an envelope"', 'poison-group', poisonId);
    const invalidKindId = `msg-${crypto.randomUUID()}`;
    await sendRaw(
      ctx.queues.urls.wager,
      JSON.stringify({
        messageId: invalidKindId,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: { kind: 'OPENING' },
      }),
      'poison-group',
      invalidKindId,
    );
    await drained(ctx.queues.urls.wager);
    const dlq = await waitFor(async () => {
      const msgs = await receiveAll(ctx.queues.urls.dlq, { idleRounds: 1, visibilityTimeout: 1 });
      const ours = msgs.filter((m) => m.Body?.includes('not an envelope') || m.Body?.includes(invalidKindId));
      return ours.length === 2 ? ours : undefined;
    });
    for (const m of dlq) {
      expect(m.MessageAttributes?.errorCode?.StringValue).toBe('INVALID_PAYLOAD');
      expect(m.MessageAttributes?.errorMessage?.StringValue).toBeString();
    }
    expect(
      sumMetric(await scrape(ctx.url), 'wagering_sqs_dlq_messages_total', { reason: 'invalid_payload' }),
    ).toBeGreaterThanOrEqual(2);
  });

  test('business rejection and unknown wallet are acked (never DLQ)', async () => {
    const w = await createWallet(ctx.url, '5.00');
    const rejectedId = `msg-${crypto.randomUUID()}`;
    await sendWager(ctx.queues.urls.wager, rejectedId, data(w, { money: { amount: '50.00', currency: 'BRL' } }));
    const unknownId = `msg-${crypto.randomUUID()}`;
    await sendWager(ctx.queues.urls.wager, unknownId, data({ id: crypto.randomUUID(), playerId: w.playerId }));
    await waitFor(async () => (await inboxRow(rejectedId))?.processed_at && (await inboxRow(unknownId))?.processed_at);
    await drained(ctx.queues.urls.wager);
    const [tx] =
      await db()`SELECT status, failure_code FROM wager_transactions t JOIN inbox_messages i ON i.transaction_id = t.id
                             WHERE i.message_id = ${rejectedId}`;
    expect(tx).toEqual({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    expect((await inboxRow(unknownId))?.transaction_id).toBeNull();
    const dlqBodies = (await receiveAll(ctx.queues.urls.dlq, { idleRounds: 1, visibilityTimeout: 1 })).map(
      (m) => m.Body ?? '',
    );
    expect(dlqBodies.some((b) => b.includes(rejectedId) || b.includes(unknownId))).toBe(false);
    await assertWalletConsistent(w.id);
  });

  test('transient failures are retried with growing receive count, then redriven to the DLQ', async () => {
    const w = await createWallet(ctx.url, '100.00');
    await sendWager(ctx.queues.urls.wager, TRANSIENT_ID, data(w));
    const before = sumMetric(await scrape(ctx.url), 'wagering_sqs_messages_total', { result: 'retry' });
    const dead = await waitFor(
      async () => {
        const msgs = await receiveAll(ctx.queues.urls.dlq, { idleRounds: 1, visibilityTimeout: 1 });
        return msgs.find((m) => m.Body?.includes(TRANSIENT_ID));
      },
      { timeoutMs: 40_000, intervalMs: 500 },
    );
    // Redrive (not the explicit poison path): no errorCode attribute, receive count exceeded maxReceiveCount=3.
    expect(dead.MessageAttributes?.errorCode).toBeUndefined();
    const retries = sumMetric(await scrape(ctx.url), 'wagering_sqs_messages_total', { result: 'retry' }) - before;
    expect(retries).toBeGreaterThanOrEqual(3);
    expect(await inboxRow(TRANSIENT_ID)).toBeUndefined();
    expect(await walletBalance(w.id)).toBe('100.00');
    await assertWalletConsistent(w.id);
  }, 60_000);

  test('deterministic permanent error (corrupted wallet) goes to the DLQ immediately, not after maxReceiveCount', async () => {
    const w = await createWallet(ctx.url, '100.00');
    // Simulate corruption the schema normally forbids: balance no longer matches the ledger chain.
    await db().begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`UPDATE wallets SET balance = 130.00 WHERE id = ${w.id}`;
    });
    const messageId = `msg-perm-${crypto.randomUUID()}`;
    await sendWager(ctx.queues.urls.wager, messageId, data(w, { money: { amount: '10.00', currency: 'BRL' } }));
    const dead = await waitFor(
      async () => {
        const msgs = await receiveAll(ctx.queues.urls.dlq, { idleRounds: 1, visibilityTimeout: 1 });
        return msgs.find((m) => m.Body?.includes(messageId));
      },
      { timeoutMs: 15_000, intervalMs: 300 },
    );
    expect(dead.MessageAttributes?.errorCode?.StringValue).toBe('INTEGRITY_VIOLATION');
    // explicit DLQ on the first delivery: the wager queue never saw a retry for it
    expect(Number(dead.Attributes?.ApproximateReceiveCount ?? '1')).toBe(1);
    expect(await inboxRow(messageId)).toBeUndefined();
    expect(
      sumMetric(await scrape(ctx.url), 'wagering_sqs_dlq_messages_total', { reason: 'permanent_error' }),
    ).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
