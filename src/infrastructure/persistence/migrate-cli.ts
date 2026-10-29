/**
 * Migration CLI: `up` | `down [--to <name>|--all]` | `status`.
 * Uses the same explicit migrationsList as the application.
 */
import { loadConfig } from '../../bootstrap/config';
import { createOrm } from './orm';

async function main(): Promise<void> {
  const [command = 'status', ...args] = process.argv.slice(2);
  const config = loadConfig();
  const orm = await createOrm({ url: config.db.url, poolMax: 2 });
  try {
    const migrator = orm.migrator;
    switch (command) {
      case 'up': {
        const ran = await migrator.up();
        console.log(ran.length ? `applied: ${ran.map((m) => m.name).join(', ')}` : 'up to date');
        break;
      }
      case 'down': {
        const toIndex = args.indexOf('--to');
        const options = args.includes('--all') ? { to: 0 } : toIndex >= 0 ? { to: args[toIndex + 1] } : undefined;
        const ran = await migrator.down(options);
        console.log(ran.length ? `reverted: ${ran.map((m) => m.name).join(', ')}` : 'nothing to revert');
        break;
      }
      case 'status': {
        const executed = await migrator.getExecuted();
        const pending = await migrator.getPending();
        console.log(
          JSON.stringify({ executed: executed.map((m) => m.name), pending: pending.map((m) => m.name) }, null, 2),
        );
        break;
      }
      default:
        throw new Error(`unknown command "${command}" (use up | down [--to name|--all] | status)`);
    }
  } finally {
    await orm.close(true);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
