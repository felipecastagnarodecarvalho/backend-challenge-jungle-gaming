import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/domain/money/money';
import { type WagerDecision, WagerPolicy } from '../../../src/domain/wager/wager-policy';
import type { WagerTransaction } from '../../../src/domain/wager/wager-transaction';
import { brl, PLAYER, processedTx, T0, wagerTx, walletWith } from '../../support/domain-builders';

function decide(
  tx: WagerTransaction,
  opts: { balance?: string; reference?: WagerTransaction | null; reversed?: boolean; walletPlayer?: string } = {},
): WagerDecision {
  return WagerPolicy.decide({
    transaction: tx,
    wallet: walletWith(opts.balance ?? '100.00', { playerId: opts.walletPlayer ?? PLAYER }),
    reference: opts.reference ?? null,
    referenceAlreadyReversed: opts.reversed ?? false,
  });
}

const bet = (amount = '10.00', ext = 'bet-1') =>
  processedTx({ kind: 'BET', money: brl(amount), externalTransactionId: ext });

describe('BET', () => {
  test('applied as DEBIT when funds suffice (including exact balance)', () => {
    expect(decide(wagerTx({ money: brl('100.00') }))).toEqual({
      type: 'APPLY',
      direction: 'DEBIT',
      referenceTransactionId: undefined,
    });
  });

  test('INSUFFICIENT_FUNDS', () => {
    expect(decide(wagerTx({ money: brl('80.00') }), { balance: '20.00' })).toMatchObject({
      type: 'REJECT',
      failureCode: 'INSUFFICIENT_FUNDS',
      exposeBalance: true,
    });
  });
});

describe('WIN', () => {
  test('credit without reference', () => {
    expect(decide(wagerTx({ kind: 'WIN' }))).toMatchObject({ type: 'APPLY', direction: 'CREDIT' });
  });

  test('WIN -> BET reference is ok and linked', () => {
    const ref = bet();
    expect(decide(wagerTx({ kind: 'WIN', referenceExternalTransactionId: 'bet-1' }), { reference: ref })).toEqual({
      type: 'APPLY',
      direction: 'CREDIT',
      referenceTransactionId: ref.id,
    });
  });

  test('WIN -> WIN is INVALID_REFERENCE_KIND', () => {
    const win = processedTx({ kind: 'WIN', externalTransactionId: 'win-1' });
    expect(decide(wagerTx({ kind: 'WIN', referenceExternalTransactionId: 'win-1' }), { reference: win })).toMatchObject(
      {
        type: 'REJECT',
        failureCode: 'INVALID_REFERENCE_KIND',
      },
    );
  });
});

describe('LOSS', () => {
  test('RECORD_ONLY even with zero amount and zero balance', () => {
    expect(decide(wagerTx({ kind: 'LOSS', money: brl('0.00') }), { balance: '0.00' })).toEqual({
      type: 'RECORD_ONLY',
      referenceTransactionId: undefined,
    });
  });
});

describe('REFUND', () => {
  const refund = (amount = '10.00') =>
    wagerTx({ kind: 'REFUND', money: brl(amount), referenceExternalTransactionId: 'bet-1' });

  test('REFUND -> BET credits', () => {
    const ref = bet();
    expect(decide(refund(), { reference: ref })).toEqual({
      type: 'APPLY',
      direction: 'CREDIT',
      referenceTransactionId: ref.id,
    });
  });

  test('REFUND -> WIN is INVALID_REFERENCE_KIND', () => {
    const win = processedTx({ kind: 'WIN', externalTransactionId: 'bet-1' });
    expect(decide(refund(), { reference: win })).toMatchObject({ failureCode: 'INVALID_REFERENCE_KIND' });
  });

  test('AMOUNT_MISMATCH', () => {
    expect(decide(refund('5.00'), { reference: bet('10.00') })).toMatchObject({ failureCode: 'AMOUNT_MISMATCH' });
  });

  test('ALREADY_REVERSED', () => {
    expect(decide(refund(), { reference: bet(), reversed: true })).toMatchObject({ failureCode: 'ALREADY_REVERSED' });
  });
});

describe('ROLLBACK', () => {
  const rollback = (amount = '10.00', ref = 'bet-1') =>
    wagerTx({ kind: 'ROLLBACK', money: brl(amount), referenceExternalTransactionId: ref });

  test('of BET credits', () => {
    expect(decide(rollback(), { reference: bet() })).toMatchObject({ type: 'APPLY', direction: 'CREDIT' });
  });

  test('of WIN debits', () => {
    const win = processedTx({ kind: 'WIN', externalTransactionId: 'win-1', money: brl('10.00') });
    expect(decide(rollback('10.00', 'win-1'), { reference: win })).toMatchObject({ type: 'APPLY', direction: 'DEBIT' });
  });

  test('of REFUND debits', () => {
    const r = processedTx({ kind: 'REFUND', externalTransactionId: 'ref-1', referenceExternalTransactionId: 'b' }, 'x');
    expect(decide(rollback('10.00', 'ref-1'), { reference: r })).toMatchObject({ type: 'APPLY', direction: 'DEBIT' });
  });

  test('REVERSAL_INSUFFICIENT_FUNDS (distinct from INSUFFICIENT_FUNDS)', () => {
    const win = processedTx({ kind: 'WIN', externalTransactionId: 'win-1', money: brl('50.00') });
    expect(decide(rollback('50.00', 'win-1'), { reference: win, balance: '20.00' })).toMatchObject({
      type: 'REJECT',
      failureCode: 'REVERSAL_INSUFFICIENT_FUNDS',
      referenceTransactionId: win.id,
    });
  });

  test('of LOSS/ROLLBACK is INVALID_REFERENCE_KIND', () => {
    const loss = processedTx({ kind: 'LOSS', externalTransactionId: 'loss-1' });
    expect(decide(rollback('10.00', 'loss-1'), { reference: loss })).toMatchObject({
      failureCode: 'INVALID_REFERENCE_KIND',
    });
  });
});

describe('references', () => {
  const rollback = () => wagerTx({ kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-1' });

  test('missing reference -> AWAIT_REFERENCE', () => {
    expect(decide(rollback(), { reference: null })).toEqual({ type: 'AWAIT_REFERENCE' });
  });

  test('reference still pending -> AWAIT_REFERENCE', () => {
    const pending = wagerTx({ kind: 'WIN', externalTransactionId: 'bet-1', referenceExternalTransactionId: 'x' });
    pending.markPendingReference({ at: T0, nextCheckAt: T0, observedBalance: brl('1.00'), walletVersion: 1 });
    const pendingBet = wagerTx({ kind: 'BET', externalTransactionId: 'bet-1' });
    expect(decide(rollback(), { reference: pendingBet })).toEqual({ type: 'AWAIT_REFERENCE' });
    expect(
      decide(wagerTx({ kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-1' }), { reference: pending }),
    ).toEqual({
      type: 'AWAIT_REFERENCE',
    });
  });

  test('rejected reference -> REFERENCE_NOT_PROCESSED', () => {
    const r = wagerTx({ kind: 'BET', externalTransactionId: 'bet-1' });
    r.reject({ code: 'INSUFFICIENT_FUNDS', at: T0 });
    expect(decide(rollback(), { reference: r })).toMatchObject({ failureCode: 'REFERENCE_NOT_PROCESSED' });
  });

  test.each([
    ['wallet', { walletId: 'other-wallet' }],
    ['player', { playerId: 'other-player' }],
    ['round', { roundId: 'other-round' }],
    ['currency', { money: Money.from({ amount: '10.00', currency: 'USD' }) }],
  ])('REFERENCE_MISMATCH on different %s', (_label, override) => {
    const r = processedTx({ kind: 'BET', externalTransactionId: 'bet-1', ...override });
    expect(decide(rollback(), { reference: r })).toMatchObject({ type: 'REJECT', failureCode: 'REFERENCE_MISMATCH' });
  });
});

describe('ownership/currency and precedence', () => {
  test('WALLET_PLAYER_MISMATCH hides balance', () => {
    expect(decide(wagerTx(), { walletPlayer: 'someone-else' })).toEqual({
      type: 'REJECT',
      failureCode: 'WALLET_PLAYER_MISMATCH',
      exposeBalance: false,
    });
  });

  test('CURRENCY_MISMATCH hides balance', () => {
    expect(decide(wagerTx({ money: Money.from({ amount: '1.00', currency: 'USD' }) }))).toEqual({
      type: 'REJECT',
      failureCode: 'CURRENCY_MISMATCH',
      exposeBalance: false,
    });
  });

  test('player mismatch wins over currency mismatch; currency over missing reference', () => {
    const tx = wagerTx({
      kind: 'ROLLBACK',
      referenceExternalTransactionId: 'zzz',
      money: Money.from({ amount: '1.00', currency: 'USD' }),
    });
    expect(decide(tx, { walletPlayer: 'x' })).toMatchObject({ failureCode: 'WALLET_PLAYER_MISMATCH' });
    expect(decide(tx)).toMatchObject({ failureCode: 'CURRENCY_MISMATCH' });
  });

  test('amount mismatch is checked before already-reversed and funds', () => {
    const tx = wagerTx({ kind: 'REFUND', money: brl('99.00'), referenceExternalTransactionId: 'bet-1' });
    expect(decide(tx, { reference: bet('10.00'), reversed: true, balance: '0.00' })).toMatchObject({
      failureCode: 'AMOUNT_MISMATCH',
    });
  });
});
