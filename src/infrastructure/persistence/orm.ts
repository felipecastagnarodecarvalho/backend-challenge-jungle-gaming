import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { migrationsList } from './migrations';
import { InboxMessageSchema } from './schemas/inbox-message.schema';
import { LedgerEntrySchema } from './schemas/ledger-entry.schema';
import { OutboxMessageSchema } from './schemas/outbox-message.schema';
import { WagerTransactionSchema } from './schemas/wager-transaction.schema';
import { WalletSchema } from './schemas/wallet.schema';

export interface OrmOptions {
  url: string;
  poolMax: number;
}

/**
 * Creates the MikroORM instance. The schema comes exclusively from the
 * hand-written SQL migrations (no schema generator). `allowGlobalContext` is
 * off: every unit of work forks its own EntityManager explicitly.
 */
export async function createOrm(options: OrmOptions): Promise<MikroORM> {
  return MikroORM.init({
    clientUrl: options.url,
    entities: [WalletSchema, WagerTransactionSchema, LedgerEntrySchema, InboxMessageSchema, OutboxMessageSchema],
    extensions: [Migrator],
    pool: { min: 0, max: options.poolMax },
    migrations: {
      migrationsList,
      tableName: 'mikro_orm_migrations',
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      silent: true,
    },
    debug: false,
    allowGlobalContext: false,
    ensureDatabase: false,
  });
}
