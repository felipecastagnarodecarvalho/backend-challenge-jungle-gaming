import type { MoneyProps } from '../../domain/money/money';
import type { SubmittableKind } from '../../domain/wager/wager-transaction-kind';

/** Where a command came from. SQS commands carry what the inbox needs for deduplication. */
export type CommandSource =
  | { type: 'HTTP'; requestId: string }
  | { type: 'SQS'; consumerName: string; messageId: string; messageHash: string };

/** Business fields shared by the HTTP body and the SQS `data` (validated by the same schema). */
export interface WagerRequestData {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: SubmittableKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface ProcessWagerCommand extends WagerRequestData {
  idempotencyKey: string;
  correlationId: string;
  source: CommandSource;
}
