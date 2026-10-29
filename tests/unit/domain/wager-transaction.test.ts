import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/domain/money/money';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from '../../../src/domain/wager/wager.errors';
import { WagerTransaction } from '../../../src/domain/wager/wager-transaction';
import { brl, processedTx, T0, wagerTx } from '../../support/domain-builders';

const T1 = new Date(T0.getTime() + 1000);

describe('WagerTransaction.create', () => {
  test('is born PENDING with no outcome', () => {
    const tx = wagerTx();
    expect(tx.status).toBe('PENDING');
    expect(tx.isTerminal()).toBe(false);
    expect(tx.failureCode).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
    expect(tx.referenceAttempts).toBe(0);
  });

  test('OPENING cannot be submitted', () => {
    expect(() => wagerTx({ kind: 'OPENING' })).toThrow(InvalidWagerTransactionError);
    expect(() => wagerTx({ kind: 'JACKPOT' })).toThrow(InvalidWagerTransactionError);
  });

  test('REFUND and ROLLBACK require a reference', () => {
    expect(() => wagerTx({ kind: 'REFUND' })).toThrow(InvalidWagerTransactionError);
    expect(() => wagerTx({ kind: 'ROLLBACK' })).toThrow(InvalidWagerTransactionError);
    expect(wagerTx({ kind: 'REFUND', referenceExternalTransactionId: 'bet-1' }).requiresReference()).toBe(true);
  });

  test('BET must not carry a reference; self-reference rejected', () => {
    expect(() => wagerTx({ kind: 'BET', referenceExternalTransactionId: 'x' })).toThrow(InvalidWagerTransactionError);
    expect(() =>
      wagerTx({ kind: 'WIN', externalTransactionId: 'same', referenceExternalTransactionId: 'same' }),
    ).toThrow(InvalidWagerTransactionError);
  });

  test('amount must be positive except LOSS', () => {
    expect(() => wagerTx({ kind: 'BET', money: brl('0.00') })).toThrow(InvalidWagerTransactionError);
    expect(() => wagerTx({ kind: 'WIN', money: brl('0.00') })).toThrow(InvalidWagerTransactionError);
    expect(wagerTx({ kind: 'LOSS', money: brl('0.00') }).affectsBalance()).toBe(false);
  });

  test('internal provider and source are reserved', () => {
    expect(() => wagerTx({ providerId: 'internal' })).toThrow(InvalidWagerTransactionError);
    expect(() => wagerTx({ source: 'INTERNAL' })).toThrow(InvalidWagerTransactionError);
  });

  test('createOpening is born PROCESSED at wallet version 1', () => {
    const tx = WagerTransaction.createOpening({
      id: 'o1',
      walletId: 'w1',
      playerId: 'p1',
      money: brl('100.00'),
      payloadHash: 'b'.repeat(64),
      at: T0,
    });
    expect(tx.kind).toBe('OPENING');
    expect(tx.status).toBe('PROCESSED');
    expect(tx.providerId).toBe('internal');
    expect(tx.source).toBe('INTERNAL');
    expect(tx.resultWalletVersion).toBe(1);
    expect(tx.externalTransactionId).toBe('opening:w1');
  });
});

describe('WagerTransaction transitions', () => {
  test('PENDING -> PROCESSED records result and processedAt', () => {
    const tx = wagerTx();
    tx.markProcessed({ at: T1, balanceAfter: brl('90.00'), walletVersion: 2 });
    expect(tx.status).toBe('PROCESSED');
    expect(tx.processedAt).toEqual(T1);
    expect(tx.resultBalance?.toJSON().amount).toBe('90.00');
    expect(tx.resultWalletVersion).toBe(2);
    expect(tx.updatedAt).toEqual(T1);
  });

  test('reversal cannot be processed without the resolved reference id', () => {
    const tx = wagerTx({ kind: 'REFUND', referenceExternalTransactionId: 'bet' });
    expect(() => tx.markProcessed({ at: T1, balanceAfter: brl('1.00'), walletVersion: 2 })).toThrow(
      InvalidTransactionStateError,
    );
    tx.markProcessed({ at: T1, balanceAfter: brl('1.00'), walletVersion: 2, referenceTransactionId: 'ref' });
    expect(tx.referenceTransactionId).toBe('ref');
  });

  test('PENDING -> REJECTED keeps processedAt empty', () => {
    const tx = wagerTx();
    tx.reject({ code: 'INSUFFICIENT_FUNDS', at: T1, observedBalance: brl('5.00'), walletVersion: 3 });
    expect(tx.status).toBe('REJECTED');
    expect(tx.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(tx.processedAt).toBeUndefined();
    expect(tx.resultWalletVersion).toBe(3);
  });

  test('reject without exposing balance', () => {
    const tx = wagerTx();
    tx.reject({ code: 'CURRENCY_MISMATCH', at: T1 });
    expect(tx.resultBalance).toBeUndefined();
    expect(tx.resultWalletVersion).toBeUndefined();
  });

  test('PENDING -> PENDING_REFERENCE -> miss -> PROCESSED', () => {
    const tx = wagerTx({ kind: 'ROLLBACK', referenceExternalTransactionId: 'bet' });
    tx.markPendingReference({ at: T0, nextCheckAt: T1, observedBalance: brl('10.00'), walletVersion: 1 });
    expect(tx.status).toBe('PENDING_REFERENCE');
    expect(tx.nextReferenceCheckAt).toEqual(T1);
    const T2 = new Date(T1.getTime() + 2000);
    tx.recordReferenceMiss({ at: T1, nextCheckAt: T2 });
    expect(tx.status).toBe('PENDING_REFERENCE');
    expect(tx.referenceAttempts).toBe(1);
    expect(tx.nextReferenceCheckAt).toEqual(T2);
    tx.markProcessed({ at: T2, balanceAfter: brl('20.00'), walletVersion: 2, referenceTransactionId: 'r' });
    expect(tx.status).toBe('PROCESSED');
    expect(tx.nextReferenceCheckAt).toBeUndefined();
  });

  test('PENDING_REFERENCE -> REJECTED (expiry) and -> FAILED', () => {
    const a = wagerTx({ kind: 'REFUND', referenceExternalTransactionId: 'bet' });
    a.markPendingReference({ at: T0, nextCheckAt: T1, observedBalance: brl('10.00'), walletVersion: 1 });
    a.reject({
      code: 'REFERENCE_NOT_FOUND',
      at: T1,
      observedBalance: brl('10.00'),
      walletVersion: 1,
      countAttempt: true,
    });
    expect(a.status).toBe('REJECTED');
    expect(a.referenceAttempts).toBe(1);
    expect(a.nextReferenceCheckAt).toBeUndefined();

    const b = wagerTx({ kind: 'REFUND', referenceExternalTransactionId: 'bet' });
    b.markPendingReference({ at: T0, nextCheckAt: T1, observedBalance: brl('10.00'), walletVersion: 1 });
    b.fail({ code: 'PROCESSING_ERROR', at: T1 });
    expect(b.status).toBe('FAILED');
    expect(b.failureCode).toBe('PROCESSING_ERROR');
  });

  test('terminal states cannot transition', () => {
    const processed = processedTx();
    const rejected = wagerTx();
    rejected.reject({ code: 'INSUFFICIENT_FUNDS', at: T1 });
    const failed = wagerTx();
    failed.fail({ code: 'PROCESSING_ERROR', at: T1 });
    for (const tx of [processed, rejected, failed]) {
      expect(tx.isTerminal()).toBe(true);
      expect(() => tx.markProcessed({ at: T1, balanceAfter: brl('1.00'), walletVersion: 9 })).toThrow(
        InvalidTransactionStateError,
      );
      expect(() => tx.reject({ code: 'INSUFFICIENT_FUNDS', at: T1 })).toThrow(InvalidTransactionStateError);
      expect(() => tx.fail({ code: 'PROCESSING_ERROR', at: T1 })).toThrow(InvalidTransactionStateError);
      expect(() =>
        tx.markPendingReference({ at: T1, nextCheckAt: T1, observedBalance: brl('1.00'), walletVersion: 1 }),
      ).toThrow(InvalidTransactionStateError);
      expect(() => tx.recordReferenceMiss({ at: T1, nextCheckAt: T1 })).toThrow(InvalidTransactionStateError);
    }
  });

  test('recordReferenceMiss only in PENDING_REFERENCE; markPendingReference only from PENDING', () => {
    const tx = wagerTx({ kind: 'WIN', referenceExternalTransactionId: 'bet' });
    expect(() => tx.recordReferenceMiss({ at: T1, nextCheckAt: T1 })).toThrow(InvalidTransactionStateError);
    tx.markPendingReference({ at: T0, nextCheckAt: T1, observedBalance: brl('1.00'), walletVersion: 1 });
    expect(() =>
      tx.markPendingReference({ at: T1, nextCheckAt: T1, observedBalance: brl('1.00'), walletVersion: 1 }),
    ).toThrow(InvalidTransactionStateError);
  });
});

describe('WagerTransaction queries', () => {
  test('ledgerDirectionFor each kind', () => {
    const bet = processedTx({ kind: 'BET' });
    const win = processedTx({ kind: 'WIN' });
    const refund = processedTx({ kind: 'REFUND', referenceExternalTransactionId: 'b' }, 'ref');
    expect(bet.ledgerDirectionFor()).toBe('DEBIT');
    expect(win.ledgerDirectionFor()).toBe('CREDIT');
    expect(refund.ledgerDirectionFor()).toBe('CREDIT');
    const rollback = wagerTx({ kind: 'ROLLBACK', referenceExternalTransactionId: 'b' });
    expect(rollback.ledgerDirectionFor(bet)).toBe('CREDIT');
    expect(rollback.ledgerDirectionFor(win)).toBe('DEBIT');
    expect(rollback.ledgerDirectionFor(refund)).toBe('DEBIT');
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
    expect(() => wagerTx({ kind: 'LOSS' }).ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
  });

  test('matchesPayload / affectsBalance / isReversal', () => {
    const tx = wagerTx({ payloadHash: 'c'.repeat(64) });
    expect(tx.matchesPayload('c'.repeat(64))).toBe(true);
    expect(tx.matchesPayload('d'.repeat(64))).toBe(false);
    expect(tx.affectsBalance()).toBe(true);
    expect(tx.isReversal()).toBe(false);
    expect(wagerTx({ kind: 'ROLLBACK', referenceExternalTransactionId: 'x' }).isReversal()).toBe(true);
  });

  test('rehydrate does not validate', () => {
    const tx = WagerTransaction.rehydrate({
      id: 'x',
      providerId: 'internal',
      externalTransactionId: 'e',
      idempotencyKey: 'k',
      payloadHash: 'h',
      walletId: 'w',
      playerId: 'p',
      roundId: 'r',
      gameId: 'g',
      kind: 'OPENING',
      money: Money.from({ amount: '0.00', currency: 'BRL' }),
      referenceExternalTransactionId: undefined,
      source: 'INTERNAL',
      correlationId: undefined,
      createdAt: T0,
      status: 'PROCESSED',
      referenceTransactionId: undefined,
      failureCode: undefined,
      processedAt: T0,
      resultBalance: undefined,
      resultWalletVersion: undefined,
      referenceAttempts: 0,
      nextReferenceCheckAt: undefined,
      updatedAt: T0,
    });
    expect(tx.status).toBe('PROCESSED');
  });
});
