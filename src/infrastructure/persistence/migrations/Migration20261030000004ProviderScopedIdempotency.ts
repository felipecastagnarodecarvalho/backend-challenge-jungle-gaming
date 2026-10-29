import { Migration } from '@mikro-orm/migrations';

/**
 * Idempotency keys are scoped per provider: UNIQUE(provider_id, idempotency_key)
 * replaces the global UNIQUE(idempotency_key). With a global key, provider B
 * could "squat" a key provider A will use (the recommended default is
 * "{providerId}:{externalTransactionId}") or learn A's transaction ids from
 * the conflict response. Lookups are filtered by provider accordingly.
 *
 * Down restores the global constraint; it fails (on purpose) if two providers
 * already share a key, since that state is not representable in the old schema.
 */
export class Migration20261030000004ProviderScopedIdempotency extends Migration {
  override async up(): Promise<void> {
    this.addSql('ALTER TABLE wager_transactions DROP CONSTRAINT wager_tx_idempotency_key_uk');
    this.addSql(
      'ALTER TABLE wager_transactions ADD CONSTRAINT wager_tx_provider_idempotency_key_uk UNIQUE (provider_id, idempotency_key)',
    );
  }

  override async down(): Promise<void> {
    this.addSql('ALTER TABLE wager_transactions DROP CONSTRAINT IF EXISTS wager_tx_provider_idempotency_key_uk');
    this.addSql('ALTER TABLE wager_transactions ADD CONSTRAINT wager_tx_idempotency_key_uk UNIQUE (idempotency_key)');
  }
}
