import { Migration } from '@mikro-orm/migrations';

const CEILING = '999999999999999.99';

/**
 * Closes three schema gaps found in review:
 * 1. Balance ceiling 999999999999999.99: no write may *raise* a balance above it
 *    (the domain rejects such credits as BALANCE_LIMIT_EXCEEDED first; the schema
 *    is the backstop). Wallets: trigger `wallets_enforce_ceiling` (INSERT above
 *    the ceiling, or UPDATE that increases a balance above it → 23514). Ledger:
 *    CHECK `ledger_balance_ceiling_ck` on CREDIT entries, NOT VALID. Rows written
 *    before the ceiling existed (possible on a live database) do not block the
 *    migration and such wallets stay usable: they load (Money.fromPersisted) and
 *    may still be debited (move towards the ceiling), never credited.
 * 2. Ledger chain also requires contiguous versions (N follows N-1, first is 1).
 * 3. "ledger ⇒ balance": a DEFERRED constraint trigger on the ledger checks at
 *    COMMIT that the entry's transaction is PROCESSED and moves money (not LOSS),
 *    and that the wallet's version reached the entry's version — i.e. every
 *    entry corresponds to a real wallet balance change. Together with
 *    `wallets_ledger_backed` (balance ⇒ ledger) both directions hold in the database.
 */
export class Migration20261030000005BalanceCeilingAndLedgerGuards extends Migration {
  override async up(): Promise<void> {
    this.addSql(`CREATE FUNCTION wallets_enforce_ceiling() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.balance > ${CEILING} AND (TG_OP = 'INSERT' OR NEW.balance > OLD.balance) THEN
    RAISE EXCEPTION 'wallet % balance % exceeds the ceiling ${CEILING}', NEW.id, NEW.balance
      USING ERRCODE = 'check_violation', CONSTRAINT = 'wallets_balance_ceiling_ck';
  END IF;
  RETURN NEW;
END $$`);
    this.addSql(
      'CREATE TRIGGER wallets_enforce_ceiling BEFORE INSERT OR UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION wallets_enforce_ceiling()',
    );
    this.addSql(
      `ALTER TABLE wallet_ledger_entries ADD CONSTRAINT ledger_balance_ceiling_ck CHECK (direction = 'DEBIT' OR balance_after <= ${CEILING}) NOT VALID`,
    );

    this.addSql(`CREATE OR REPLACE FUNCTION ledger_enforce_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prev_after numeric(20,2); prev_version integer;
BEGIN
  SELECT wallet_version, balance_after INTO prev_version, prev_after FROM wallet_ledger_entries
   WHERE wallet_id = NEW.wallet_id ORDER BY wallet_version DESC LIMIT 1;
  IF COALESCE(prev_version, 0) + 1 <> NEW.wallet_version THEN
    RAISE EXCEPTION 'ledger entry out of order for wallet % (expected version %, got %)', NEW.wallet_id, COALESCE(prev_version, 0) + 1, NEW.wallet_version
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF COALESCE(prev_after, 0) <> NEW.balance_before THEN
    RAISE EXCEPTION 'ledger chain broken for wallet % (expected before=%, got %)', NEW.wallet_id, COALESCE(prev_after, 0), NEW.balance_before
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$`);

    this.addSql(`CREATE FUNCTION ledger_assert_backed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tx_status text; tx_kind text; current_version integer;
BEGIN
  SELECT status, kind INTO tx_status, tx_kind FROM wager_transactions WHERE id = NEW.transaction_id;
  IF tx_status IS DISTINCT FROM 'PROCESSED' OR tx_kind = 'LOSS' THEN
    RAISE EXCEPTION 'ledger entry % requires a PROCESSED balance-moving transaction (got % %)', NEW.id, tx_status, tx_kind
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT version INTO current_version FROM wallets WHERE id = NEW.wallet_id;
  IF current_version IS NULL OR current_version < NEW.wallet_version THEN
    RAISE EXCEPTION 'ledger entry % (version %) has no matching wallet balance change (wallet version %)', NEW.id, NEW.wallet_version, current_version
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$`);
    this.addSql(`CREATE CONSTRAINT TRIGGER ledger_backed_by_wallet AFTER INSERT ON wallet_ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_assert_backed()`);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TRIGGER IF EXISTS ledger_backed_by_wallet ON wallet_ledger_entries');
    this.addSql('DROP FUNCTION IF EXISTS ledger_assert_backed()');
    // Restore the original chain function body (migration 2).
    this.addSql(`CREATE OR REPLACE FUNCTION ledger_enforce_chain() RETURNS trigger LANGUAGE plpgsql AS $$
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
    this.addSql('ALTER TABLE wallet_ledger_entries DROP CONSTRAINT IF EXISTS ledger_balance_ceiling_ck');
    this.addSql('DROP TRIGGER IF EXISTS wallets_enforce_ceiling ON wallets');
    this.addSql('DROP FUNCTION IF EXISTS wallets_enforce_ceiling()');
    this.addSql('ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_balance_ceiling_ck');
  }
}
