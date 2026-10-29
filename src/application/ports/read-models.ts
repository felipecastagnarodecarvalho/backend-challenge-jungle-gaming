import type { MoneyProps } from '../../domain/money/money';

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
  createdAt: string;
}

export interface WagerTransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: string;
  failureCode: string | null;
  balanceAfter: MoneyProps | null;
  walletVersion: number | null;
  createdAt: string;
  updatedAt: string;
  processedAt: string | null;
}

export interface ReconciliationSnapshot {
  wallet: { id: string; currency: string; balance: string; version: number };
  /** Signed decimal string: SUM(credits) - SUM(debits). */
  ledgerSum: string;
  entries: number;
  lastEntry: { walletVersion: number; balanceAfter: string } | null;
  chainBreaks: number;
}

export interface WalletReadModel {
  getById(id: string): Promise<WalletView | null>;
}

export interface LedgerReadModel {
  page(walletId: string, afterVersion: number, limit: number): Promise<LedgerEntryView[]>;
}

export interface WagerTransactionReadModel {
  getById(id: string): Promise<WagerTransactionView | null>;
  getByProviderExternalId(providerId: string, externalId: string): Promise<WagerTransactionView | null>;
}

export interface ReconciliationReadModel {
  /** One consistent snapshot (REPEATABLE READ, READ ONLY) without locking writers. */
  snapshot(walletId: string): Promise<ReconciliationSnapshot | null>;
}

export interface OperationalGaugesReadModel {
  outboxPending(): Promise<{ count: number; oldestAgeSeconds: number }>;
  pendingReferences(): Promise<number>;
}
