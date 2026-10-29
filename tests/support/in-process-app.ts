import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { loadConfig } from '../../src/bootstrap/config';
import { createApp } from '../../src/bootstrap/create-app';
import type { InfrastructureOverrides } from '../../src/infrastructure/infrastructure.module';
import { baseTestEnv } from './env';

export interface InProcessApp {
  app: INestApplication;
  url: string;
  close(): Promise<void>;
}

/**
 * Boots the real application (real Postgres + LocalStack) inside the test
 * process on a random port. `close()` runs the same shutdown hooks as SIGTERM.
 */
export async function startInProcessApp(
  env: Record<string, string> = {},
  overrides: InfrastructureOverrides = {},
): Promise<InProcessApp> {
  const config = loadConfig({ ...baseTestEnv(), INSTANCE_ID: `inproc-${Math.floor(Math.random() * 1e6)}` }, env);
  const app = await createApp(config, overrides);
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as AddressInfo;
  let closed = false;
  return {
    app,
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      if (closed) return;
      closed = true;
      await app.close();
    },
  };
}
