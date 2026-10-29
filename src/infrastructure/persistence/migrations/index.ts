import type { MigrationObject } from '@mikro-orm/core';
import { Migration20261029000001CoreTables } from './Migration20261029000001CoreTables';
import { Migration20261029000002IntegrityTriggers } from './Migration20261029000002IntegrityTriggers';
import { Migration20261029000003Messaging } from './Migration20261029000003Messaging';

/** Explicit, ordered list (no file-system discovery: works the same in Docker and tests). */
export const migrationsList: MigrationObject[] = [
  { name: 'Migration20261029000001CoreTables', class: Migration20261029000001CoreTables },
  { name: 'Migration20261029000002IntegrityTriggers', class: Migration20261029000002IntegrityTriggers },
  { name: 'Migration20261029000003Messaging', class: Migration20261029000003Messaging },
];
