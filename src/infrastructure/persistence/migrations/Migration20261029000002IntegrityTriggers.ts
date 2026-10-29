import { Migration } from '@mikro-orm/migrations';

/**
 * Integrity triggers — the last line of defence if application code ever
 * misbehaves. All raise SQLSTATE 23000 (integrity_constraint_violation).
 * - ledger is append-only (no UPDATE/DELETE/TRUNCATE) and chained by version;
 * - wallet immutable columns, `version` moves only with `balance` and by +1;
 * - DEFERRED constraint trigger: at COMMIT, every wallet balance must equal
 *   the `balance_after` of its latest ledger entry (balance ⇔ ledger);
 * - terminal wager transactions are frozen; legal transitions only.
 */
export class Migration20261029000002IntegrityTriggers extends Migration {
  override async up(): Promise<void> {
    this.addSql(`CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is forbidden (append-only)', TG_OP, TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END $$`);
    this.addSql(`CREATE TRIGGER ledger_forbid_update_delete BEFORE UPDATE OR DELETE ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`);
    this.addSql(`CREATE TRIGGER ledger_forbid_truncate BEFORE TRUNCATE ON wallet_ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`);

    this.addSql(`CREATE FUNCTION ledger_enforce_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prev_after numeric(20,2);
BEGIN
  IF EXISTS (SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = NEW.wallet_id AND wallet_version > NEW.wallet_version) THEN
    RAISE EXCEPTION 'ledger entry out of order for wallet %', NEW.wallet_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT balance_after INTO prev_after FROM wallet_ledger_entries
   WHERE wallet_id = NEW.wallet_id AND wallet_version < NEW.wallet_version
   ORDER BY wallet_version DESC LIMIT 1;
  IF COALESCE(prev_after, 0) <> NEW.balance_before THEN
    RAISE EXCEPTION 'ledger chain broken for wallet % (expected before=%, got %)', NEW.wallet_id, COALESCE(prev_after, 0), NEW.balance_before
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$`);
    this.addSql(`CREATE TRIGGER ledger_enforce_chain BEFORE INSERT ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_enforce_chain()`);

    this.addSql(`CREATE FUNCTION wallets_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.player_id <> OLD.player_id OR NEW.currency <> OLD.currency OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'immutable wallet column changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.balance <> OLD.balance AND NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'wallet version must increment by exactly 1 when balance changes' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.balance = OLD.balance AND NEW.version <> OLD.version THEN
    RAISE EXCEPTION 'wallet version may only change together with balance' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$`);
    this.addSql(
      'CREATE TRIGGER wallets_guard_update BEFORE UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION wallets_guard_update()',
    );
    this.addSql(
      'CREATE TRIGGER wallets_forbid_delete BEFORE DELETE ON wallets FOR EACH ROW EXECUTE FUNCTION forbid_mutation()',
    );

    this.addSql(`CREATE FUNCTION wallets_assert_ledger_backed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_balance numeric(20,2); current_version integer;
BEGIN
  SELECT balance, version INTO current_balance, current_version FROM wallets WHERE id = NEW.id;
  IF current_balance = 0 AND NOT EXISTS (SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = NEW.id) THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM wallet_ledger_entries
     WHERE wallet_id = NEW.id AND wallet_version = current_version AND balance_after = current_balance) THEN
    RAISE EXCEPTION 'wallet % balance % (version %) is not backed by a ledger entry', NEW.id, current_balance, current_version
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$`);
    this.addSql(`CREATE CONSTRAINT TRIGGER wallets_ledger_backed AFTER INSERT OR UPDATE ON wallets
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wallets_assert_ledger_backed()`);

    this.addSql(`CREATE FUNCTION wager_tx_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'wager_transactions rows cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
    RAISE EXCEPTION 'wager transaction % is terminal (%)', OLD.id, OLD.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT (
       (OLD.status = 'PENDING' AND NEW.status IN ('PENDING_REFERENCE','PROCESSED','REJECTED','FAILED'))
    OR (OLD.status = 'PENDING_REFERENCE' AND NEW.status IN ('PENDING_REFERENCE','PROCESSED','REJECTED','FAILED'))) THEN
    RAISE EXCEPTION 'invalid wager transaction transition % -> %', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash, NEW.wallet_id, NEW.player_id,
      NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency, NEW.reference_external_transaction_id, NEW.source, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash, OLD.wallet_id, OLD.player_id,
      OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency, OLD.reference_external_transaction_id, OLD.source, OLD.created_at) THEN
    RAISE EXCEPTION 'immutable wager transaction column changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$`);
    this.addSql(
      'CREATE TRIGGER wager_tx_guard BEFORE UPDATE OR DELETE ON wager_transactions FOR EACH ROW EXECUTE FUNCTION wager_tx_guard()',
    );
  }

  override async down(): Promise<void> {
    this.addSql('DROP TRIGGER IF EXISTS wager_tx_guard ON wager_transactions');
    this.addSql('DROP FUNCTION IF EXISTS wager_tx_guard()');
    this.addSql('DROP TRIGGER IF EXISTS wallets_ledger_backed ON wallets');
    this.addSql('DROP FUNCTION IF EXISTS wallets_assert_ledger_backed()');
    this.addSql('DROP TRIGGER IF EXISTS wallets_forbid_delete ON wallets');
    this.addSql('DROP TRIGGER IF EXISTS wallets_guard_update ON wallets');
    this.addSql('DROP FUNCTION IF EXISTS wallets_guard_update()');
    this.addSql('DROP TRIGGER IF EXISTS ledger_enforce_chain ON wallet_ledger_entries');
    this.addSql('DROP FUNCTION IF EXISTS ledger_enforce_chain()');
    this.addSql('DROP TRIGGER IF EXISTS ledger_forbid_truncate ON wallet_ledger_entries');
    this.addSql('DROP TRIGGER IF EXISTS ledger_forbid_update_delete ON wallet_ledger_entries');
    this.addSql('DROP FUNCTION IF EXISTS forbid_mutation()');
  }
}
