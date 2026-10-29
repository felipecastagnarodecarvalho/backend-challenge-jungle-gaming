import { describe, expect, test } from 'bun:test';
import {
  IdempotencyRaceError,
  IntegrityViolationError,
  TransientDatabaseError,
  TransientInfrastructureError,
  UniqueViolationError,
} from '../../../src/application/errors';
import { withTransientRetry } from '../../../src/application/shared/transient-retry';
import { recordingMetrics } from '../../support/fakes';

const policy = { maxAttempts: 3, sleep: async () => undefined, random: () => 0 };

describe('withTransientRetry', () => {
  test('retries transient errors and succeeds', async () => {
    const metrics = recordingMetrics();
    let calls = 0;
    const result = await withTransientRetry(
      async () => {
        calls++;
        if (calls < 3) throw new TransientDatabaseError('deadlock');
        return 'ok';
      },
      policy,
      metrics,
      'op',
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(metrics.calls.filter(([n]) => n === 'retry')).toHaveLength(2);
    expect(metrics.calls.filter(([n]) => n === 'lockConflict')).toHaveLength(2);
  });

  test('converts exhausted retries into TransientInfrastructureError', async () => {
    let calls = 0;
    const promise = withTransientRetry(
      async () => {
        calls++;
        throw new TransientDatabaseError('lock_timeout');
      },
      policy,
      recordingMetrics(),
      'op',
    );
    await expect(promise).rejects.toBeInstanceOf(TransientInfrastructureError);
    expect(calls).toBe(3);
  });

  test('retries idempotency races and known race constraints', async () => {
    for (const err of [new IdempotencyRaceError(), new UniqueViolationError('wager_tx_single_reversal_uk')]) {
      let calls = 0;
      await withTransientRetry(
        async () => {
          calls++;
          if (calls === 1) throw err;
        },
        policy,
        recordingMetrics(),
        'op',
      );
      expect(calls).toBe(2);
    }
  });

  test('does not retry permanent errors', async () => {
    for (const err of [
      new IntegrityViolationError('x'),
      new UniqueViolationError('wallets_player_currency_uk'),
      new Error('bug'),
    ]) {
      let calls = 0;
      await expect(
        withTransientRetry(
          async () => {
            calls++;
            throw err;
          },
          policy,
          recordingMetrics(),
          'op',
        ),
      ).rejects.toBe(err);
      expect(calls).toBe(1);
    }
  });

  test('backoff grows and is capped', async () => {
    const waits: number[] = [];
    await expect(
      withTransientRetry(
        async () => {
          throw new TransientDatabaseError('serialization');
        },
        { maxAttempts: 6, sleep: async (ms) => void waits.push(ms), random: () => 0 },
        recordingMetrics(),
        'op',
      ),
    ).rejects.toBeInstanceOf(TransientInfrastructureError);
    expect(waits).toEqual([25, 50, 100, 200, 200]);
  });
});
