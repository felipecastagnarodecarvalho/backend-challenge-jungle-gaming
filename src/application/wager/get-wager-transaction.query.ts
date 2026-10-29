import { NotFoundError } from '../errors';
import type { WagerTransactionReadModel, WagerTransactionView } from '../ports/read-models';

export class GetWagerTransactionQuery {
  constructor(private readonly readModel: WagerTransactionReadModel) {}

  async byId(transactionId: string): Promise<WagerTransactionView> {
    const view = await this.readModel.getById(transactionId);
    if (!view) throw new NotFoundError('TRANSACTION_NOT_FOUND', 'Transaction not found');
    return view;
  }

  async byProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransactionView> {
    const view = await this.readModel.getByProviderExternalId(providerId, externalTransactionId);
    if (!view) throw new NotFoundError('TRANSACTION_NOT_FOUND', 'Transaction not found');
    return view;
  }
}
