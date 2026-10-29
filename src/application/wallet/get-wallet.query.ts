import { NotFoundError } from '../errors';
import type { WalletReadModel, WalletView } from '../ports/read-models';

export class GetWalletQuery {
  constructor(private readonly readModel: WalletReadModel) {}

  async execute(walletId: string): Promise<WalletView> {
    const view = await this.readModel.getById(walletId);
    if (!view) throw new NotFoundError('WALLET_NOT_FOUND', 'Wallet not found');
    return view;
  }
}
