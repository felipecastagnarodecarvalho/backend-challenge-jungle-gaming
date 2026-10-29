import { z } from 'zod';

/**
 * UUID accepted in any case but normalised to lowercase at the edge — before
 * hashing and before any comparison with values read from Postgres (which
 * always renders uuid lowercase). Otherwise the same id in another case would
 * produce false WALLET_PLAYER_MISMATCH / REFERENCE_MISMATCH / idempotency conflicts.
 */
export const uuidSchema = z.uuid().transform((v) => v.toLowerCase());
