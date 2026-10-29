import { EntitySchema } from '@mikro-orm/core';

export interface WagerTransactionRecord {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: string;
  failureCode: string | null;
  resultBalanceAmount: string | null;
  resultWalletVersion: number | null;
  referenceAttempts: number;
  nextReferenceCheckAt: Date | null;
  source: string;
  correlationId: string | null;
  createdAt: Date;
  updatedAt: Date;
  processedAt: Date | null;
}

const tz = { type: 'datetime', columnType: 'timestamptz' } as const;
const money = { type: 'decimal', precision: 20, scale: 2 } as const;

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  name: 'WagerTransactionRecord',
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'text' },
    externalTransactionId: { type: 'text' },
    idempotencyKey: { type: 'text' },
    payloadHash: { type: 'string', columnType: 'char(64)' },
    walletId: { type: 'uuid' },
    playerId: { type: 'uuid' },
    roundId: { type: 'text' },
    gameId: { type: 'text' },
    kind: { type: 'text' },
    amount: { ...money },
    currency: { type: 'string', columnType: 'char(3)' },
    referenceExternalTransactionId: { type: 'text', nullable: true },
    referenceTransactionId: { type: 'uuid', nullable: true },
    status: { type: 'text' },
    failureCode: { type: 'text', nullable: true },
    resultBalanceAmount: { ...money, nullable: true },
    resultWalletVersion: { type: 'integer', nullable: true },
    referenceAttempts: { type: 'integer' },
    nextReferenceCheckAt: { ...tz, nullable: true },
    source: { type: 'text' },
    correlationId: { type: 'text', nullable: true },
    createdAt: { ...tz },
    updatedAt: { ...tz },
    processedAt: { ...tz, nullable: true },
  },
});
