export const WagerTransactionKind = {
  /** Internal: opening credit of a wallet. Never accepted from HTTP or SQS. */
  Opening: 'OPENING',
  Bet: 'BET',
  Win: 'WIN',
  Loss: 'LOSS',
  Refund: 'REFUND',
  Rollback: 'ROLLBACK',
} as const;
export type WagerTransactionKind = (typeof WagerTransactionKind)[keyof typeof WagerTransactionKind];

/** Kinds a provider may submit (OPENING is internal). */
export const SUBMITTABLE_KINDS = ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;
export type SubmittableKind = (typeof SUBMITTABLE_KINDS)[number];

export function isSubmittableKind(value: string): value is SubmittableKind {
  return (SUBMITTABLE_KINDS as readonly string[]).includes(value);
}
