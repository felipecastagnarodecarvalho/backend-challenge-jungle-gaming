import type { Wallet } from '../../domain/wallet/wallet';

/** Bound to the current SQL transaction. */
export interface WalletRepository {
  /** `SELECT … FOR UPDATE`: the per-wallet serialization point (lock wait bounded by lock_timeout). */
  findByIdForUpdate(id: string): Promise<Wallet | null>;
  insert(wallet: Wallet): Promise<void>;
  /** `UPDATE … WHERE id = ? AND version = ?`; anything but 1 affected row is a bug (ConcurrencyInvariantError). */
  saveBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}
