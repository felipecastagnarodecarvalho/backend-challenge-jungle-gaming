import type { FaultInjector } from '../../application/ports/system';

export interface FaultConfig {
  enabled: boolean;
  crashAfterCommitMessageIds: readonly string[];
  crashAfterOutboxClaim: boolean;
  transientMessageIds: readonly string[];
  delayInTxMs: number;
}

/**
 * Deterministic fault injection for crash/recovery tests, driven by env vars
 * (refused in production by config validation). `process.exit(137)` mimics a
 * SIGKILL: no shutdown hooks, no ack, no cleanup.
 */
export class EnvFaultInjector implements FaultInjector {
  constructor(
    private readonly config: FaultConfig,
    private readonly exit: (code: number) => never = (code) => process.exit(code),
  ) {}

  afterCommit(_point: 'sqs-before-ack', key: string): void {
    if (this.config.enabled && this.config.crashAfterCommitMessageIds.includes(key)) {
      process.stderr.write(`[fault] crashing after commit, before ack (message ${key})\n`);
      this.exit(137);
    }
  }

  afterOutboxClaim(): void {
    if (this.config.enabled && this.config.crashAfterOutboxClaim) {
      process.stderr.write('[fault] crashing after outbox claim, before publish\n');
      this.exit(137);
    }
  }

  async delayInTransaction(): Promise<void> {
    if (this.config.enabled && this.config.delayInTxMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.config.delayInTxMs));
    }
  }

  transientFailure(key: string): boolean {
    return this.config.enabled && this.config.transientMessageIds.includes(key);
  }
}
