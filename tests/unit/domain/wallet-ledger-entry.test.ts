import { describe, expect, test } from 'bun:test';
import { InvalidLedgerEntryError, WalletLedgerEntry } from '../../../src/domain/ledger/wallet-ledger-entry';
import { Money } from '../../../src/domain/money/money';
import { brl, T0 } from '../../support/domain-builders';

const base = {
  id: 'e1',
  walletId: 'w1',
  transactionId: 't1',
  walletVersion: 2,
  createdAt: T0,
};

describe('WalletLedgerEntry.create', () => {
  test('valid credit and debit', () => {
    const c = WalletLedgerEntry.create({
      ...base,
      direction: 'CREDIT',
      money: brl('5.00'),
      balanceBefore: brl('10.00'),
      balanceAfter: brl('15.00'),
    });
    expect(c.isBalanced()).toBe(true);
    const d = WalletLedgerEntry.create({
      ...base,
      direction: 'DEBIT',
      money: brl('5.00'),
      balanceBefore: brl('10.00'),
      balanceAfter: brl('5.00'),
    });
    expect(d.isBalanced()).toBe(true);
  });

  test('rejects broken arithmetic', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: 'DEBIT',
        money: brl('5.00'),
        balanceBefore: brl('10.00'),
        balanceAfter: brl('6.00'),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejects mixed currencies', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: 'CREDIT',
        money: Money.from({ amount: '5.00', currency: 'USD' }),
        balanceBefore: brl('10.00'),
        balanceAfter: brl('15.00'),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejects zero amount', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: 'CREDIT',
        money: brl('0.00'),
        balanceBefore: brl('10.00'),
        balanceAfter: brl('10.00'),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejects negative resulting balance', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: 'DEBIT',
        money: brl('15.00'),
        balanceBefore: brl('10.00'),
        balanceAfter: Money.fromSigned({ amount: '-5.00', currency: 'BRL' }),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejects invalid wallet version', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        walletVersion: 0,
        direction: 'CREDIT',
        money: brl('5.00'),
        balanceBefore: brl('10.00'),
        balanceAfter: brl('15.00'),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('is structurally immutable', () => {
    const e = WalletLedgerEntry.create({
      ...base,
      direction: 'CREDIT',
      money: brl('5.00'),
      balanceBefore: brl('10.00'),
      balanceAfter: brl('15.00'),
    });
    expect(() => {
      // @ts-expect-error readonly field: assignment must not type-check
      e.money = brl('1.00');
    }).toThrow(TypeError);
    expect(() => {
      // @ts-expect-error readonly field: assignment must not type-check
      e.balanceAfter = brl('1.00');
    }).toThrow(TypeError);
    expect(e.balanceAfter.toJSON().amount).toBe('15.00');
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(e)).filter((n) => n !== 'constructor');
    expect(methods).toEqual(['isBalanced']);
  });
});
