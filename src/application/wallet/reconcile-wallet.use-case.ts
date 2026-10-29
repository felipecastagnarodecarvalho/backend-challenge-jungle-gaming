import { Money, type MoneyProps } from '../../domain/money/money';
import { NotFoundError } from '../errors';
import type { MetricsPort } from '../ports/metrics';
import type { ReconciliationReadModel } from '../ports/read-models';
import type { LoggerPort } from '../ports/system';

export type ReconciliationIssue = 'BALANCE_DIFFERS_FROM_LEDGER_SUM' | 'LAST_ENTRY_MISMATCH' | 'LEDGER_CHAIN_BROKEN';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
  issues: ReconciliationIssue[];
}

/**
 * Compares the materialized balance with the ledger (sum, last entry, chain)
 * on one consistent snapshot without blocking writers. Divergences are never
 * corrected: they are logged, counted in a metric and reported.
 */
export class ReconcileWalletUseCase {
  constructor(
    private readonly readModel: ReconciliationReadModel,
    private readonly metrics: MetricsPort,
    private readonly logger: LoggerPort,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const snap = await this.readModel.snapshot(walletId);
    if (!snap) throw new NotFoundError('WALLET_NOT_FOUND', 'Wallet not found');
    const currency = snap.wallet.currency;
    const stored = Money.fromSigned({ amount: snap.wallet.balance, currency });
    const calculated = Money.fromSigned({ amount: snap.ledgerSum, currency });
    const difference = stored.subtract(calculated);

    const issues: ReconciliationIssue[] = [];
    if (!difference.isZero()) issues.push('BALANCE_DIFFERS_FROM_LEDGER_SUM');
    if (snap.chainBreaks > 0) issues.push('LEDGER_CHAIN_BROKEN');
    const lastMatches =
      snap.lastEntry === null
        ? stored.isZero()
        : Money.fromSigned({ amount: snap.lastEntry.balanceAfter, currency }).equals(stored) &&
          snap.lastEntry.walletVersion === snap.wallet.version;
    if (!lastMatches) issues.push('LAST_ENTRY_MISMATCH');

    const consistent = issues.length === 0;
    this.metrics.reconciliation(consistent);
    if (!consistent) {
      // Aggregated audit data: the difference is logged on purpose, individual payloads are not.
      this.logger.error(
        { walletId, difference: difference.toString(), chainBreaks: snap.chainBreaks, issues },
        'wallet reconciliation mismatch',
      );
    }
    return {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: snap.entries,
      issues,
    };
  }
}
