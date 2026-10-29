import { uuidv7 } from 'uuidv7';
import type { IdGenerator } from '../../application/ports/system';

/** Time-ordered UUIDs: index-friendly primary keys and naturally sortable event ids. */
export class UuidV7IdGenerator implements IdGenerator {
  next(): string {
    return uuidv7();
  }
}
