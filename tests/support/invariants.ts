import { expect } from 'bun:test';
import { db } from './db';

/**
 * The final invariant of every integration/concurrency test:
 *   wallet.balance == balance reconstructed from the ledger
 * plus: latest entry matches (balance, version), the chain has no breaks, and
 * every balance-moving PROCESSED transaction has exactly one ledger entry.
 * All checks are computed in SQL (exact NUMERIC arithmetic, no JS numbers).
 */
export async function assertWalletConsistent(walletId: string): Promise<void> {
  const [row] = await db()`
    SELECT
      w.balance::text                                                           AS balance,
      w.version                                                                 AS version,
      COALESCE((SELECT SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END)
                  FROM wallet_ledger_entries WHERE wallet_id = w.id), 0)::numeric(20,2)::text AS ledger_sum,
      (SELECT balance_after::text FROM wallet_ledger_entries WHERE wallet_id = w.id ORDER BY wallet_version DESC LIMIT 1) AS last_after,
      (SELECT wallet_version FROM wallet_ledger_entries WHERE wallet_id = w.id ORDER BY wallet_version DESC LIMIT 1)       AS last_version,
      (SELECT COUNT(*) FROM wallet_ledger_entries WHERE wallet_id = w.id)::int  AS entries,
      (SELECT COUNT(*) FROM (
          SELECT balance_before, LAG(balance_after, 1, 0::numeric) OVER (ORDER BY wallet_version) AS prev_after,
                 wallet_version, ROW_NUMBER() OVER (ORDER BY wallet_version) AS rn
            FROM wallet_ledger_entries WHERE wallet_id = w.id) t
        WHERE balance_before <> prev_after OR wallet_version <> rn)::int        AS chain_breaks,
      (SELECT COUNT(*) FROM wager_transactions
        WHERE wallet_id = w.id AND status = 'PROCESSED' AND kind <> 'LOSS')::int AS moving_txs
    FROM wallets w WHERE w.id = ${walletId}`;
  expect(row).toBeDefined();
  const r = row as Record<string, string | number | null>;
  expect({ walletId, balance: r.balance }).toEqual({ walletId, balance: r.ledger_sum as string });
  expect(r.chain_breaks).toBe(0);
  expect(r.entries).toBe(r.moving_txs);
  if (r.entries === 0) {
    expect(r.balance).toBe('0.00');
    expect(r.version).toBe(1);
  } else {
    expect(r.last_after).toBe(r.balance);
    expect(r.last_version).toBe(r.version);
  }
}

export async function assertWalletsConsistent(walletIds: string[]): Promise<void> {
  for (const id of walletIds) await assertWalletConsistent(id);
}

export async function walletBalance(walletId: string): Promise<string> {
  const [row] = await db()`SELECT balance::text AS balance FROM wallets WHERE id = ${walletId}`;
  return (row as { balance: string }).balance;
}

export async function ledgerEntries(
  walletId: string,
): Promise<Array<{ direction: string; amount: string; wallet_version: number }>> {
  return (await db()`SELECT direction, amount::text AS amount, wallet_version FROM wallet_ledger_entries
                     WHERE wallet_id = ${walletId} ORDER BY wallet_version`) as Array<{
    direction: string;
    amount: string;
    wallet_version: number;
  }>;
}
