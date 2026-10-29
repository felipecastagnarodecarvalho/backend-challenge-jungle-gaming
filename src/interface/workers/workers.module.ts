import { Module } from '@nestjs/common';
import { OutboxPublisherWorker } from './outbox-publisher.worker';
import { PendingReferenceWorker } from './pending-reference.worker';

@Module({ providers: [OutboxPublisherWorker, PendingReferenceWorker] })
export class WorkersModule {}
