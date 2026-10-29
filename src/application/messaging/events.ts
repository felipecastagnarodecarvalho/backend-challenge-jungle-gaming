import type { LedgerDirection } from '../../domain/ledger/ledger-direction';
import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import type { MoneyProps } from '../../domain/money/money';
import type { FailureCode } from '../../domain/wager/failure-code';
import type { WagerTransaction } from '../../domain/wager/wager-transaction';
import type { WagerTransactionKind } from '../../domain/wager/wager-transaction-kind';
import type { Wallet } from '../../domain/wallet/wallet';
import { type EventContext, IntegrationEvent } from './integration-event';

function envelope<T>(ctx: EventContext, aggregateId: string, data: T) {
  return {
    eventId: ctx.nextId(),
    aggregateId,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    occurredAt: ctx.occurredAt,
    data,
  };
}

function requireDefined<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`event invariant: ${what} must be defined`);
  }
  return value;
}

// ---------------------------------------------------------------------------

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceTransactionId: string | null;
  balanceAfter: MoneyProps;
  walletVersion: number;
  processedAt: string;
}

/** Any applied transaction, including LOSS (no balance change) and OPENING. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;
  readonly aggregateType = 'WagerTransaction';

  get partitionKey(): string {
    return this.data.walletId;
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed(
      envelope(ctx, tx.id, {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        playerId: tx.playerId,
        roundId: tx.roundId,
        gameId: tx.gameId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        referenceTransactionId: tx.referenceTransactionId ?? null,
        balanceAfter: requireDefined(tx.resultBalance, 'resultBalance').toJSON(),
        walletVersion: requireDefined(tx.resultWalletVersion, 'resultWalletVersion'),
        processedAt: requireDefined(tx.processedAt, 'processedAt').toISOString(),
      }),
    );
  }
}

// ---------------------------------------------------------------------------

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  failureCode: FailureCode;
  referenceExternalTransactionId: string | null;
  rejectedAt: string;
}

/** Business-rule rejection, including PENDING_REFERENCE expiry (REFERENCE_NOT_FOUND). */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;
  readonly aggregateType = 'WagerTransaction';

  get partitionKey(): string {
    return this.data.walletId;
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected(
      envelope(ctx, tx.id, {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        playerId: tx.playerId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        failureCode: requireDefined(tx.failureCode, 'failureCode'),
        referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
        rejectedAt: tx.updatedAt.toISOString(),
      }),
    );
  }
}

// ---------------------------------------------------------------------------

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Emitted only when a ledger entry is written (i.e. the balance actually changed). */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;
  readonly aggregateType = 'Wallet';

  get partitionKey(): string {
    return this.data.walletId;
  }

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged(
      envelope(ctx, wallet.id, {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      }),
    );
  }
}

// ---------------------------------------------------------------------------

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: WagerTransactionKind;
  referenceExternalTransactionId: string | null;
  nextCheckAt: string;
}

/** Accepted, waiting for its reference (out-of-order delivery). */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;
  readonly aggregateType = 'WagerTransaction';

  get partitionKey(): string {
    return this.data.walletId;
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(
      envelope(ctx, tx.id, {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        kind: tx.kind,
        referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
        nextCheckAt: requireDefined(tx.nextReferenceCheckAt, 'nextReferenceCheckAt').toISOString(),
      }),
    );
  }
}

// ---------------------------------------------------------------------------

export interface WagerTransactionFailedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  failureCode: FailureCode;
  failedAt: string;
}

/** Permanent processing failure of a pending transaction (auditable terminal state). */
export class WagerTransactionFailed extends IntegrationEvent<WagerTransactionFailedData> {
  readonly eventType = 'WagerTransactionFailed';
  readonly version = 1;
  readonly aggregateType = 'WagerTransaction';

  get partitionKey(): string {
    return this.data.walletId;
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionFailed {
    return new WagerTransactionFailed(
      envelope(ctx, tx.id, {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        failureCode: requireDefined(tx.failureCode, 'failureCode'),
        failedAt: tx.updatedAt.toISOString(),
      }),
    );
  }
}

export type WageringIntegrationEvent =
  | WagerTransactionProcessed
  | WagerTransactionRejected
  | WalletBalanceChanged
  | WagerTransactionPendingReference
  | WagerTransactionFailed;
