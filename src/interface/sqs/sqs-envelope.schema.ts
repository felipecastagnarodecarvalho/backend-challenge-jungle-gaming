import { z } from 'zod';
import { sqsWagerDataSchema } from '../shared/wager-request.schema';

/** `WagerTransactionRequested` envelope on wager-transactions.fifo. */
export const sqsEnvelopeSchema = z.object({
  messageId: z.string().min(1).max(200),
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.iso.datetime({ offset: true }),
  data: sqsWagerDataSchema,
});

export type SqsEnvelope = z.infer<typeof sqsEnvelopeSchema>;

export class InvalidMessageError extends Error {
  readonly code = 'INVALID_PAYLOAD';
}

/** Parses the raw body. Any failure is a poison message (it will never become valid by retrying). */
export function parseEnvelope(body: string | undefined): SqsEnvelope {
  if (!body) throw new InvalidMessageError('empty message body');
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new InvalidMessageError('body is not valid JSON');
  }
  const parsed = sqsEnvelopeSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new InvalidMessageError(
      `invalid envelope: ${first ? `${first.path.join('.')}: ${first.message}` : 'unknown'}`,
    );
  }
  return parsed.data;
}
