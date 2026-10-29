import 'reflect-metadata';
import { ConfigError, loadConfig } from './bootstrap/config';
import { createApp } from './bootstrap/create-app';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await createApp(config);
  // SIGTERM/SIGINT → graceful shutdown: readiness 503, consumer drains, workers stop, connections close.
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
  await app.listen(config.port);
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(err.message);
  } else {
    console.error(err);
  }
  process.exit(1);
});
