import { EntitySchema } from '@mikro-orm/core';

export interface InboxMessageRecord {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  transactionId: string | null;
  receivedAt: Date;
  processedAt: Date | null;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  name: 'InboxMessageRecord',
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'text', primary: true },
    messageId: { type: 'text', primary: true },
    payloadHash: { type: 'string', columnType: 'char(64)' },
    transactionId: { type: 'uuid', nullable: true },
    receivedAt: { type: 'datetime', columnType: 'timestamptz' },
    processedAt: { type: 'datetime', columnType: 'timestamptz', nullable: true },
  },
});
