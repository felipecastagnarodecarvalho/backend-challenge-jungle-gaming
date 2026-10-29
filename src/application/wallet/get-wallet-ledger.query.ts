import { NotFoundError, ValidationError } from '../errors';
import type { LedgerEntryView, LedgerReadModel, WalletReadModel } from '../ports/read-models';
import { LedgerCursor } from './ledger-cursor';

export interface LedgerPage {
  items: LedgerEntryView[];
  nextCursor: string | null;
}

/** Keyset pagination over (wallet_id, wallet_version) — uses the unique index, O(limit) per page. */
export class GetWalletLedgerQuery {
  constructor(
    private readonly wallets: WalletReadModel,
    private readonly ledger: LedgerReadModel,
  ) {}

  async execute(walletId: string, cursor: string | undefined, limit = 50): Promise<LedgerPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new ValidationError([{ path: 'limit', message: 'limit must be an integer between 1 and 200' }]);
    }
    const afterVersion = cursor ? LedgerCursor.decode(cursor) : 0;
    if (!(await this.wallets.getById(walletId))) throw new NotFoundError('WALLET_NOT_FOUND', 'Wallet not found');
    const rows = await this.ledger.page(walletId, afterVersion, limit + 1);
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return { items, nextCursor: rows.length > limit && last ? LedgerCursor.encode(last.walletVersion) : null };
  }
}
