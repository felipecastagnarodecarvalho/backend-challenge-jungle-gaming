import { afterAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { createOrm } from '../../src/infrastructure/persistence/orm';
import { TEST_DATABASE_URL } from '../support/env';

/** Runs the full up -> down -> up cycle on a throwaway database. */
const dbName = `wagering_migr_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const adminUrl = new URL(TEST_DATABASE_URL);
adminUrl.pathname = '/postgres';
const targetUrl = new URL(TEST_DATABASE_URL);
targetUrl.pathname = `/${dbName}`;

const admin = new SQL(adminUrl.toString());

afterAll(async () => {
  await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.close();
});

async function inventory(sql: SQL) {
  const tables = await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`;
  const indexes = await sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`;
  const triggers = await sql`SELECT DISTINCT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1`;
  const functions = await sql`SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                              WHERE n.nspname = 'public' ORDER BY 1`;
  const names = (rows: Array<Record<string, string>>, key: string) => rows.map((r) => r[key]);
  return {
    tables: names(tables, 'tablename'),
    indexes: names(indexes, 'indexname'),
    triggers: names(triggers, 'tgname'),
    functions: names(functions, 'proname'),
  };
}

describe('migrations', () => {
  test('up creates everything, down removes everything, up again works', async () => {
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    const orm = await createOrm({ url: targetUrl.toString(), poolMax: 2 });
    const sql = new SQL(targetUrl.toString());
    try {
      const applied = await orm.migrator.up();
      expect(applied.map((m) => m.name)).toEqual([
        'Migration20261029000001CoreTables',
        'Migration20261029000002IntegrityTriggers',
        'Migration20261029000003Messaging',
      ]);

      const afterUp = await inventory(sql);
      expect(afterUp.tables).toEqual(
        expect.arrayContaining([
          'wallets',
          'wager_transactions',
          'wallet_ledger_entries',
          'inbox_messages',
          'outbox_messages',
          'mikro_orm_migrations',
        ]),
      );
      expect(afterUp.indexes).toEqual(
        expect.arrayContaining([
          'wallets_player_currency_uk',
          'wager_tx_idempotency_key_uk',
          'wager_tx_provider_external_uk',
          'wager_tx_single_reversal_uk',
          'wager_tx_pending_reference_due_ix',
          'ledger_wallet_version_uk',
          'ledger_wallet_transaction_uk',
          'inbox_messages_pk',
          'outbox_due_ix',
        ]),
      );
      expect(afterUp.triggers).toEqual(
        expect.arrayContaining([
          'ledger_forbid_update_delete',
          'ledger_forbid_truncate',
          'ledger_enforce_chain',
          'wallets_guard_update',
          'wallets_forbid_delete',
          'wallets_ledger_backed',
          'wager_tx_guard',
        ]),
      );

      // Down one by one until nothing is left.
      for (let i = 0; i < 3; i++) await orm.migrator.down();
      const afterDown = await inventory(sql);
      expect(afterDown.tables).toEqual(['mikro_orm_migrations']);
      expect(afterDown.triggers).toEqual([]);
      expect(afterDown.functions).toEqual([]);
      expect(await orm.migrator.getExecuted()).toEqual([]);

      const reapplied = await orm.migrator.up();
      expect(reapplied).toHaveLength(3);
      expect((await inventory(sql)).tables).toEqual(afterUp.tables);
    } finally {
      await sql.close();
      await orm.close(true);
    }
  });
});
