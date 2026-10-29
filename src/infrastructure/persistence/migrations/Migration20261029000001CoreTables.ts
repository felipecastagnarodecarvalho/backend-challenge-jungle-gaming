import { Migration } from '@mikro-orm/migrations';

/**
 * Core financial tables. Uniqueness, non-negativity, arithmetic and
 * referential guarantees live here (challenge §5.9), not only in code:
 * - composite FKs force ledger currency = wallet currency and ledger wallet = tx wallet;
 * - UNIQUE(wallet_id, wallet_version) makes two entries for one version impossible (no lost update);
 * - the partial unique index enforces "a reference is reversed at most once".
 */
export class Migration20261029000001CoreTables extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
CREATE TABLE wallets (
  id          uuid          PRIMARY KEY,
  player_id   uuid          NOT NULL,
  currency    char(3)       NOT NULL,
  balance     numeric(20,2) NOT NULL,
  version     integer       NOT NULL,
  created_at  timestamptz   NOT NULL,
  updated_at  timestamptz   NOT NULL,
  CONSTRAINT wallets_currency_format_ck CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT wallets_balance_non_negative_ck CHECK (balance >= 0),
  CONSTRAINT wallets_version_positive_ck CHECK (version >= 1),
  CONSTRAINT wallets_player_currency_uk UNIQUE (player_id, currency),
  CONSTRAINT wallets_id_currency_uk UNIQUE (id, currency)
)`);

    this.addSql(`
CREATE TABLE wager_transactions (
  id                                 uuid          PRIMARY KEY,
  provider_id                        text          NOT NULL,
  external_transaction_id            text          NOT NULL,
  idempotency_key                    text          NOT NULL,
  payload_hash                       char(64)      NOT NULL,
  wallet_id                          uuid          NOT NULL REFERENCES wallets(id),
  player_id                          uuid          NOT NULL,
  round_id                           text          NOT NULL,
  game_id                            text          NOT NULL,
  kind                               text          NOT NULL,
  amount                             numeric(20,2) NOT NULL,
  currency                           char(3)       NOT NULL,
  reference_external_transaction_id  text          NULL,
  reference_transaction_id           uuid          NULL REFERENCES wager_transactions(id),
  status                             text          NOT NULL,
  failure_code                       text          NULL,
  result_balance_amount              numeric(20,2) NULL,
  result_wallet_version              integer       NULL,
  reference_attempts                 integer       NOT NULL DEFAULT 0,
  next_reference_check_at            timestamptz   NULL,
  source                             text          NOT NULL,
  correlation_id                     text          NULL,
  created_at                         timestamptz   NOT NULL,
  updated_at                         timestamptz   NOT NULL,
  processed_at                       timestamptz   NULL,
  CONSTRAINT wager_tx_kind_ck   CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
  CONSTRAINT wager_tx_status_ck CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
  CONSTRAINT wager_tx_source_ck CHECK (source IN ('HTTP','SQS','INTERNAL')),
  CONSTRAINT wager_tx_currency_format_ck CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT wager_tx_amount_ck CHECK (amount >= 0 AND (kind = 'LOSS' OR amount > 0)),
  CONSTRAINT wager_tx_payload_hash_ck CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT wager_tx_reference_required_ck CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
  CONSTRAINT wager_tx_reference_forbidden_ck CHECK (kind NOT IN ('BET','OPENING') OR reference_external_transaction_id IS NULL),
  CONSTRAINT wager_tx_not_self_reference_ck CHECK (reference_transaction_id IS NULL OR reference_transaction_id <> id),
  CONSTRAINT wager_tx_failure_code_ck CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
  CONSTRAINT wager_tx_processed_at_ck CHECK ((status = 'PROCESSED') = (processed_at IS NOT NULL)),
  CONSTRAINT wager_tx_processed_reversal_ref_ck CHECK (status <> 'PROCESSED' OR kind NOT IN ('REFUND','ROLLBACK') OR reference_transaction_id IS NOT NULL),
  CONSTRAINT wager_tx_pending_ref_ck CHECK ((status = 'PENDING_REFERENCE') = (next_reference_check_at IS NOT NULL)),
  CONSTRAINT wager_tx_reference_attempts_ck CHECK (reference_attempts >= 0),
  CONSTRAINT wager_tx_result_version_ck CHECK (result_wallet_version IS NULL OR result_wallet_version >= 1),
  CONSTRAINT wager_tx_opening_internal_ck CHECK ((kind = 'OPENING') = (source = 'INTERNAL')),
  CONSTRAINT wager_tx_idempotency_key_uk UNIQUE (idempotency_key),
  CONSTRAINT wager_tx_provider_external_uk UNIQUE (provider_id, external_transaction_id),
  CONSTRAINT wager_tx_id_wallet_uk UNIQUE (id, wallet_id)
)`);

    // Rule 4 (strict interpretation): a reference has at most ONE processed reversal (REFUND or ROLLBACK).
    this.addSql(`CREATE UNIQUE INDEX wager_tx_single_reversal_uk ON wager_transactions (reference_transaction_id)
  WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')`);
    this.addSql(`CREATE INDEX wager_tx_pending_reference_due_ix ON wager_transactions (next_reference_check_at)
  WHERE status = 'PENDING_REFERENCE'`);
    this.addSql(`CREATE INDEX wager_tx_awaiting_reference_ix ON wager_transactions (provider_id, reference_external_transaction_id)
  WHERE status = 'PENDING_REFERENCE'`);
    this.addSql(
      'CREATE INDEX wager_tx_reference_ix ON wager_transactions (reference_transaction_id) WHERE reference_transaction_id IS NOT NULL',
    );
    this.addSql('CREATE INDEX wager_tx_wallet_created_ix ON wager_transactions (wallet_id, created_at)');

    this.addSql(`
CREATE TABLE wallet_ledger_entries (
  id              uuid          PRIMARY KEY,
  wallet_id       uuid          NOT NULL,
  transaction_id  uuid          NOT NULL,
  direction       text          NOT NULL,
  amount          numeric(20,2) NOT NULL,
  currency        char(3)       NOT NULL,
  balance_before  numeric(20,2) NOT NULL,
  balance_after   numeric(20,2) NOT NULL,
  wallet_version  integer       NOT NULL,
  created_at      timestamptz   NOT NULL,
  CONSTRAINT ledger_wallet_currency_fk FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency),
  CONSTRAINT ledger_transaction_wallet_fk FOREIGN KEY (transaction_id, wallet_id) REFERENCES wager_transactions (id, wallet_id),
  CONSTRAINT ledger_direction_ck CHECK (direction IN ('DEBIT','CREDIT')),
  CONSTRAINT ledger_amount_positive_ck CHECK (amount > 0),
  CONSTRAINT ledger_balances_non_negative_ck CHECK (balance_before >= 0 AND balance_after >= 0),
  CONSTRAINT ledger_arithmetic_ck CHECK (
    (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
    (direction = 'DEBIT'  AND balance_after = balance_before - amount)),
  CONSTRAINT ledger_wallet_version_ck CHECK (wallet_version >= 1),
  CONSTRAINT ledger_wallet_transaction_uk UNIQUE (wallet_id, transaction_id),
  CONSTRAINT ledger_wallet_version_uk UNIQUE (wallet_id, wallet_version)
)`);
    this.addSql('CREATE INDEX ledger_transaction_ix ON wallet_ledger_entries (transaction_id)');
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE IF EXISTS wallet_ledger_entries');
    this.addSql('DROP TABLE IF EXISTS wager_transactions');
    this.addSql('DROP TABLE IF EXISTS wallets');
  }
}
