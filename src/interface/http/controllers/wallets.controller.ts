import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { CreateWalletUseCase } from '../../../application/wallet/create-wallet.use-case';
import { GetWalletQuery } from '../../../application/wallet/get-wallet.query';
import { GetWalletLedgerQuery } from '../../../application/wallet/get-wallet-ledger.query';
import { ReconcileWalletUseCase } from '../../../application/wallet/reconcile-wallet.use-case';
import { moneySchema } from '../../shared/money.schema';
import { correlationIdOf } from '../correlation-id.middleware';
import { parseOrThrow, ZodValidationPipe } from '../zod-validation.pipe';

const createWalletSchema = z.object({ playerId: z.uuid(), initialBalance: moneySchema });
const ledgerQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

@Controller('wallets')
export class WalletsController {
  constructor(
    @Inject(CreateWalletUseCase) private readonly createWallet: CreateWalletUseCase,
    @Inject(GetWalletQuery) private readonly getWallet: GetWalletQuery,
    @Inject(GetWalletLedgerQuery) private readonly getLedger: GetWalletLedgerQuery,
    @Inject(ReconcileWalletUseCase) private readonly reconcile: ReconcileWalletUseCase,
  ) {}

  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createWalletSchema)) body: z.infer<typeof createWalletSchema>,
    @Req() req: Request,
  ) {
    return this.createWallet.execute({ ...body, correlationId: correlationIdOf(req) });
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string) {
    return this.getWallet.execute(parseOrThrow(z.uuid(), walletId, 'walletId'));
  }

  @Get(':walletId/ledger')
  ledger(@Param('walletId') walletId: string, @Query() query: Record<string, unknown>) {
    const id = parseOrThrow(z.uuid(), walletId, 'walletId');
    const q = parseOrThrow(ledgerQuerySchema, query, '');
    return this.getLedger.execute(id, q.cursor, q.limit);
  }

  /** Always 200 with the report — including when inconsistent (never silently corrected). */
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconciliation(@Param('walletId') walletId: string) {
    return this.reconcile.execute(parseOrThrow(z.uuid(), walletId, 'walletId'));
  }
}
