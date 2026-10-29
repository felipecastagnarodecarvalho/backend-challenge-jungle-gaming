import { afterAll, beforeAll } from 'bun:test';
import type { InfrastructureOverrides } from '../../src/infrastructure/infrastructure.module';
import { closeDb } from './db';
import { type InProcessApp, startInProcessApp } from './in-process-app';
import { createTestQueues, deleteTestQueues, type TestQueues } from './sqs';

export interface AppContext {
  app: InProcessApp;
  url: string;
  queues: TestQueues;
}

/**
 * Registers beforeAll/afterAll that create dedicated queues and boot one
 * in-process app instance for the test file. Returns a live context object.
 */
export function useApp(
  label: string,
  env: Record<string, string> = {},
  overrides: InfrastructureOverrides = {},
): AppContext {
  const ctx = {} as AppContext;
  beforeAll(async () => {
    ctx.queues = await createTestQueues(label);
    ctx.app = await startInProcessApp({ ...ctx.queues.env, ...env }, overrides);
    ctx.url = ctx.app.url;
  });
  afterAll(async () => {
    await ctx.app?.close();
    if (ctx.queues) await deleteTestQueues(ctx.queues);
    await closeDb();
  });
  return ctx;
}
