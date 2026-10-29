import { Migration } from '@mikro-orm/migrations';

/**
 * Inbox (dedup of consumed messages by (consumer, messageId)) and transactional
 * outbox (events committed with the financial change; partial indexes keep
 * polling cheap as published rows accumulate).
 */
export class Migration20261029000003Messaging extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
CREATE TABLE inbox_messages (
  consumer_name  text        NOT NULL,
  message_id     text        NOT NULL,
  payload_hash   char(64)    NOT NULL,
  transaction_id uuid        NULL,
  received_at    timestamptz NOT NULL,
  processed_at   timestamptz NULL,
  CONSTRAINT inbox_messages_pk PRIMARY KEY (consumer_name, message_id),
  CONSTRAINT inbox_payload_hash_ck CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT inbox_processed_after_received_ck CHECK (processed_at IS NULL OR processed_at >= received_at)
)`);
    this.addSql(`
CREATE TABLE outbox_messages (
  id               uuid        PRIMARY KEY,
  aggregate_type   text        NOT NULL,
  aggregate_id     text        NOT NULL,
  partition_key    text        NOT NULL,
  event_type       text        NOT NULL,
  event_version    integer     NOT NULL,
  payload          jsonb       NOT NULL,
  correlation_id   text        NOT NULL,
  causation_id     text        NULL,
  occurred_at      timestamptz NOT NULL,
  attempts         integer     NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL,
  published_at     timestamptz NULL,
  last_error       text        NULL,
  CONSTRAINT outbox_attempts_ck CHECK (attempts >= 0),
  CONSTRAINT outbox_event_version_ck CHECK (event_version >= 1),
  CONSTRAINT outbox_payload_object_ck CHECK (jsonb_typeof(payload) = 'object')
)`);
    this.addSql(
      'CREATE INDEX outbox_due_ix ON outbox_messages (next_attempt_at, occurred_at) WHERE published_at IS NULL',
    );
    this.addSql('CREATE INDEX outbox_pending_occurred_ix ON outbox_messages (occurred_at) WHERE published_at IS NULL');
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE IF EXISTS outbox_messages');
    this.addSql('DROP TABLE IF EXISTS inbox_messages');
  }
}
