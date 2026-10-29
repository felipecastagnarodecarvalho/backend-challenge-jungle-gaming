import { afterAll, beforeAll } from 'bun:test';
import { type AppProcess, startCluster } from './app-process';
import { closeDb } from './db';
import { createTestQueues, deleteTestQueues, type TestQueues } from './sqs';

export interface ClusterContext {
  apps: AppProcess[];
  queues: TestQueues;
  /** Round-robin base URL picker over the live instances. */
  next(): string;
}

/**
 * Registers beforeAll/afterAll that boot `n` real application processes
 * (≥3 for the multi-instance scenarios) sharing the test database and a
 * dedicated set of queues.
 */
export function useCluster(label: string, n = 3, env: Record<string, string> = {}): ClusterContext {
  let rr = 0;
  const ctx: ClusterContext = {
    apps: [],
    queues: undefined as unknown as TestQueues,
    next() {
      const app = ctx.apps[rr++ % ctx.apps.length];
      if (!app) throw new Error('cluster not started');
      return app.url;
    },
  };
  beforeAll(async () => {
    ctx.queues = await createTestQueues(label);
    ctx.apps = await startCluster(n, { ...ctx.queues.env, ...env }, label);
  }, 90_000);
  afterAll(async () => {
    await Promise.all(ctx.apps.map((a) => a.kill()));
    if (ctx.queues) await deleteTestQueues(ctx.queues);
    await closeDb();
  }, 30_000);
  return ctx;
}

/** Retries a request on network errors (instance killed mid-flight) against the next instance, same idempotency key. */
export async function withFailover<T>(
  attempt: (baseUrl: string) => Promise<T>,
  pick: () => string,
  tries = 20,
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await attempt(pick());
    } catch (err) {
      lastError = err;
      await Bun.sleep(100);
    }
  }
  throw lastError;
}
