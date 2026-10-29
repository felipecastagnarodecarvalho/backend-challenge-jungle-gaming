import { Controller, Get, Inject, Param } from '@nestjs/common';
import type { ProviderIdentity } from '../../../application/ports/system';
import { GetWagerTransactionQuery } from '../../../application/wager/get-wager-transaction.query';
import { assertProviderAccess, CurrentProvider } from '../auth/current-provider.decorator';

@Controller('providers/:providerId/wagering/transactions')
export class ProviderTransactionsController {
  constructor(@Inject(GetWagerTransactionQuery) private readonly getTransaction: GetWagerTransactionQuery) {}

  @Get(':externalTransactionId')
  get(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
    @CurrentProvider() identity: ProviderIdentity,
  ) {
    assertProviderAccess(identity, providerId);
    return this.getTransaction.byProviderExternalId(providerId, externalTransactionId);
  }
}
