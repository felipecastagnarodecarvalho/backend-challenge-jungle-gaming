import { describe, expect, test } from 'bun:test';
import { InvalidCursorError } from '../../../src/application/errors';
import { LedgerCursor } from '../../../src/application/wallet/ledger-cursor';

describe('LedgerCursor', () => {
  test('round-trip', () => {
    for (const v of [0, 1, 50, 123456]) {
      expect(LedgerCursor.decode(LedgerCursor.encode(v))).toBe(v);
    }
  });

  test('is opaque base64url', () => {
    expect(LedgerCursor.encode(50)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test.each([
    'garbage!!',
    '',
    Buffer.from('{"v":2,"after":1}').toString('base64url'),
    Buffer.from('{"v":1,"after":-1}').toString('base64url'),
    Buffer.from('{"v":1,"after":1.5}').toString('base64url'),
    Buffer.from('{"v":1}').toString('base64url'),
    Buffer.from('not json').toString('base64url'),
  ])('rejects %p', (cursor) => {
    expect(() => LedgerCursor.decode(cursor)).toThrow(InvalidCursorError);
  });
});
