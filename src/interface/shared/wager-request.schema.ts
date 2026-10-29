import { z } from 'zod';
import { INTERNAL_PROVIDER_ID } from '../../domain/wager/wager-transaction';
import { SUBMITTABLE_KINDS } from '../../domain/wager/wager-transaction-kind';
import { moneySchema } from './money.schema';

/** Printable ASCII without spaces. */
const ASCII_ID = /^[\x21-\x7E]+$/;
const asciiId = (max: number) =>
  z.string().min(1).max(max).regex(ASCII_ID, { error: 'must be printable ASCII without spaces' });

export const IDEMPOTENCY_KEY_REGEX = /^[\x21-\x7E]{1,255}$/;
export const idempotencyKeySchema = z.string().regex(IDEMPOTENCY_KEY_REGEX);

const wagerShape = {
  providerId: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,64}$/, { error: 'providerId must match ^[A-Za-z0-9._-]{1,64}$' })
    .refine((v) => v !== INTERNAL_PROVIDER_ID, { error: `providerId "${INTERNAL_PROVIDER_ID}" is reserved` }),
  externalTransactionId: asciiId(128),
  playerId: z.uuid(),
  walletId: z.uuid(),
  roundId: asciiId(128),
  gameId: asciiId(128),
  kind: z.enum(SUBMITTABLE_KINDS, { error: `kind must be one of ${SUBMITTABLE_KINDS.join(', ')}` }),
  money: moneySchema,
  referenceExternalTransactionId: asciiId(128).optional(),
};

type WagerShape = z.infer<z.ZodObject<typeof wagerShape>>;

/** Cross-field rules shared by HTTP and SQS (mirrors WagerTransaction.create). */
function crossRules(v: WagerShape, ctx: z.RefinementCtx): void {
  const ref = v.referenceExternalTransactionId;
  if ((v.kind === 'REFUND' || v.kind === 'ROLLBACK') && !ref) {
    ctx.addIssue({
      code: 'custom',
      path: ['referenceExternalTransactionId'],
      message: `${v.kind} requires referenceExternalTransactionId`,
    });
  }
  if (v.kind === 'BET' && ref !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['referenceExternalTransactionId'],
      message: 'BET must not reference another transaction',
    });
  }
  if (ref !== undefined && ref === v.externalTransactionId) {
    ctx.addIssue({
      code: 'custom',
      path: ['referenceExternalTransactionId'],
      message: 'a transaction cannot reference itself',
    });
  }
  if (v.kind !== 'LOSS' && v.money.amount === '0.00') {
    ctx.addIssue({ code: 'custom', path: ['money', 'amount'], message: `${v.kind} amount must be greater than zero` });
  }
}

/** Business body of POST /wagering/transactions (unknown keys are stripped and never hashed). */
export const wagerRequestSchema = z.object(wagerShape).superRefine(crossRules);
export type WagerRequestBody = z.infer<typeof wagerRequestSchema>;

/** `data` of the SQS envelope: same business fields + the idempotency key (the header's equivalent). */
export const sqsWagerDataSchema = z
  .object({ ...wagerShape, idempotencyKey: idempotencyKeySchema })
  .superRefine(crossRules);
