import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { QueueRegistry } from '../messaging/queue-registry';

export interface CheckResult {
  status: 'up' | 'down';
  latencyMs: number;
  error?: string;
}

export interface ReadinessReport {
  ready: boolean;
  checks: { database: CheckResult; sqs: CheckResult };
}

async function timed(fn: () => Promise<unknown>, timeoutMs: number): Promise<CheckResult> {
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    return { status: 'up', latencyMs: Math.round(performance.now() - started) };
  } catch (err) {
    return {
      status: 'down',
      latencyMs: Math.round(performance.now() - started),
      error: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Readiness = PostgreSQL answers `SELECT 1` (1 s) and the wager queue is reachable (2 s). */
export class HealthChecker {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
    private readonly queues: QueueRegistry,
    private readonly wagerQueueName: string,
  ) {}

  async readiness(): Promise<ReadinessReport> {
    const [database, sqs] = await Promise.all([
      timed(() => this.orm.em.fork().execute('select 1', [], 'all'), 1000),
      timed(async () => {
        const url = await this.queues.url(this.wagerQueueName);
        await this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] }));
      }, 2000),
    ]);
    return { ready: database.status === 'up' && sqs.status === 'up', checks: { database, sqs } };
  }
}
