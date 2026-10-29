import { afterAll, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { closeDb, db, expectPgError } from '../support/db';

/**
 * Schema-level guarantees (challenge §5.9), exercised with raw SQL so that no
 * application code is involved: each invalid write must be rejected by the database.
 */
const uuid = () => crypto.randomUUID();
const hash = 'a'.repeat(64);

afterAll(closeDb);

interface Seed {
  walletId: string;
  playerId: string;
  openingId: string;
}

/** Valid wallet with OPENING tx + ledger entry v1 (balance 100.00 BRL). */
async function seedWallet(balance = '100.00', currency = 'BRL'): Promise<Seed> {
  const walletId = uuid();
  const playerId = uuid();
  const openingId = uuid();
  await db().begin(async (tx) => {
    await tx`INSERT INTO wallets VALUES (${walletId}, ${playerId}, ${currency}, ${balance}, 1, now(), now())`;
    await insertTx(tx, {
      id: openingId,
      walletId,
      playerId,
      kind: 'OPENING',
      amount: balance,
      currency,
      providerId: 'internal',
      source: 'INTERNAL',
      status: 'PROCESSED',
    });
    await tx`INSERT INTO wallet_ledger_entries VALUES (${uuid()}, ${walletId}, ${openingId}, 'CREDIT', ${balance}, ${currency}, 0, ${balance}, 1, now())`;
  });
  return { walletId, playerId, openingId };
}

interface TxRow {
  id?: string;
  walletId: string;
  playerId: string;
  kind?: string;
  amount?: string;
  currency?: string;
  providerId?: string;
  externalId?: string;
  key?: string;
  status?: string;
  source?: string;
  ref?: string | null;
  refTxId?: string | null;
  failureCode?: string | null;
  nextCheck?: Date | null;
}

async function insertTx(sql: SQL, r: TxRow): Promise<string> {
  const id = r.id ?? uuid();
  const status = r.status ?? 'PROCESSED';
  const externalId = r.externalId ?? `ext-${id}`;
  await sql`INSERT INTO wager_transactions (
      id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id,
      kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status, failure_code,
      next_reference_check_at, source, created_at, updated_at, processed_at)
    VALUES (${id}, ${r.providerId ?? 'provider-a'}, ${externalId}, ${r.key ?? `k-${id}`}, ${hash}, ${r.walletId}, ${r.playerId},
      'round-1', 'game-1', ${r.kind ?? 'BET'}, ${r.amount ?? '10.00'}, ${r.currency ?? 'BRL'}, ${r.ref ?? null}, ${r.refTxId ?? null},
      ${status}, ${r.failureCode ?? null}, ${r.nextCheck ?? null}, ${r.source ?? 'HTTP'}, now(), now(),
      ${status === 'PROCESSED' ? new Date() : null})`;
  return id;
}

describe('wallets', () => {
  test('balance must be backed by the ledger at COMMIT (deferred constraint trigger)', async () => {
    const err = await expectPgError(() =>
      db().begin(async (tx) => {
        await tx`INSERT INTO wallets VALUES (${uuid()}, ${uuid()}, 'BRL', 50, 1, now(), now())`;
      }),
    );
    expect(err.code).toBe('23000');
    expect(err.message).toContain('not backed by a ledger entry');
  });

  test('zero-balance wallet without ledger is valid', async () => {
    await db().begin(async (tx) => {
      await tx`INSERT INTO wallets VALUES (${uuid()}, ${uuid()}, 'BRL', 0, 1, now(), now())`;
    });
  });

  test('negative balance rejected', async () => {
    const err = await expectPgError(
      () => db()`INSERT INTO wallets VALUES (${uuid()}, ${uuid()}, 'BRL', -1, 1, now(), now())`,
    );
    expect(err.code).toBe('23514');
    expect(err.constraint).toBe('wallets_balance_non_negative_ck');
  });

  test('one wallet per player + currency', async () => {
    const s = await seedWallet();
    const err = await expectPgError(
      () => db()`INSERT INTO wallets VALUES (${uuid()}, ${s.playerId}, 'BRL', 0, 1, now(), now())`,
    );
    expect(err.code).toBe('23505');
    expect(err.constraint).toBe('wallets_player_currency_uk');
    // other currency is fine
    await db()`INSERT INTO wallets VALUES (${uuid()}, ${s.playerId}, 'USD', 0, 1, now(), now())`;
  });

  test('version must move by exactly +1 with balance, and never alone', async () => {
    const s = await seedWallet();
    const plus2 = await expectPgError(
      () => db()`UPDATE wallets SET balance = 90, version = 3 WHERE id = ${s.walletId}`,
    );
    expect(plus2.message).toContain('increment by exactly 1');
    const alone = await expectPgError(() => db()`UPDATE wallets SET version = 2 WHERE id = ${s.walletId}`);
    expect(alone.message).toContain('only change together with balance');
  });

  test('balance change without matching ledger entry fails at commit', async () => {
    const s = await seedWallet();
    const err = await expectPgError(() =>
      db().begin(async (tx) => {
        await tx`UPDATE wallets SET balance = 90, version = 2 WHERE id = ${s.walletId}`;
      }),
    );
    expect(err.code).toBe('23000');
    expect(err.message).toContain('not backed');
  });

  test('balance change with matching ledger entry commits', async () => {
    const s = await seedWallet();
    await db().begin(async (tx) => {
      const betId = await insertTx(tx, { walletId: s.walletId, playerId: s.playerId });
      await tx`UPDATE wallets SET balance = 90, version = 2 WHERE id = ${s.walletId}`;
      await tx`INSERT INTO wallet_ledger_entries VALUES (${uuid()}, ${s.walletId}, ${betId}, 'DEBIT', 10, 'BRL', 100, 90, 2, now())`;
    });
  });

  test('immutable columns and delete are forbidden', async () => {
    const s = await seedWallet();
    expect(
      (await expectPgError(() => db()`UPDATE wallets SET player_id = ${uuid()} WHERE id = ${s.walletId}`)).message,
    ).toContain('immutable wallet column');
    expect((await expectPgError(() => db()`DELETE FROM wallets WHERE id = ${s.walletId}`)).message).toContain(
      'forbidden',
    );
  });
});

describe('ledger', () => {
  test('append-only: UPDATE, DELETE and TRUNCATE are forbidden', async () => {
    const s = await seedWallet();
    const upd = await expectPgError(
      () => db()`UPDATE wallet_ledger_entries SET amount = 1 WHERE wallet_id = ${s.walletId}`,
    );
    expect(upd.code).toBe('23000');
    expect(upd.message).toContain('append-only');
    const del = await expectPgError(() => db()`DELETE FROM wallet_ledger_entries WHERE wallet_id = ${s.walletId}`);
    expect(del.message).toContain('append-only');
    const trunc = await expectPgError(() => db()`TRUNCATE wallet_ledger_entries CASCADE`);
    expect(trunc.message).toContain('append-only');
  });

  test('arithmetic check', async () => {
    const s = await seedWallet();
    const betId = await insertTx(db(), { walletId: s.walletId, playerId: s.playerId });
    const err = await expectPgError(
      () =>
        db()`INSERT INTO wallet_ledger_entries VALUES (${uuid()}, ${s.walletId}, ${betId}, 'DEBIT', 10, 'BRL', 100, 95, 2, now())`,
    );
    expect(err.constraint).toBe('ledger_arithmetic_ck');
  });

  test('chain must continue from the previous balance_after', async () => {
    const s = await seedWallet();
    const betId = await insertTx(db(), { walletId: s.walletId, playerId: s.playerId });
    const err = await expectPgError(
      () =>
        db()`INSERT INTO wallet_ledger_entries VALUES (${uuid()}, ${s.walletId}, ${betId}, 'DEBIT', 10, 'BRL', 50, 40, 2, now())`,
    );
    expect(err.message).toContain('ledger chain broken');
  });

  test('two entries for the same wallet version are impossible (lost update)', async () => {
    const s = await seedWallet();
    const betId = await insertTx(db(), { walletId: s.walletId, playerId: s.playerId });
    const dup = await expectPgError(
      () =>
        db()`INSERT INTO wallet_ledger_entries VALUES (${uuid()}, ${s.walletId}, ${betId}, 'CREDIT', 10, 'BRL', 0, 10, 1, now())`,
    );
    expect(dup.code).toBe('23505');
    expect(dup.constraint).toBe('ledger_wallet_version_uk');
  });

  test('at most one entry per transaction and wallet', async () => {
    const s = await seedWallet();
    const err = await expectPgError(
      () =>
        db()`INSERT INTO wallet_ledger_entries VALUES (${uuid()}, ${s.walletId}, ${s.openingId}, 'CREDIT', 10, 'BRL', 100, 110, 2, now())`,
    );
    expect(err.code).toBe('23505');
    expect(err.constraint).toBe('ledger_wallet_transaction_uk');
  });

  test('ledger currency must equal the wallet currency', async () => {
    const s = await seedWallet();
    const betId = await insertTx(db(), { walletId: s.walletId, playerId: s.playerId, currency: 'USD' });
    const err = await expectPgError(
      () =>
        db()`INSERT INTO wallet_ledger_entries VALUES (${uuid()}, ${s.walletId}, ${betId}, 'DEBIT', 10, 'USD', 100, 90, 2, now())`,
    );
    expect(err.code).toBe('23503');
    expect(err.constraint).toBe('ledger_wallet_currency_fk');
  });

  test('negative balances in entries are rejected', async () => {
    const s = await seedWallet('5.00');
    const betId = await insertTx(db(), { walletId: s.walletId, playerId: s.playerId });
    const err = await expectPgError(
      () =>
        db()`INSERT INTO wallet_ledger_entries VALUES (${uuid()}, ${s.walletId}, ${betId}, 'DEBIT', 10, 'BRL', 5, -5, 2, now())`,
    );
    expect(err.constraint).toBe('ledger_balances_non_negative_ck');
  });
});

describe('wager_transactions', () => {
  test('idempotency key and (provider, external id) are unique', async () => {
    const s = await seedWallet();
    await insertTx(db(), {
      walletId: s.walletId,
      playerId: s.playerId,
      key: `key-${s.walletId}`,
      externalId: `e-${s.walletId}`,
    });
    const k = await expectPgError(() =>
      insertTx(db(), { walletId: s.walletId, playerId: s.playerId, key: `key-${s.walletId}` }),
    );
    expect(k.constraint).toBe('wager_tx_idempotency_key_uk');
    const e = await expectPgError(() =>
      insertTx(db(), { walletId: s.walletId, playerId: s.playerId, externalId: `e-${s.walletId}` }),
    );
    expect(e.constraint).toBe('wager_tx_provider_external_uk');
  });

  test('a reference can be reversed only once (REFUND or ROLLBACK)', async () => {
    const s = await seedWallet();
    const betId = await insertTx(db(), { walletId: s.walletId, playerId: s.playerId });
    await insertTx(db(), { walletId: s.walletId, playerId: s.playerId, kind: 'REFUND', ref: 'b', refTxId: betId });
    const err = await expectPgError(() =>
      insertTx(db(), { walletId: s.walletId, playerId: s.playerId, kind: 'ROLLBACK', ref: 'b', refTxId: betId }),
    );
    expect(err.code).toBe('23505');
    expect(err.constraint).toBe('wager_tx_single_reversal_uk');
    // a REJECTED second reversal is allowed (auditable)
    await insertTx(db(), {
      walletId: s.walletId,
      playerId: s.playerId,
      kind: 'ROLLBACK',
      ref: 'b',
      refTxId: betId,
      status: 'REJECTED',
      failureCode: 'ALREADY_REVERSED',
    });
  });

  test('terminal transactions are frozen and cannot be deleted', async () => {
    const s = await seedWallet();
    const id = await insertTx(db(), { walletId: s.walletId, playerId: s.playerId });
    const upd = await expectPgError(
      () =>
        db()`UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'X', processed_at = NULL WHERE id = ${id}`,
    );
    expect(upd.message).toContain('is terminal');
    const del = await expectPgError(() => db()`DELETE FROM wager_transactions WHERE id = ${id}`);
    expect(del.message).toContain('cannot be deleted');
  });

  test('invalid transition and immutable columns', async () => {
    const s = await seedWallet();
    const id = await insertTx(db(), {
      walletId: s.walletId,
      playerId: s.playerId,
      kind: 'ROLLBACK',
      ref: 'missing',
      status: 'PENDING_REFERENCE',
      nextCheck: new Date(),
    });
    const back = await expectPgError(
      () => db()`UPDATE wager_transactions SET status = 'PENDING', next_reference_check_at = NULL WHERE id = ${id}`,
    );
    expect(back.message).toContain('invalid wager transaction transition');
    const imm = await expectPgError(() => db()`UPDATE wager_transactions SET amount = 99 WHERE id = ${id}`);
    expect(imm.message).toContain('immutable wager transaction column');
  });

  test('status-dependent CHECKs', async () => {
    const s = await seedWallet();
    const base = { walletId: s.walletId, playerId: s.playerId };
    expect((await expectPgError(() => insertTx(db(), { ...base, status: 'REJECTED' }))).constraint).toBe(
      'wager_tx_failure_code_ck',
    );
    const rejected = { status: 'REJECTED', failureCode: 'AMOUNT_MISMATCH' };
    expect((await expectPgError(() => insertTx(db(), { ...base, ...rejected, kind: 'REFUND' }))).constraint).toBe(
      'wager_tx_reference_required_ck',
    );
    expect((await expectPgError(() => insertTx(db(), { ...base, kind: 'BET', ref: 'x' }))).constraint).toBe(
      'wager_tx_reference_forbidden_ck',
    );
    expect((await expectPgError(() => insertTx(db(), { ...base, amount: '0.00' }))).constraint).toBe(
      'wager_tx_amount_ck',
    );
    expect((await expectPgError(() => insertTx(db(), { ...base, status: 'PENDING_REFERENCE' }))).constraint).toBe(
      'wager_tx_pending_ref_ck',
    );
    expect((await expectPgError(() => insertTx(db(), { ...base, kind: 'ROLLBACK', ref: 'x' }))).constraint).toBe(
      'wager_tx_processed_reversal_ref_ck',
    );
    expect((await expectPgError(() => insertTx(db(), { ...base, kind: 'OPENING', source: 'HTTP' }))).constraint).toBe(
      'wager_tx_opening_internal_ck',
    );
    // LOSS may be zero
    await insertTx(db(), { ...base, kind: 'LOSS', amount: '0.00' });
  });
});

describe('inbox', () => {
  test('(consumer, message_id) is unique', async () => {
    const id = uuid();
    await db()`INSERT INTO inbox_messages VALUES ('c', ${id}, ${hash}, NULL, now(), NULL)`;
    const err = await expectPgError(
      () => db()`INSERT INTO inbox_messages VALUES ('c', ${id}, ${hash}, NULL, now(), NULL)`,
    );
    expect(err.constraint).toBe('inbox_messages_pk');
    await db()`INSERT INTO inbox_messages VALUES ('other-consumer', ${id}, ${hash}, NULL, now(), NULL)`;
  });
});
