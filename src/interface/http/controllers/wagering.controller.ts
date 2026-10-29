import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { NotFoundError } from '../../../application/errors';
import type { ProviderIdentity } from '../../../application/ports/system';
import { GetWagerTransactionQuery } from '../../../application/wager/get-wager-transaction.query';
import { ProcessWagerTransactionUseCase } from '../../../application/wager/process-wager-transaction.use-case';
import { IDEMPOTENCY_KEY_REGEX, type WagerRequestBody, wagerRequestSchema } from '../../shared/wager-request.schema';
import { assertProviderAccess, CurrentProvider } from '../auth/current-provider.decorator';
import { correlationIdOf } from '../correlation-id.middleware';
import { HttpProblem } from '../http-error';
import { presentWagerResult } from '../presenters';
import { parseOrThrow, ZodValidationPipe } from '../zod-validation.pipe';

@Controller('wagering/transactions')
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransactionUseCase) private readonly processWager: ProcessWagerTransactionUseCase,
    @Inject(GetWagerTransactionQuery) private readonly getTransaction: GetWagerTransactionQuery,
  ) {}

  /**
   * Submits a provider operation. `Idempotency-Key` is mandatory and is the
   * source of truth for deduplication; the same use case serves the SQS consumer.
   */
  @Post()
  async submit(
    @Body(new ZodValidationPipe(wagerRequestSchema)) body: WagerRequestBody,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentProvider() identity: ProviderIdentity,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_REGEX.test(idempotencyKey)) {
      throw new HttpProblem(
        400,
        'IDEMPOTENCY_KEY_REQUIRED',
        'Idempotency-Key header is required (printable ASCII, 1..255 chars)',
      );
    }
    assertProviderAccess(identity, body.providerId);
    const correlationId = correlationIdOf(req);
    const result = await this.processWager.execute({
      ...body,
      idempotencyKey,
      correlationId,
      source: { type: 'HTTP', requestId: correlationId },
    });
    const outcome = presentWagerResult(result, correlationId);
    res.status(outcome.status);
    return outcome.body;
  }

  @Get(':transactionId')
  async get(@Param('transactionId') transactionId: string, @CurrentProvider() identity: ProviderIdentity) {
    const view = await this.getTransaction.byId(parseOrThrow(z.uuid(), transactionId, 'transactionId'));
    // Do not reveal other providers' transactions: answer as if it did not exist.
    if (identity.kind === 'provider' && identity.providerId !== view.providerId) {
      throw new NotFoundError('TRANSACTION_NOT_FOUND', 'Transaction not found');
    }
    return view;
  }
}
