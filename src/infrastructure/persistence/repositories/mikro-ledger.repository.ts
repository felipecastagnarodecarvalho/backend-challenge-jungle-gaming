import type { EntityManager } from '@mikro-orm/postgresql';
import type { LedgerRepository } from '../../../application/ports/ledger-repository';
import type { WalletLedgerEntry } from '../../../domain/ledger/wallet-ledger-entry';
import { LedgerEntryMapper } from '../mappers';
import { LedgerEntrySchema } from '../schemas/ledger-entry.schema';

/** Insert-only: there is deliberately no update/delete method (the DB forbids them too). */
export class MikroLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntrySchema, LedgerEntryMapper.toRecord(entry));
  }
}
