import { type BeforeApplicationShutdown, Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { PublishOutboxBatchUseCase } from '../../application/outbox/publish-outbox-batch.use-case';
import type { LoggerPort } from '../../application/ports/system';
import type { AppConfig } from '../../bootstrap/config';
import { APP_CONFIG, LOGGER } from '../../bootstrap/tokens';
import { PollingWorker } from './polling-worker';

/** Runs the outbox publisher on every instance; SKIP LOCKED claims make concurrent publishers safe. */
@Injectable()
export class OutboxPublisherWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly worker: PollingWorker;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PublishOutboxBatchUseCase) useCase: PublishOutboxBatchUseCase,
    @Inject(LOGGER) logger: LoggerPort,
  ) {
    this.worker = new PollingWorker({
      name: 'outbox-publisher',
      intervalMs: config.outbox.pollIntervalMs,
      fullBatch: config.outbox.batchSize,
      tick: () => useCase.runOnce(),
      logger,
    });
  }

  onApplicationBootstrap(): void {
    if (this.config.outbox.enabled) this.worker.start();
  }

  beforeApplicationShutdown(): Promise<void> {
    return this.worker.stop();
  }
}
