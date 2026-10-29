/**
 * Drops and recreates the test database (`wagering_test` by default) and applies all migrations.
 * The ledger is append-only (TRUNCATE is forbidden by trigger), so a full reset means a new database.
 */
import { SQL } from 'bun';
import { createOrm } from '../src/infrastructure/persistence/orm';

export async function resetDatabase(url: string): Promise<void> {
  const target = new URL(url);
  const dbName = target.pathname.replace(/^\//, '');
  if (!/^[a-z0-9_]+$/.test(dbName)) throw new Error(`refusing to reset suspicious database name "${dbName}"`);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const sql = new SQL(admin.toString());
  try {
    await sql.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await sql.unsafe(`CREATE DATABASE ${dbName}`);
  } finally {
    await sql.close();
  }
  const orm = await createOrm({ url, poolMax: 2 });
  try {
    await orm.migrator.up();
  } finally {
    await orm.close(true);
  }
}

if (import.meta.main) {
  const url = process.env.TEST_DATABASE_URL ?? 'postgresql://wagering:wagering@localhost:5432/wagering_test';
  await resetDatabase(url);
  console.log(`reset ${new URL(url).pathname.slice(1)} and applied migrations`);
}
