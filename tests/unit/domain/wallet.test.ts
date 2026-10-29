import { describe, expect, test } from 'bun:test';
import { LedgerDirection } from '../../../src/domain/ledger/ledger-direction';
import { CurrencyMismatchError, Money } from '../../../src/domain/money/money';
import { Wallet } from '../../../src/domain/wallet/wallet';
import { InsufficientFundsError, InvalidWalletError } from '../../../src/domain/wallet/wallet.errors';
import { brl, PLAYER, T0, WALLET, walletWith } from '../../support/domain-builders';

const T1 = new Date(T0.getTime() + 1000);

describe('Wallet.open', () => {
  test('positive initial balance creates OPENING credit entry at version 1', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: WALLET,
      playerId: PLAYER,
      initialBalance: brl('1000.00'),
      at: T0,
      opening: { transactionId: 'tx-open', entryId: 'e-1' },
    });
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(wallet.currency).toBe('BRL');
    expect(openingEntry).toBeDefined();
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.walletVersion).toBe(1);
    expect(openingEntry?.balanceBefore.isZero()).toBe(true);
    expect(openingEntry?.balanceAfter.equals(brl('1000.00'))).toBe(true);
  });

  test('zero initial balance creates no entry', () => {
    const { wallet, openingEntry } = Wallet.open({ id: WALLET, playerId: PLAYER, initialBalance: brl('0.00'), at: T0 });
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  test('positive balance without opening ids is rejected', () => {
    expect(() => Wallet.open({ id: WALLET, playerId: PLAYER, initialBalance: brl('1.00'), at: T0 })).toThrow(
      InvalidWalletError,
    );
  });

  test('negative initial balance is rejected', () => {
    const negative = Money.fromSigned({ amount: '-1.00', currency: 'BRL' });
    expect(() => Wallet.open({ id: WALLET, playerId: PLAYER, initialBalance: negative, at: T0 })).toThrow(
      InvalidWalletError,
    );
  });
});

describe('Wallet movements', () => {
  test('debit decrements balance, increments version by 1 and returns a balanced entry', () => {
    const w = walletWith('100.00');
    const entry = w.debit({ entryId: 'e', transactionId: 't', money: brl('30.00'), at: T1 });
    expect(w.balance.toJSON().amount).toBe('70.00');
    expect(w.version).toBe(2);
    expect(w.updatedAt).toEqual(T1);
    expect(entry.direction).toBe('DEBIT');
    expect(entry.walletVersion).toBe(2);
    expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('70.00');
    expect(entry.isBalanced()).toBe(true);
  });

  test('credit increments balance and version', () => {
    const w = walletWith('100.00');
    const entry = w.credit({ entryId: 'e', transactionId: 't', money: brl('0.01'), at: T1 });
    expect(w.balance.toJSON().amount).toBe('100.01');
    expect(w.version).toBe(2);
    expect(entry.direction).toBe('CREDIT');
  });

  test('debit of the whole balance leaves zero', () => {
    const w = walletWith('80.00');
    w.debit({ entryId: 'e', transactionId: 't', money: brl('80.00'), at: T1 });
    expect(w.balance.isZero()).toBe(true);
  });

  test('insufficient funds throws and leaves state untouched', () => {
    const w = walletWith('20.00');
    expect(() => w.debit({ entryId: 'e', transactionId: 't', money: brl('80.00'), at: T1 })).toThrow(
      InsufficientFundsError,
    );
    expect(w.balance.toJSON().amount).toBe('20.00');
    expect(w.version).toBe(1);
  });

  test('currency mismatch throws', () => {
    const w = walletWith('20.00');
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => w.credit({ entryId: 'e', transactionId: 't', money: usd, at: T1 })).toThrow(CurrencyMismatchError);
    expect(() => w.canDebit(usd)).toThrow(CurrencyMismatchError);
  });

  test('zero movement is rejected', () => {
    const w = walletWith('20.00');
    expect(() => w.credit({ entryId: 'e', transactionId: 't', money: brl('0.00'), at: T1 })).toThrow(
      InvalidWalletError,
    );
  });

  test('sequential movements form a chain', () => {
    const w = walletWith('100.00');
    const a = w.debit({ entryId: 'a', transactionId: 't1', money: brl('10.00'), at: T1 });
    const b = w.credit({ entryId: 'b', transactionId: 't2', money: brl('5.00'), at: T1 });
    expect(b.balanceBefore.equals(a.balanceAfter)).toBe(true);
    expect(b.walletVersion).toBe(a.walletVersion + 1);
  });
});

describe('Wallet.rehydrate', () => {
  test('rebuilds state without validation', () => {
    const w = Wallet.rehydrate({
      id: 'x',
      playerId: 'p',
      currency: 'USD',
      balance: Money.from({ amount: '5.00', currency: 'USD' }),
      version: 42,
      createdAt: T0,
      updatedAt: T1,
    });
    expect(w.version).toBe(42);
    expect(w.updatedAt).toEqual(T1);
  });
});
