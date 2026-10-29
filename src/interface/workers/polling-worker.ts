import type { LoggerPort } from '../../application/ports/system';

export interface PollingWorkerOptions {
  name: string;
  intervalMs: number;
  /** When a tick processes this many items, run again immediately (backlog). */
  fullBatch: number;
  tick: () => Promise<number>;
  logger: LoggerPort;
}

/**
 * Generic poll loop with cooperative stop: `stop()` interrupts the idle wait
 * and resolves once the current tick has finished (never mid-transaction).
 */
export class PollingWorker {
  private stopping = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(private readonly opts: PollingWorkerOptions) {}

  start(): void {
    if (this.loop) return;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    let errorDelay = this.opts.intervalMs;
    while (!this.stopping) {
      let processed = 0;
      try {
        processed = await this.opts.tick();
        errorDelay = this.opts.intervalMs;
      } catch (err) {
        this.opts.logger.warn(
          { worker: this.opts.name, err: err instanceof Error ? err.message : String(err) },
          'worker tick failed',
        );
        errorDelay = Math.min(errorDelay * 2, 30_000);
        await this.idle(errorDelay);
        continue;
      }
      if (processed < this.opts.fullBatch) await this.idle(this.opts.intervalMs);
    }
  }

  private idle(ms: number): Promise<void> {
    if (this.stopping) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    });
  }
}
