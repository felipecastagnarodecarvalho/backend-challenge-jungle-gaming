import { SQL } from 'bun';
import { TEST_DATABASE_URL } from './env';

/** Direct SQL access for assertions (Bun's native Postgres client, independent from the app's ORM). */
let shared: SQL | undefined;

export function db(): SQL {
  shared ??= new SQL({ url: TEST_DATABASE_URL, max: 5 });
  return shared;
}

export async function closeDb(): Promise<void> {
  if (shared) {
    await shared.close();
    shared = undefined;
  }
}

/** Runs `fn` and returns the SQLSTATE/message of the error it raised (or throws if it succeeded). */
export async function expectPgError(
  fn: () => Promise<unknown>,
): Promise<{ code: string; message: string; constraint?: string }> {
  try {
    await fn();
  } catch (err) {
    const e = err as { errno?: string; code?: string; message: string; constraint?: string };
    return { code: String(e.errno ?? e.code), message: e.message, constraint: e.constraint };
  }
  throw new Error('expected a Postgres error but the statement succeeded');
}
