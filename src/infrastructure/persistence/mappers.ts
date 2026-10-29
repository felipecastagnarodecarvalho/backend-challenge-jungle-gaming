import type { InboxMessage } from '../../application/messaging/inbox-message';
import { OutboxMessage } from '../../application/messaging/outbox-message';
import type { LedgerDirection } from '../../domain/ledger/ledger-direction';
import { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import { Money } from '../../domain/money/money';
import type { FailureCode } from '../../domain/wager/failure-code';
import { type TransactionSource, WagerTransaction } from '../../domain/wager/wager-transaction';
import type { WagerTransactionKind } from '../../domain/wager/wager-transaction-kind';
import type { WagerTransactionStatus } from '../../domain/wager/wager-transaction-status';
import { Wallet } from '../../domain/wallet/wallet';
import type { InboxMessageRecord } from './schemas/inbox-message.schema';
import type { LedgerEntryRecord } from './schemas/ledger-entry.schema';
import type { OutboxMessageRecord } from './schemas/outbox-message.schema';
import type { WagerTransactionRecord } from './schemas/wager-transaction.schema';
import type { WalletRecord } from './schemas/wallet.schema';

/**
 * Record <-> domain mapping. NUMERIC columns arrive as exact strings and are
 * rebuilt as Money (never via JS number); `rehydrate` is used so persisted
 * state is not re-validated.
 */
const amount = (value: string | number, currency: string): Money => {
  // Guard against a driver ever returning numbers: refuse instead of losing precision silently.
  if (typeof value !== 'string') {
    throw new Error('NUMERIC column returned as number; refusing to build Money from a float');
  }
  return Money.from({ amount: normaliseScale(value), currency });
};

/** NUMERIC(20,2) is always rendered with 2 decimals by Postgres; keep a defensive normalisation. */
function normaliseScale(value: string): string {
  if (/^\d+\.\d{2}$/.test(value)) return value;
  if (/^\d+$/.test(value)) return `${value}.00`;
  if (/^\d+\.\d$/.test(value)) return `${value}0`;
  return value;
}

const toDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));
const toDateOrUndef = (v: Date | string | null | undefined): Date | undefined => (v == null ? undefined : toDate(v));
const orUndef = <T>(v: T | null | undefined): T | undefined => (v == null ? undefined : v);

export const WalletMapper = {
  toDomain(r: WalletRecord): Wallet {
    const currency = r.currency.trim();
    return Wallet.rehydrate({
      id: r.id,
      playerId: r.playerId,
      currency,
      balance: amount(r.balance, currency),
      version: r.version,
      createdAt: toDate(r.createdAt),
      updatedAt: toDate(r.updatedAt),
    });
  },
  toRecord(w: Wallet): WalletRecord {
    return {
      id: w.id,
      playerId: w.playerId,
      currency: w.currency,
      balance: w.balance.toJSON().amount,
      version: w.version,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    };
  },
};

export const WagerTransactionMapper = {
  toDomain(r: WagerTransactionRecord): WagerTransaction {
    const currency = r.currency.trim();
    return WagerTransaction.rehydrate({
      id: r.id,
      providerId: r.providerId,
      externalTransactionId: r.externalTransactionId,
      idempotencyKey: r.idempotencyKey,
      payloadHash: r.payloadHash,
      walletId: r.walletId,
      playerId: r.playerId,
      roundId: r.roundId,
      gameId: r.gameId,
      kind: r.kind as WagerTransactionKind,
      money: amount(r.amount, currency),
      referenceExternalTransactionId: orUndef(r.referenceExternalTransactionId),
      source: r.source as TransactionSource,
      correlationId: orUndef(r.correlationId),
      createdAt: toDate(r.createdAt),
      status: r.status as WagerTransactionStatus,
      referenceTransactionId: orUndef(r.referenceTransactionId),
      failureCode: orUndef(r.failureCode) as FailureCode | undefined,
      processedAt: toDateOrUndef(r.processedAt),
      resultBalance: r.resultBalanceAmount == null ? undefined : amount(r.resultBalanceAmount, currency),
      resultWalletVersion: orUndef(r.resultWalletVersion),
      referenceAttempts: r.referenceAttempts,
      nextReferenceCheckAt: toDateOrUndef(r.nextReferenceCheckAt),
      updatedAt: toDate(r.updatedAt),
    });
  },
  toRecord(t: WagerTransaction): WagerTransactionRecord {
    return {
      id: t.id,
      providerId: t.providerId,
      externalTransactionId: t.externalTransactionId,
      idempotencyKey: t.idempotencyKey,
      payloadHash: t.payloadHash,
      walletId: t.walletId,
      playerId: t.playerId,
      roundId: t.roundId,
      gameId: t.gameId,
      kind: t.kind,
      amount: t.money.toJSON().amount,
      currency: t.money.currency,
      referenceExternalTransactionId: t.referenceExternalTransactionId ?? null,
      referenceTransactionId: t.referenceTransactionId ?? null,
      status: t.status,
      failureCode: t.failureCode ?? null,
      resultBalanceAmount: t.resultBalance ? t.resultBalance.toJSON().amount : null,
      resultWalletVersion: t.resultWalletVersion ?? null,
      referenceAttempts: t.referenceAttempts,
      nextReferenceCheckAt: t.nextReferenceCheckAt ?? null,
      source: t.source,
      correlationId: t.correlationId ?? null,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      processedAt: t.processedAt ?? null,
    };
  },
};

export const LedgerEntryMapper = {
  toDomain(r: LedgerEntryRecord): WalletLedgerEntry {
    const currency = r.currency.trim();
    return WalletLedgerEntry.rehydrate({
      id: r.id,
      walletId: r.walletId,
      transactionId: r.transactionId,
      direction: r.direction as LedgerDirection,
      money: amount(r.amount, currency),
      balanceBefore: amount(r.balanceBefore, currency),
      balanceAfter: amount(r.balanceAfter, currency),
      walletVersion: r.walletVersion,
      createdAt: toDate(r.createdAt),
    });
  },
  toRecord(e: WalletLedgerEntry): LedgerEntryRecord {
    return {
      id: e.id,
      walletId: e.walletId,
      transactionId: e.transactionId,
      direction: e.direction,
      amount: e.money.toJSON().amount,
      currency: e.money.currency,
      balanceBefore: e.balanceBefore.toJSON().amount,
      balanceAfter: e.balanceAfter.toJSON().amount,
      walletVersion: e.walletVersion,
      createdAt: e.createdAt,
    };
  },
};

export const InboxMessageMapper = {
  toRecord(m: InboxMessage): InboxMessageRecord {
    return {
      consumerName: m.consumerName,
      messageId: m.messageId,
      payloadHash: m.payloadHash,
      transactionId: m.transactionId ?? null,
      receivedAt: m.receivedAt,
      processedAt: m.processedAt ?? null,
    };
  },
};

export const OutboxMessageMapper = {
  toDomain(r: OutboxMessageRecord): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: r.id,
      aggregateType: r.aggregateType,
      aggregateId: r.aggregateId,
      partitionKey: r.partitionKey,
      eventType: r.eventType,
      eventVersion: r.eventVersion,
      payload: typeof r.payload === 'string' ? (JSON.parse(r.payload) as Record<string, unknown>) : r.payload,
      correlationId: r.correlationId,
      causationId: orUndef(r.causationId),
      occurredAt: toDate(r.occurredAt),
      attempts: r.attempts,
      nextAttemptAt: toDate(r.nextAttemptAt),
      publishedAt: toDateOrUndef(r.publishedAt),
      lastError: orUndef(r.lastError),
    });
  },
  toRecord(m: OutboxMessage): OutboxMessageRecord {
    return {
      id: m.id,
      aggregateType: m.aggregateType,
      aggregateId: m.aggregateId,
      partitionKey: m.partitionKey,
      eventType: m.eventType,
      eventVersion: m.eventVersion,
      payload: { ...m.payload },
      correlationId: m.correlationId,
      causationId: m.causationId ?? null,
      occurredAt: m.occurredAt,
      attempts: m.attempts,
      nextAttemptAt: m.nextAttemptAt ?? m.occurredAt,
      publishedAt: m.publishedAt ?? null,
      lastError: m.lastError ?? null,
    };
  },
};
