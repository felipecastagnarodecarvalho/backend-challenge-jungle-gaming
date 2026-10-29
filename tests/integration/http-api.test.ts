import { describe, expect, test } from 'bun:test';
import { createWallet, http, postWager, scrape, wager } from '../support/factories';
import { useApp } from '../support/harness';
import { assertWalletConsistent } from '../support/invariants';

const ctx = useApp('http', { SQS_CONSUMER_ENABLED: 'false', PENDING_REF_WORKER_ENABLED: 'false' });

describe('wallet queries', () => {
  test('GET /wallets/:id -> 200; invalid id -> 400; unknown -> 404', async () => {
    const w = await createWallet(ctx.url, '50.00');
    const ok = await http('GET', `${ctx.url}/wallets/${w.id}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      id: w.id,
      playerId: w.playerId,
      balance: { amount: '50.00', currency: 'BRL' },
      version: 1,
    });
    expect((await http('GET', `${ctx.url}/wallets/nope`)).status).toBe(400);
    const missing = await http('GET', `${ctx.url}/wallets/${crypto.randomUUID()}`);
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ error: { code: 'WALLET_NOT_FOUND', retryable: false } });
  });

  test('ledger cursor pagination is stable over 120 entries (pages of 50)', async () => {
    const w = await createWallet(ctx.url, '10000.00');
    for (let batch = 0; batch < 119; batch += 17) {
      const size = Math.min(17, 119 - batch);
      const rs = await Promise.all(
        Array.from({ length: size }, () =>
          postWager(ctx.url, wager(w, { money: { amount: '1.00', currency: 'BRL' } })),
        ),
      );
      expect(rs.every((r) => r.status === 201)).toBe(true);
    }
    type Page = { items: Array<{ walletVersion: number }>; nextCursor: string | null };
    const p1 = await http<Page>('GET', `${ctx.url}/wallets/${w.id}/ledger?limit=50`);
    expect(p1.status).toBe(200);
    expect(p1.body.items.map((i) => i.walletVersion)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(p1.body.nextCursor).toBeString();

    // A new entry arriving between page fetches must not shift the next page.
    expect((await postWager(ctx.url, wager(w, { money: { amount: '1.00', currency: 'BRL' } }))).status).toBe(201);

    const p2 = await http<Page>('GET', `${ctx.url}/wallets/${w.id}/ledger?limit=50&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items.map((i) => i.walletVersion)).toEqual(Array.from({ length: 50 }, (_, i) => i + 51));
    const p3 = await http<Page>('GET', `${ctx.url}/wallets/${w.id}/ledger?limit=50&cursor=${p2.body.nextCursor}`);
    expect(p3.body.items.map((i) => i.walletVersion)).toEqual(Array.from({ length: 21 }, (_, i) => i + 101));
    expect(p3.body.nextCursor).toBeNull();
    // default limit is 50
    const def = await http<Page>('GET', `${ctx.url}/wallets/${w.id}/ledger`);
    expect(def.body.items).toHaveLength(50);
    await assertWalletConsistent(w.id);
  });

  test('ledger validation: invalid cursor / limit -> 400; unknown wallet -> 404', async () => {
    const w = await createWallet(ctx.url, '1.00');
    const bad = await http('GET', `${ctx.url}/wallets/${w.id}/ledger?cursor=garbage!`);
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: { code: 'INVALID_CURSOR' } });
    expect((await http('GET', `${ctx.url}/wallets/${w.id}/ledger?limit=0`)).status).toBe(400);
    expect((await http('GET', `${ctx.url}/wallets/${w.id}/ledger?limit=201`)).status).toBe(400);
    expect((await http('GET', `${ctx.url}/wallets/${crypto.randomUUID()}/ledger`)).status).toBe(404);
  });
});

describe('POST /wagering/transactions status mapping', () => {
  test('201 new, 200 replay, 422 rejected, 409 conflict, 202 pending, 422 wallet not found', async () => {
    const w = await createWallet(ctx.url, '100.00');
    const bet = wager(w, { money: { amount: '30.00', currency: 'BRL' } });
    const created = await postWager(ctx.url, bet);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      status: 'PROCESSED',
      failureCode: null,
      balance: { amount: '70.00' },
      idempotentReplay: false,
    });

    const replay = await postWager(ctx.url, bet);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ transactionId: created.body.transactionId, idempotentReplay: true });

    const rejected = await postWager(ctx.url, wager(w, { money: { amount: '500.00', currency: 'BRL' } }));
    expect(rejected.status).toBe(422);
    expect(rejected.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '70.00' },
      error: { code: 'INSUFFICIENT_FUNDS', retryable: false },
    });
    expect(rejected.body.transactionId).toBeString();

    const conflict = await postWager(ctx.url, { ...bet, money: { amount: '31.00', currency: 'BRL' } });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({
      error: {
        code: 'IDEMPOTENCY_CONFLICT',
        retryable: false,
        details: { reason: 'PAYLOAD_MISMATCH', existingTransactionId: created.body.transactionId },
      },
    });

    const pending = await postWager(ctx.url, wager(w, { kind: 'ROLLBACK', referenceExternalTransactionId: 'not-yet' }));
    expect(pending.status).toBe(202);
    expect(pending.body).toMatchObject({ status: 'PENDING_REFERENCE', balance: { amount: '70.00' } });

    const noWallet = await postWager(ctx.url, wager({ id: crypto.randomUUID(), playerId: w.playerId }));
    expect(noWallet.status).toBe(422);
    expect(noWallet.body).toMatchObject({ error: { code: 'WALLET_NOT_FOUND' } });
    await assertWalletConsistent(w.id);
  });

  test('400s: missing key, invalid key, numeric amount, OPENING kind, reversal without reference, malformed JSON', async () => {
    const w = await createWallet(ctx.url, '100.00');
    const body = wager(w);
    const noKey = await http('POST', `${ctx.url}/wagering/transactions`, body);
    expect(noKey.status).toBe(400);
    expect(noKey.body).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });
    expect((await postWager(ctx.url, body, 'has space')).status).toBe(400);

    const cases: unknown[] = [
      { ...body, money: { amount: 10, currency: 'BRL' } },
      { ...body, kind: 'OPENING' },
      { ...body, kind: 'REFUND' },
      { ...body, kind: 'BET', referenceExternalTransactionId: 'x' },
      { ...body, providerId: 'internal' },
      { ...body, walletId: 'x' },
      { ...body, money: { amount: '0.00', currency: 'BRL' } },
    ];
    for (const c of cases) {
      const r = await http('POST', `${ctx.url}/wagering/transactions`, c, {
        'Idempotency-Key': `k-${crypto.randomUUID()}`,
      });
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ error: { code: 'VALIDATION_ERROR', retryable: false } });
      expect(Array.isArray((r.body as { error: { details: unknown } }).error.details)).toBe(true);
    }
    const malformed = await http('POST', `${ctx.url}/wagering/transactions`, '{not json', { 'Idempotency-Key': 'k-x' });
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });
});

describe('transaction queries', () => {
  test('by id and by provider/external id', async () => {
    const w = await createWallet(ctx.url, '100.00');
    const body = wager(w);
    const created = await postWager(ctx.url, body);
    const byId = await http('GET', `${ctx.url}/wagering/transactions/${created.body.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({
      transactionId: created.body.transactionId,
      status: 'PROCESSED',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
      balanceAfter: { amount: '90.00', currency: 'BRL' },
      walletVersion: 2,
    });
    const byExt = await http(
      'GET',
      `${ctx.url}/providers/provider-a/wagering/transactions/${body.externalTransactionId}`,
    );
    expect(byExt.status).toBe(200);
    expect(byExt.body).toMatchObject({ transactionId: created.body.transactionId });
    expect((await http('GET', `${ctx.url}/wagering/transactions/${crypto.randomUUID()}`)).body).toMatchObject({
      error: { code: 'TRANSACTION_NOT_FOUND' },
    });
    expect(
      (await http('GET', `${ctx.url}/providers/provider-b/wagering/transactions/${body.externalTransactionId}`)).status,
    ).toBe(404);
    expect((await http('GET', `${ctx.url}/wagering/transactions/abc`)).status).toBe(400);
  });
});

describe('cross-cutting', () => {
  test('X-Correlation-Id is echoed, or generated', async () => {
    const given = await http('GET', `${ctx.url}/health/live`, undefined, { 'X-Correlation-Id': 'my-corr-123' });
    expect(given.headers.get('x-correlation-id')).toBe('my-corr-123');
    const generated = await http('GET', `${ctx.url}/wallets/${crypto.randomUUID()}`);
    const id = generated.headers.get('x-correlation-id');
    expect(id).toBeString();
    expect(generated.body).toMatchObject({ correlationId: id });
  });

  test('health endpoints and metrics', async () => {
    expect(await http('GET', `${ctx.url}/health/live`)).toMatchObject({ status: 200, body: { status: 'ok' } });
    const ready = await http('GET', `${ctx.url}/health/ready`);
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({ status: 'ok', checks: { database: { status: 'up' }, sqs: { status: 'up' } } });
    const res = await fetch(`${ctx.url}/metrics`);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const text = await scrape(ctx.url);
    for (const name of [
      'wagering_transactions_total',
      'wagering_outbox_pending_messages',
      'wagering_outbox_oldest_pending_age_seconds',
      'wagering_wallet_lock_wait_seconds',
      'wagering_http_request_duration_seconds',
      'wagering_sqs_queue_messages',
      'wagering_pending_references',
    ]) {
      expect(text).toContain(name);
    }
  });

  test('unknown route -> 404 with the standard error body', async () => {
    const r = await http('GET', `${ctx.url}/nope`);
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ error: { code: 'ROUTE_NOT_FOUND' } });
  });
});
