import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { ConcurrencyInvariantError } from '../../../application/errors';
import type { WalletRepository } from '../../../application/ports/wallet-repository';
import type { Wallet } from '../../../domain/wallet/wallet';
import { WalletMapper } from '../mappers';
import { WalletSchema } from '../schemas/wallet.schema';

export class MikroWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  /**
   * Row lock on the wallet: every read-decide-write on a wallet starts here, so
   * all mutations of one wallet are serialized while different wallets proceed
   * in parallel (no global lock). In READ COMMITTED, once the lock is granted,
   * subsequent statements see everything committed before it.
   */
  async findByIdForUpdate(id: string): Promise<Wallet | null> {
    const record = await this.em.findOne(
      WalletSchema,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true, disableIdentityMap: true },
    );
    return record ? WalletMapper.toDomain(record) : null;
  }

  async insert(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletSchema, WalletMapper.toRecord(wallet));
  }

  /** Version-guarded write; under the row lock it must always hit exactly one row. */
  async saveBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await this.em.nativeUpdate(
      WalletSchema,
      { id: wallet.id, version: expectedVersion },
      { balance: wallet.balance.toJSON().amount, version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (affected !== 1) {
      throw new ConcurrencyInvariantError(`wallet ${wallet.id} version ${expectedVersion} not found under lock`);
    }
  }
}
