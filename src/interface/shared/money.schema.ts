import { z } from 'zod';

/** Same rule as Money.from: decimal *string*, exactly 2 places, no sign/exponent/leading zeros. */
export const AMOUNT_REGEX = /^(0|[1-9][0-9]{0,14})\.[0-9]{2}$/;

export const moneySchema = z.object({
  amount: z.string({ error: 'amount must be a decimal string like "25.00"' }).regex(AMOUNT_REGEX, {
    error: 'amount must be a non-negative decimal string with exactly 2 decimal places',
  }),
  currency: z.string().regex(/^[A-Z]{3}$/, { error: 'currency must be a 3-letter uppercase ISO-4217 code' }),
});
