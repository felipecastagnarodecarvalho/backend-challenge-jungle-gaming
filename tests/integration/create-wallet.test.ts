import { describe, expect, test } from 'bun:test';
import { db } from '../support/db';
import { http } from '../support/factories';
import { useApp } from '../support/harness';
import { assertWalletConsistent } from '../support/invariants';

const ctx = useApp('wallet', { SQS_CONSUMER_ENABLED: 'false', OUTBOX_PUBLISHER_ENABLED: 'false' });

describe('POST /wallets', () => {
  test('201 with OPENING transaction, CREDIT ledger entry and 2 outbox events in one commit', async () => {
    const playerId = crypto.randomUUID();
    const r = await http('POST', `${ctx.url}/wallets`, {
      playerId,
      initialBalance: { amount: '1000.00', currency: 'BRL' },
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ playerId, balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });
    const walletId = r.body.id as string;

    const [tx] =
      await db()`SELECT kind, status, source, provider_id, amount::text AS amount FROM wager_transactions WHERE wallet_id = ${walletId}`;
    expect(tx).toEqual({
      kind: 'OPENING',
      status: 'PROCESSED',
      source: 'INTERNAL',
      provider_id: 'internal',
      amount: '1000.00',
    });
    const ledger =
      await db()`SELECT direction, amount::text AS amount, wallet_version FROM wallet_ledger_entries WHERE wallet_id = ${walletId}`;
    expect(ledger).toEqual([{ direction: 'CREDIT', amount: '1000.00', wallet_version: 1 }]);
    const events =
      await db()`SELECT event_type FROM outbox_messages WHERE partition_key = ${walletId} ORDER BY event_type`;
    expect(events.map((e: { event_type: string }) => e.event_type)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    await assertWalletConsistent(walletId);
  });

  test('zero initial balance: no ledger entry, no events', async () => {
    const r = await http('POST', `${ctx.url}/wallets`, {
      playerId: crypto.randomUUID(),
      initialBalance: { amount: '0.00', currency: 'BRL' },
    });
    expect(r.status).toBe(201);
    const walletId = r.body.id as string;
    const [c] = await db()`SELECT (SELECT COUNT(*) FROM wallet_ledger_entries WHERE wallet_id = ${walletId})::int AS l,
                                  (SELECT COUNT(*) FROM outbox_messages WHERE partition_key = ${walletId})::int AS o`;
    expect(c).toEqual({ l: 0, o: 0 });
    await assertWalletConsistent(walletId);
  });

  test('duplicate player + currency -> 409 WALLET_ALREADY_EXISTS; other currency is fine', async () => {
    const playerId = crypto.randomUUID();
    const first = await http('POST', `${ctx.url}/wallets`, {
      playerId,
      initialBalance: { amount: '1.00', currency: 'BRL' },
    });
    expect(first.status).toBe(201);
    const dup = await http('POST', `${ctx.url}/wallets`, {
      playerId,
      initialBalance: { amount: '5.00', currency: 'BRL' },
    });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ error: { code: 'WALLET_ALREADY_EXISTS', retryable: false } });
    const usd = await http('POST', `${ctx.url}/wallets`, {
      playerId,
      initialBalance: { amount: '5.00', currency: 'USD' },
    });
    expect(usd.status).toBe(201);
  });

  test('concurrent duplicate creation: exactly one 201, the rest 409', async () => {
    const playerId = crypto.randomUUID();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        http('POST', `${ctx.url}/wallets`, { playerId, initialBalance: { amount: '10.00', currency: 'BRL' } }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
  });

  test.each([
    [{ playerId: 'not-a-uuid', initialBalance: { amount: '1.00', currency: 'BRL' } }],
    [{ playerId: crypto.randomUUID(), initialBalance: { amount: 1, currency: 'BRL' } }],
    [{ playerId: crypto.randomUUID(), initialBalance: { amount: '-1.00', currency: 'BRL' } }],
    [{ playerId: crypto.randomUUID(), initialBalance: { amount: '1.001', currency: 'BRL' } }],
    [{ playerId: crypto.randomUUID(), initialBalance: { amount: '1.00', currency: 'brl' } }],
    [{ playerId: crypto.randomUUID() }],
  ])('invalid payload -> 400 VALIDATION_ERROR (%#)', async (body) => {
    const r = await http('POST', `${ctx.url}/wallets`, body);
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: { code: 'VALIDATION_ERROR', retryable: false } });
  });
});
