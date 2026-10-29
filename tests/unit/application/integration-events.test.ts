import { describe, expect, test } from 'bun:test';
import {
  WagerTransactionFailed,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../../src/application/messaging/events';
import type { EventContext } from '../../../src/application/messaging/integration-event';
import { brl, T0, wagerTx, walletWith } from '../../support/domain-builders';

const ctx = (): EventContext => {
  let n = 0;
  return { correlationId: 'corr-1', causationId: 'cause-1', occurredAt: T0, nextId: () => `evt-${++n}` };
};

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('integration events', () => {
  test('WagerTransactionProcessed envelope', () => {
    const tx = wagerTx({ money: brl('25.00') });
    tx.markProcessed({ at: T0, balanceAfter: brl('975.00'), walletVersion: 2 });
    const json = WagerTransactionProcessed.from(tx, ctx()).toJSON();
    expect(json.eventType).toBe('WagerTransactionProcessed');
    expect(json.version).toBe(1);
    expect(json.eventId).toBe('evt-1');
    expect(json.aggregateId).toBe(tx.id);
    expect(json.correlationId).toBe('corr-1');
    expect(json.causationId).toBe('cause-1');
    expect(json.occurredAt).toMatch(ISO);
    expect(json.data.money).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(json.data.balanceAfter).toEqual({ amount: '975.00', currency: 'BRL' });
    expect(json.data.walletVersion).toBe(2);
    expect(json.data.processedAt).toMatch(ISO);
    // JSON-stable: round-trip preserves everything
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  test('WalletBalanceChanged carries MoneyProps and partition by wallet', () => {
    const wallet = walletWith('100.00');
    const entry = wallet.debit({ entryId: 'e', transactionId: 't', money: brl('25.00'), at: T0 });
    const evt = WalletBalanceChanged.from(wallet, entry, ctx());
    const json = evt.toJSON();
    expect(evt.partitionKey).toBe(wallet.id);
    expect(evt.aggregateType).toBe('Wallet');
    expect(json.eventType).toBe('WalletBalanceChanged');
    expect(json.data).toEqual({
      walletId: wallet.id,
      transactionId: 't',
      direction: 'DEBIT',
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      walletVersion: 2,
    });
  });

  test('Rejected / PendingReference / Failed', () => {
    const rejected = wagerTx();
    rejected.reject({ code: 'INSUFFICIENT_FUNDS', at: T0 });
    const r = WagerTransactionRejected.from(rejected, ctx()).toJSON();
    expect(r.eventType).toBe('WagerTransactionRejected');
    expect(r.data.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(r.data.rejectedAt).toMatch(ISO);

    const pending = wagerTx({ kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-x' });
    pending.markPendingReference({ at: T0, nextCheckAt: T0, observedBalance: brl('1.00'), walletVersion: 1 });
    const p = WagerTransactionPendingReference.from(pending, ctx()).toJSON();
    expect(p.eventType).toBe('WagerTransactionPendingReference');
    expect(p.data.referenceExternalTransactionId).toBe('bet-x');
    expect(p.data.nextCheckAt).toMatch(ISO);

    const failed = wagerTx();
    failed.fail({ code: 'PROCESSING_ERROR', at: T0 });
    const f = WagerTransactionFailed.from(failed, ctx()).toJSON();
    expect(f.eventType).toBe('WagerTransactionFailed');
    expect(f.data.failureCode).toBe('PROCESSING_ERROR');
  });

  test('causationId is omitted when absent', () => {
    const tx = wagerTx();
    tx.reject({ code: 'INSUFFICIENT_FUNDS', at: T0 });
    const json = WagerTransactionRejected.from(tx, { ...ctx(), causationId: undefined }).toJSON();
    expect('causationId' in json).toBe(false);
  });
});
