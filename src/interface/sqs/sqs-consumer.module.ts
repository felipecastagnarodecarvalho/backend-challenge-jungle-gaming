import { Module } from '@nestjs/common';
import { WagerTransactionsConsumer } from './wager-transactions.consumer';

@Module({ providers: [WagerTransactionsConsumer] })
export class SqsConsumerModule {}
