import { LedgerDirection } from '../ledger/ledger-direction';
import type { Money } from '../money/money';
import type { FailureCode } from './failure-code';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from './wager.errors';
import { isSubmittableKind, WagerTransactionKind } from './wager-transaction-kind';
import { TERMINAL_STATUSES, WagerTransactionStatus } from './wager-transaction-status';

export const TransactionSource = { Http: 'HTTP', Sqs: 'SQS', Internal: 'INTERNAL' } as const;
export type TransactionSource = (typeof TransactionSource)[keyof typeof TransactionSource];

/** Provider id reserved for internally generated transactions (OPENING). */
export const INTERNAL_PROVIDER_ID = 'internal';

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  source: TransactionSource;
  correlationId: string | undefined;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  processedAt: Date | undefined;
  /** Wallet balance observed when the current status was reached (replays return it). */
  resultBalance: Money | undefined;
  resultWalletVersion: number | undefined;
  referenceAttempts: number;
  nextReferenceCheckAt: Date | undefined;
  updatedAt: Date;
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: Money;
  referenceExternalTransactionId?: string;
  source: TransactionSource;
  correlationId?: string;
  createdAt: Date;
}

const REVERSAL_KINDS: readonly WagerTransactionKind[] = [WagerTransactionKind.Refund, WagerTransactionKind.Rollback];

/**
 * A provider operation (or the internal OPENING credit) and its lifecycle.
 *
 * State machine (mirrored by the `wager_tx_guard` trigger):
 *   PENDING -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE -> PENDING_REFERENCE (recordReferenceMiss) | PROCESSED | REJECTED | FAILED
 * PROCESSED, REJECTED and FAILED are terminal: transitioning them throws
 * {@link InvalidTransactionStateError} because it is a bug, not a business path.
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** Provider-side id of the referenced transaction — not the internal id. */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly source: TransactionSource,
    public readonly correlationId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    private _resultBalance: Money | undefined,
    private _resultWalletVersion: number | undefined,
    private _referenceAttempts: number,
    private _nextReferenceCheckAt: Date | undefined,
    private _updatedAt: Date,
  ) {}

  /** Creates a provider transaction in PENDING, validating the reference/amount rules per kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (!isSubmittableKind(props.kind)) {
      throw new InvalidWagerTransactionError(`kind ${props.kind} cannot be submitted`);
    }
    const kind = props.kind;
    if (props.providerId === INTERNAL_PROVIDER_ID) {
      throw new InvalidWagerTransactionError(`providerId "${INTERNAL_PROVIDER_ID}" is reserved`);
    }
    if (props.source === TransactionSource.Internal) {
      throw new InvalidWagerTransactionError('INTERNAL source is reserved for OPENING');
    }
    const ref = props.referenceExternalTransactionId;
    if (REVERSAL_KINDS.includes(kind) && !ref) {
      throw new InvalidWagerTransactionError(`${kind} requires referenceExternalTransactionId`);
    }
    if (kind === WagerTransactionKind.Bet && ref !== undefined) {
      throw new InvalidWagerTransactionError('BET must not reference another transaction');
    }
    if (ref !== undefined && ref === props.externalTransactionId) {
      throw new InvalidWagerTransactionError('a transaction cannot reference itself');
    }
    if (props.money.isNegative()) {
      throw new InvalidWagerTransactionError('amount must not be negative');
    }
    if (kind !== WagerTransactionKind.Loss && !props.money.isPositive()) {
      throw new InvalidWagerTransactionError(`${kind} amount must be greater than zero`);
    }
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      kind,
      props.money,
      ref,
      props.source,
      props.correlationId,
      props.createdAt,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
      props.createdAt,
    );
  }

  /**
   * Internal OPENING credit created together with the wallet. Born PROCESSED
   * (wallet version 1) — it never goes through the policy.
   */
  static createOpening(props: {
    id: string;
    walletId: string;
    playerId: string;
    money: Money;
    payloadHash: string;
    at: Date;
  }): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidWagerTransactionError('OPENING amount must be greater than zero');
    }
    const tx = new WagerTransaction(
      props.id,
      INTERNAL_PROVIDER_ID,
      `opening:${props.walletId}`,
      `internal:opening:${props.walletId}`,
      props.payloadHash,
      props.walletId,
      props.playerId,
      'opening',
      'internal',
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      TransactionSource.Internal,
      undefined,
      props.at,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
      props.at,
    );
    tx.markProcessed({ at: props.at, balanceAfter: props.money, walletVersion: 1 });
    return tx;
  }

  /** Rebuilds persisted state without re-validating transitions. */
  static rehydrate(s: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      s.id,
      s.providerId,
      s.externalTransactionId,
      s.idempotencyKey,
      s.payloadHash,
      s.walletId,
      s.playerId,
      s.roundId,
      s.gameId,
      s.kind,
      s.money,
      s.referenceExternalTransactionId,
      s.source,
      s.correlationId,
      s.createdAt,
      s.status,
      s.referenceTransactionId,
      s.failureCode,
      s.processedAt,
      s.resultBalance,
      s.resultWalletVersion,
      s.referenceAttempts,
      s.nextReferenceCheckAt,
      s.updatedAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }
  get resultWalletVersion(): number | undefined {
    return this._resultWalletVersion;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextReferenceCheckAt(): Date | undefined {
    return this._nextReferenceCheckAt;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  // ---- transitions -------------------------------------------------------

  /** Applied. Reversals must carry the internal id of the reversed transaction. */
  markProcessed(p: { referenceTransactionId?: string; at: Date; balanceAfter: Money; walletVersion: number }): void {
    this.assertNotTerminal('markProcessed');
    if (this.isReversal() && !p.referenceTransactionId) {
      throw new InvalidTransactionStateError(`${this.kind} cannot be processed without a resolved reference`);
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = p.referenceTransactionId ?? this._referenceTransactionId;
    this._processedAt = p.at;
    this._failureCode = undefined;
    this._nextReferenceCheckAt = undefined;
    this._resultBalance = p.balanceAfter;
    this._resultWalletVersion = p.walletVersion;
    this._updatedAt = p.at;
  }

  /** Accepted, but the referenced transaction is not available yet. */
  markPendingReference(p: { at: Date; nextCheckAt: Date; observedBalance: Money; walletVersion: number }): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(`markPendingReference from ${this._status}`);
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._nextReferenceCheckAt = p.nextCheckAt;
    this._resultBalance = p.observedBalance;
    this._resultWalletVersion = p.walletVersion;
    this._updatedAt = p.at;
  }

  /** The reference is still missing: count the attempt and reschedule (only in PENDING_REFERENCE). */
  recordReferenceMiss(p: { at: Date; nextCheckAt: Date }): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(`recordReferenceMiss from ${this._status}`);
    }
    this._referenceAttempts += 1;
    this._nextReferenceCheckAt = p.nextCheckAt;
    this._updatedAt = p.at;
  }

  /** Business-rule rejection. `observedBalance` is omitted when it must not be exposed. */
  reject(p: {
    code: FailureCode;
    at: Date;
    observedBalance?: Money;
    walletVersion?: number;
    referenceTransactionId?: string;
    countAttempt?: boolean;
  }): void {
    this.assertNotTerminal('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = p.code;
    this._processedAt = undefined;
    this._nextReferenceCheckAt = undefined;
    this._resultBalance = p.observedBalance;
    this._resultWalletVersion = p.observedBalance ? p.walletVersion : undefined;
    this._referenceTransactionId = p.referenceTransactionId ?? this._referenceTransactionId;
    if (p.countAttempt) {
      this._referenceAttempts += 1;
    }
    this._updatedAt = p.at;
  }

  /** Permanent processing failure (terminal, auditable). */
  fail(p: { code: FailureCode; at: Date }): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = p.code;
    this._processedAt = undefined;
    this._nextReferenceCheckAt = undefined;
    this._resultBalance = undefined;
    this._resultWalletVersion = undefined;
    this._updatedAt = p.at;
  }

  // ---- queries -----------------------------------------------------------

  isTerminal(): boolean {
    return TERMINAL_STATUSES.includes(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return REVERSAL_KINDS.includes(this.kind);
  }

  isReversal(): boolean {
    return REVERSAL_KINDS.includes(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * BET debits; WIN/REFUND/OPENING credit; ROLLBACK inverts the direction of
   * its reference (BET -> CREDIT, WIN/REFUND -> DEBIT). LOSS never moves money.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidTransactionStateError('ROLLBACK direction requires its reference');
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError('LOSS does not affect the balance');
    }
  }

  private assertNotTerminal(operation: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`${operation} on terminal transaction ${this.id} (${this._status})`);
    }
  }
}
