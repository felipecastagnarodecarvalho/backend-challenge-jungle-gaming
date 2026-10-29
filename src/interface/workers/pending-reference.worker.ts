import { type BeforeApplicationShutdown, Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { LoggerPort } from '../../application/ports/system';
import { ResolvePendingReferencesUseCase } from '../../application/wager/resolve-pending-references.use-case';
import type { AppConfig } from '../../bootstrap/config';
import { APP_CONFIG, LOGGER } from '../../bootstrap/tokens';
import { PollingWorker } from './polling-worker';

/** Scheduled re-check of PENDING_REFERENCE transactions (exponential backoff, bounded attempts). */
@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly worker: PollingWorker;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ResolvePendingReferencesUseCase) useCase: ResolvePendingReferencesUseCase,
    @Inject(LOGGER) logger: LoggerPort,
  ) {
    this.worker = new PollingWorker({
      name: 'pending-reference',
      intervalMs: config.pendingRef.pollIntervalMs,
      fullBatch: config.pendingRef.batchSize,
      tick: () => useCase.runOnce(),
      logger,
    });
  }

  onApplicationBootstrap(): void {
    if (this.config.pendingRef.enabled) this.worker.start();
  }

  beforeApplicationShutdown(): Promise<void> {
    return this.worker.stop();
  }
}
