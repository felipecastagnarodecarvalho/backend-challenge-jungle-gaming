import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';

/** Append-only by contract (and by database triggers). */
export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
}
