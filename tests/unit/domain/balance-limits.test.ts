import { describe, expect, test } from 'bun:test';
import { InvalidMoneyError, Money } from '../../../src/domain/money/money';
import { WagerPolicy } from '../../../src/domain/wager/wager-policy';
import { Wallet } from '../../../src/domain/wallet/wallet';
import { BalanceLimitExceededError, InvalidWalletError } from '../../../src/domain/wallet/wallet.errors';
import { WalletMapper } from '../../../src/infrastructure/persistence/mappers';
import { brl, PLAYER, processedTx, T0, WALLET, wagerTx } from '../../support/domain-builders';

const MAX = '999999999999999.99';
const walletAt = (amount: string) =>
  Wallet.rehydrate({
    id: WALLET,
    playerId: PLAYER,
    currency: 'BRL',
    balance: Money.fromPersisted({ amount, currency: 'BRL' }),
    version: 1,
    createdAt: T0,
    updatedAt: T0,
  });

describe('Money.fromPersisted (rehydration, full NUMERIC(20,2) range)', () => {
  test.each(['0.00', MAX, '1999999999999999.98', '999999999999999999.99'])('accepts %p', (amount) => {
    expect(Money.fromPersisted({ amount, currency: 'BRL' }).toJSON().amount).toBe(amount);
  });

  test.each(['-1.00', '1000000000000000000.00', '1.5', 'NaN', ''])('rejects %p', (amount) => {
    expect(() => Money.fromPersisted({ amount, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test('input contract stays strict (15 integer digits)', () => {
    expect(() => Money.from({ amount: '1000000000000000.00', currency: 'BRL' })).toThrow(InvalidMoneyError);
    expect(Money.max('BRL').toJSON().amount).toBe(MAX);
  });
});

describe('balance ceiling', () => {
  test('credit up to exactly the ceiling is allowed, one cent more is not', () => {
    const w = walletAt('999999999999999.98');
    expect(w.canCredit(brl('0.01'))).toBe(true);
    expect(w.canCredit(brl('0.02'))).toBe(false);
    expect(() => w.credit({ entryId: 'e', transactionId: 't', money: brl('0.02'), at: T0 })).toThrow(
      BalanceLimitExceededError,
    );
    w.credit({ entryId: 'e', transactionId: 't', money: brl('0.01'), at: T0 });
    expect(w.balance.toJSON().amount).toBe(MAX);
  });

  test('wallet cannot be opened above the ceiling', () => {
    expect(() =>
      Wallet.open({
        id: WALLET,
        playerId: PLAYER,
        initialBalance: Money.fromPersisted({ amount: '1000000000000000.00', currency: 'BRL' }),
        at: T0,
        opening: { transactionId: 't', entryId: 'e' },
      }),
    ).toThrow(InvalidWalletError);
  });

  test('policy rejects WIN / ROLLBACK-of-BET credits beyond the ceiling as BALANCE_LIMIT_EXCEEDED (auditable)', () => {
    const wallet = walletAt(MAX);
    const win = WagerPolicy.decide({
      transaction: wagerTx({ kind: 'WIN', money: brl('1.00') }),
      wallet,
      reference: null,
      referenceAlreadyReversed: false,
    });
    expect(win).toMatchObject({ type: 'REJECT', failureCode: 'BALANCE_LIMIT_EXCEEDED', exposeBalance: true });
    const bet = processedTx({ kind: 'BET', externalTransactionId: 'b-1', money: brl('5.00') });
    const rollback = WagerPolicy.decide({
      transaction: wagerTx({ kind: 'ROLLBACK', money: brl('5.00'), referenceExternalTransactionId: 'b-1' }),
      wallet,
      reference: bet,
      referenceAlreadyReversed: false,
    });
    expect(rollback).toMatchObject({ type: 'REJECT', failureCode: 'BALANCE_LIMIT_EXCEEDED' });
    // debits are unaffected
    expect(
      WagerPolicy.decide({
        transaction: wagerTx({ money: brl('1.00') }),
        wallet,
        reference: null,
        referenceAlreadyReversed: false,
      }),
    ).toMatchObject({ type: 'APPLY', direction: 'DEBIT' });
  });

  test('a persisted balance above the input contract still rehydrates (wallet never stuck in 500)', () => {
    const w = WalletMapper.toDomain({
      id: WALLET,
      playerId: PLAYER,
      currency: 'BRL',
      balance: '1999999999999999.98',
      version: 3,
      createdAt: T0,
      updatedAt: T0,
    });
    expect(w.balance.toJSON().amount).toBe('1999999999999999.98');
    expect(w.canDebit(brl('1.00'))).toBe(true);
  });
});
