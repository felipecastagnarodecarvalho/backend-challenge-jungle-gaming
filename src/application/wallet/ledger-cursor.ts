import { InvalidCursorError } from '../errors';

/**
 * Opaque, stable cursor: `base64url(JSON {v:1, after: walletVersion})`.
 * Stable because wallet_version is unique and monotonic per wallet and the
 * ledger is append-only — pages never shift when new entries arrive.
 */
export const LedgerCursor = {
  encode(afterWalletVersion: number): string {
    return Buffer.from(JSON.stringify({ v: 1, after: afterWalletVersion }), 'utf8').toString('base64url');
  },

  decode(cursor: string): number {
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('not base64url');
      const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as { v?: unknown }).v === 1 &&
        Number.isSafeInteger((parsed as { after?: unknown }).after) &&
        ((parsed as { after: number }).after as number) >= 0
      ) {
        return (parsed as { after: number }).after;
      }
    } catch {
      // fall through
    }
    throw new InvalidCursorError();
  },
};
