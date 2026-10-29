import { LedgerDirection } from '../ledger/ledger-direction';
import type { Wallet } from '../wallet/wallet';
import { FailureCode } from './failure-code';
import type { WagerTransaction } from './wager-transaction';
import { WagerTransactionKind } from './wager-transaction-kind';
import { WagerTransactionStatus } from './wager-transaction-status';

export type WagerDecision =
  | { type: 'APPLY'; direction: LedgerDirection; referenceTransactionId?: string }
  | { type: 'RECORD_ONLY'; referenceTransactionId?: string }
  | { type: 'REJECT'; failureCode: FailureCode; referenceTransactionId?: string; exposeBalance: boolean }
  | { type: 'AWAIT_REFERENCE' };

export interface WagerPolicyInput {
  /** Transaction in PENDING or PENDING_REFERENCE. */
  transaction: WagerTransaction;
  /** The wallet, already locked by the caller. */
  wallet: Wallet;
  /** Resolved by (providerId, referenceExternalTransactionId); null when not found. */
  reference: WagerTransaction | null;
  /** A PROCESSED REFUND/ROLLBACK already points at `reference`. */
  referenceAlreadyReversed: boolean;
}

/** Kinds each operation may reference (§7 rule 3 + interpretations in DESIGN §22). */
const ALLOWED_REFERENCE_KINDS: Readonly<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  OPENING: [],
  BET: [],
  WIN: [WagerTransactionKind.Bet],
  LOSS: [WagerTransactionKind.Bet],
  REFUND: [WagerTransactionKind.Bet],
  ROLLBACK: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
};

/**
 * Pure domain service deciding what to do with a wager transaction, given the
 * locked wallet and the resolved reference. Checks run in a fixed order and
 * the first failure decides, so the outcome is deterministic for a given state.
 * It never mutates anything: the application layer applies the decision.
 */
export class WagerPolicy {
  static decide(input: WagerPolicyInput): WagerDecision {
    const { transaction: tx, wallet, reference } = input;

    // 1-2: ownership and currency. Balance is not exposed for these (foreign wallet / wrong currency).
    if (wallet.playerId !== tx.playerId) {
      return { type: 'REJECT', failureCode: FailureCode.WalletPlayerMismatch, exposeBalance: false };
    }
    if (tx.money.currency !== wallet.currency) {
      return { type: 'REJECT', failureCode: FailureCode.CurrencyMismatch, exposeBalance: false };
    }

    // 3: reference resolution and validation.
    if (tx.referenceExternalTransactionId !== undefined) {
      if (reference === null) {
        return { type: 'AWAIT_REFERENCE' };
      }
      const referenceTransactionId = reference.id;
      const reject = (failureCode: FailureCode): WagerDecision => ({
        type: 'REJECT',
        failureCode,
        referenceTransactionId,
        exposeBalance: true,
      });
      if (
        reference.walletId !== tx.walletId ||
        reference.playerId !== tx.playerId ||
        reference.money.currency !== tx.money.currency ||
        reference.roundId !== tx.roundId
      ) {
        // Do not link a foreign transaction: keep referenceTransactionId only for same-wallet references.
        return { type: 'REJECT', failureCode: FailureCode.ReferenceMismatch, exposeBalance: true };
      }
      if (!ALLOWED_REFERENCE_KINDS[tx.kind].includes(reference.kind)) {
        return reject(FailureCode.InvalidReferenceKind);
      }
      if (
        reference.status === WagerTransactionStatus.Pending ||
        reference.status === WagerTransactionStatus.PendingReference
      ) {
        return { type: 'AWAIT_REFERENCE' };
      }
      if (reference.status === WagerTransactionStatus.Rejected || reference.status === WagerTransactionStatus.Failed) {
        return reject(FailureCode.ReferenceNotProcessed);
      }
      if (tx.isReversal() && !tx.money.equals(reference.money)) {
        return reject(FailureCode.AmountMismatch);
      }
      if (tx.isReversal() && input.referenceAlreadyReversed) {
        return reject(FailureCode.AlreadyReversed);
      }
    }

    const referenceTransactionId = reference?.id;

    // 4: LOSS records the outcome without moving money.
    if (tx.kind === WagerTransactionKind.Loss) {
      return { type: 'RECORD_ONLY', referenceTransactionId };
    }

    // 5-6: funds check for debits; a reversal without funds gets its own code (operationally different).
    const direction = tx.ledgerDirectionFor(reference ?? undefined);
    if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
      return {
        type: 'REJECT',
        failureCode:
          tx.kind === WagerTransactionKind.Rollback
            ? FailureCode.ReversalInsufficientFunds
            : FailureCode.InsufficientFunds,
        referenceTransactionId,
        exposeBalance: true,
      };
    }
    // 7: credits must keep the balance within the supported ceiling (mirrors a DB CHECK); rejecting here
    // keeps the outcome auditable instead of letting the database overflow.
    if (direction === LedgerDirection.Credit && !wallet.canCredit(tx.money)) {
      return {
        type: 'REJECT',
        failureCode: FailureCode.BalanceLimitExceeded,
        referenceTransactionId,
        exposeBalance: true,
      };
    }

    return { type: 'APPLY', direction, referenceTransactionId };
  }
}
