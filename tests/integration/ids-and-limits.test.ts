import { describe, expect, test } from 'bun:test';
import { db } from '../support/db';
import { createWallet, http, postWager, wager } from '../support/factories';
import { useApp } from '../support/harness';
import { assertWalletConsistent, walletBalance } from '../support/invariants';

/** Review findings F1 (UUID case) and F2 (balance ceiling / rehydration of large balances). */
const ctx = useApp('idslimits', { SQS_CONSUMER_ENABLED: 'false', PENDING_REF_WORKER_ENABLED: 'false' });
const MAX = '999999999999999.99';

describe('F1 — UUIDs are case-insensitive (normalised to lowercase at the edge)', () => {
  test('wallet created with an uppercase playerId accepts bets in either case; replays across cases', async () => {
    const playerUpper = crypto.randomUUID().toUpperCase();
    const created = await http<{ id: string; playerId: string }>('POST', `${ctx.url}/wallets`, {
      playerId: playerUpper,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    expect(created.status).toBe(201);
    expect(created.body.playerId).toBe(playerUpper.toLowerCase());
    const walletUpper = created.body.id.toUpperCase();

    // same player id exactly as sent at creation (uppercase), uppercase wallet id
    const bet = wager({ id: walletUpper, playerId: playerUpper }, { money: { amount: '10.00', currency: 'BRL' } });
    const first = await postWager(ctx.url, bet);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '90.00' } });

    // the same operation with lowercase ids is the same payload → replay, not 409
    const lower = { ...bet, playerId: bet.playerId.toLowerCase(), walletId: bet.walletId.toLowerCase() };
    const replay = await postWager(ctx.url, lower);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ transactionId: first.body.transactionId, idempotentReplay: true });

    // a reversal with mixed-case ids resolves the lowercase-stored reference (no REFERENCE_MISMATCH)
    const rollback = await postWager(
      ctx.url,
      wager(
        { id: created.body.id.toUpperCase(), playerId: playerUpper.toLowerCase() },
        {
          kind: 'ROLLBACK',
          money: { amount: '10.00', currency: 'BRL' },
          referenceExternalTransactionId: bet.externalTransactionId,
        },
      ),
    );
    expect(rollback.status).toBe(201);
    expect(rollback.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00' } });

    // GETs accept either case too
    expect((await http('GET', `${ctx.url}/wallets/${walletUpper}`)).status).toBe(200);
    expect(
      (await http('GET', `${ctx.url}/wagering/transactions/${first.body.transactionId.toUpperCase()}`)).status,
    ).toBe(200);
    await assertWalletConsistent(created.body.id);
  });

  test('duplicate wallet detection is case-insensitive', async () => {
    const player = crypto.randomUUID();
    expect(
      (
        await http('POST', `${ctx.url}/wallets`, {
          playerId: player,
          initialBalance: { amount: '1.00', currency: 'BRL' },
        })
      ).status,
    ).toBe(201);
    const dup = await http('POST', `${ctx.url}/wallets`, {
      playerId: player.toUpperCase(),
      initialBalance: { amount: '1.00', currency: 'BRL' },
    });
    expect(dup.status).toBe(409);
  });
});

describe('F2 — balance ceiling', () => {
  test('a credit beyond the ceiling is REJECTED (BALANCE_LIMIT_EXCEEDED, auditable) and the wallet keeps working', async () => {
    const w = await createWallet(ctx.url, MAX);
    const win = await postWager(ctx.url, wager(w, { kind: 'WIN', money: { amount: '0.01', currency: 'BRL' } }));
    expect(win.status).toBe(422);
    expect(win.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'BALANCE_LIMIT_EXCEEDED',
      balance: { amount: MAX },
      error: { code: 'BALANCE_LIMIT_EXCEEDED', retryable: false },
    });
    const [row] = await db()`SELECT status, failure_code FROM wager_transactions WHERE id = ${win.body.transactionId}`;
    expect(row).toEqual({ status: 'REJECTED', failure_code: 'BALANCE_LIMIT_EXCEEDED' });
    const [evt] = await db()`SELECT event_type FROM outbox_messages WHERE aggregate_id = ${win.body.transactionId}`;
    expect(evt?.event_type).toBe('WagerTransactionRejected');

    // never stuck: further operations keep working, up to exactly the ceiling
    expect((await postWager(ctx.url, wager(w, { money: { amount: '1.00', currency: 'BRL' } }))).status).toBe(201);
    const refill = await postWager(ctx.url, wager(w, { kind: 'WIN', money: { amount: '1.00', currency: 'BRL' } }));
    expect(refill.status).toBe(201);
    expect(await walletBalance(w.id)).toBe(MAX);
    await assertWalletConsistent(w.id);
  });

  test('initial balance above the ceiling is a validation error (400)', async () => {
    const r = await http('POST', `${ctx.url}/wallets`, {
      playerId: crypto.randomUUID(),
      initialBalance: { amount: '1000000000000000.00', currency: 'BRL' },
    });
    expect(r.status).toBe(400);
  });

  test('a legacy wallet persisted above the ceiling still loads: debits work, credits are rejected (never stuck in 500)', async () => {
    const w = await createWallet(ctx.url, MAX);
    // Plant the state the reviewer produced before the fix (balance and ledger above the ceiling).
    await db().begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      // as if written before migration 5 existed (CHECKs are not disabled by replica mode)
      await tx`ALTER TABLE wallet_ledger_entries DROP CONSTRAINT ledger_balance_ceiling_ck`;
      const txId = crypto.randomUUID();
      await tx`INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
                 player_id, round_id, game_id, kind, amount, currency, status, source, created_at, updated_at, processed_at)
               VALUES (${txId}, 'provider-a', ${`legacy-${txId}`}, ${`legacy-${txId}`}, ${'a'.repeat(64)}, ${w.id}, ${w.playerId},
                 'r', 'g', 'WIN', ${MAX}, 'BRL', 'PROCESSED', 'HTTP', now(), now(), now())`;
      await tx`INSERT INTO wallet_ledger_entries VALUES (${crypto.randomUUID()}, ${w.id}, ${txId}, 'CREDIT', ${MAX}, 'BRL',
                 ${MAX}, 1999999999999999.98, 2, now())`;
      await tx`UPDATE wallets SET balance = 1999999999999999.98, version = 2 WHERE id = ${w.id}`;
      await tx`ALTER TABLE wallet_ledger_entries ADD CONSTRAINT ledger_balance_ceiling_ck
                 CHECK (direction = 'DEBIT' OR balance_after <= 999999999999999.99) NOT VALID`;
    });
    const debit = await postWager(ctx.url, wager(w, { money: { amount: '1.00', currency: 'BRL' } }));
    expect(debit.status).toBe(201);
    expect(debit.body).toMatchObject({ balance: { amount: '1999999999999998.98' } });
    const credit = await postWager(ctx.url, wager(w, { kind: 'WIN', money: { amount: '1.00', currency: 'BRL' } }));
    expect(credit.status).toBe(422);
    expect(credit.body).toMatchObject({ failureCode: 'BALANCE_LIMIT_EXCEEDED' });
    expect((await http('GET', `${ctx.url}/wallets/${w.id}`)).status).toBe(200);
    const rec = await http<{ consistent: boolean }>('POST', `${ctx.url}/wallets/${w.id}/reconciliation`);
    expect(rec.body.consistent).toBe(true);
    await assertWalletConsistent(w.id);
  });
});
