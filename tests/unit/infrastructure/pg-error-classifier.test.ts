import { describe, expect, test } from 'bun:test';
import {
  IntegrityViolationError,
  TransientDatabaseError,
  UniqueViolationError,
  ValidationError,
} from '../../../src/application/errors';
import { classifyDatabaseError } from '../../../src/infrastructure/persistence/pg-error-classifier';

const pgError = (code: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(`pg ${code}`), { code, ...extra });

describe('classifyDatabaseError', () => {
  test.each([
    ['40001', 'serialization'],
    ['40P01', 'deadlock'],
    ['55P03', 'lock_timeout'],
    ['57014', 'statement_timeout'],
    ['57P01', 'connection'],
    ['57P02', 'connection'],
    ['57P03', 'connection'],
    ['53300', 'connection'],
    ['53400', 'connection'],
    ['08006', 'connection'],
    ['08001', 'connection'],
    ['ECONNREFUSED', 'connection'],
    ['ECONNRESET', 'connection'],
    ['ETIMEDOUT', 'connection'],
    ['EPIPE', 'connection'],
    ['ENOTFOUND', 'connection'],
  ])('%s is transient (%s)', (code, reason) => {
    const out = classifyDatabaseError(pgError(code));
    expect(out).toBeInstanceOf(TransientDatabaseError);
    expect((out as TransientDatabaseError).reason).toBe(reason as TransientDatabaseError['reason']);
  });

  test('pool messages are transient', () => {
    expect(classifyDatabaseError(new Error('timeout exceeded when trying to connect'))).toBeInstanceOf(
      TransientDatabaseError,
    );
    expect(classifyDatabaseError(new Error('Connection terminated unexpectedly'))).toBeInstanceOf(
      TransientDatabaseError,
    );
  });

  test('23505 carries the constraint name', () => {
    const out = classifyDatabaseError(pgError('23505', { constraint: 'wager_tx_idempotency_key_uk' }));
    expect(out).toBeInstanceOf(UniqueViolationError);
    expect((out as UniqueViolationError).constraint).toBe('wager_tx_idempotency_key_uk');
  });

  test.each(['23514', '23503', '23000', '23502'])('%s is a permanent integrity violation', (code) => {
    expect(classifyDatabaseError(pgError(code, { constraint: 'x' }))).toBeInstanceOf(IntegrityViolationError);
  });

  test('code found through the cause chain (driver wrappers)', () => {
    const wrapped = new Error('DriverException', { cause: pgError('55P03') });
    expect(classifyDatabaseError(wrapped)).toBeInstanceOf(TransientDatabaseError);
  });

  test('application errors and unknown errors pass through', () => {
    const v = new ValidationError([]);
    expect(classifyDatabaseError(v)).toBe(v);
    const unknown = new Error('boom');
    expect(classifyDatabaseError(unknown)).toBe(unknown);
    const syntax = pgError('42601');
    expect(classifyDatabaseError(syntax)).toBe(syntax);
  });
});
