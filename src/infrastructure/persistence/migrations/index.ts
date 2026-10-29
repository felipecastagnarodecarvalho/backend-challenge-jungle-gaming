import type { MigrationObject } from '@mikro-orm/core';
import { Migration20261029000001CoreTables } from './Migration20261029000001CoreTables';
import { Migration20261029000002IntegrityTriggers } from './Migration20261029000002IntegrityTriggers';
import { Migration20261029000003Messaging } from './Migration20261029000003Messaging';
import { Migration20261030000004ProviderScopedIdempotency } from './Migration20261030000004ProviderScopedIdempotency';
import { Migration20261030000005BalanceCeilingAndLedgerGuards } from './Migration20261030000005BalanceCeilingAndLedgerGuards';

/**
 * Explicit, ordered list (no file-system discovery: works the same in Docker and tests).
 * Applied migrations are never edited: fixes ship as new migrations with their own `down`.
 */
export const migrationsList: MigrationObject[] = [
  { name: 'Migration20261029000001CoreTables', class: Migration20261029000001CoreTables },
  { name: 'Migration20261029000002IntegrityTriggers', class: Migration20261029000002IntegrityTriggers },
  { name: 'Migration20261029000003Messaging', class: Migration20261029000003Messaging },
  { name: 'Migration20261030000004ProviderScopedIdempotency', class: Migration20261030000004ProviderScopedIdempotency },
  {
    name: 'Migration20261030000005BalanceCeilingAndLedgerGuards',
    class: Migration20261030000005BalanceCeilingAndLedgerGuards,
  },
];
