import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError, Money, type MoneyProps } from '../../../src/domain/money/money';

const m = (amount: string, currency = 'BRL') => Money.from({ amount, currency });

describe('Money.from (input contract)', () => {
  test.each(['0.00', '25.00', '0.01', '999999999999999.99'])('accepts %p', (amount) => {
    expect(m(amount).toJSON()).toEqual({ amount, currency: 'BRL' });
  });

  test.each([
    '',
    'NaN',
    'Infinity',
    '-Infinity',
    '1e3',
    '1E3',
    '-1.00',
    '+1.00',
    '1.005',
    '25',
    '25.5',
    '01.00',
    ' 1.00',
    '1.00 ',
    '1,00',
    '.50',
    '1000000000000000.00',
  ])('rejects amount %p', (amount) => {
    expect(() => m(amount)).toThrow(InvalidMoneyError);
  });

  test('rejects a JS number amount', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test.each(['brl', 'BR', 'BRLL', '', '12A'])('rejects currency %p', (currency) => {
    expect(() => m('1.00', currency)).toThrow(InvalidMoneyError);
  });

  test('rejects non-object input', () => {
    expect(() => Money.from(null as unknown as MoneyProps)).toThrow(InvalidMoneyError);
  });
});

describe('Money arithmetic', () => {
  test('0.10 + 0.20 is exactly 0.30 (no float drift)', () => {
    expect(m('0.10').add(m('0.20')).equals(m('0.30'))).toBe(true);
    expect(m('0.10').add(m('0.20')).toJSON().amount).toBe('0.30');
  });

  test('large values stay exact', () => {
    expect(m('999999999999999.98').add(m('0.01')).toJSON().amount).toBe('999999999999999.99');
  });

  test('subtract may go negative internally and serialises with sign', () => {
    const r = m('5.00').subtract(m('10.00'));
    expect(r.isNegative()).toBe(true);
    expect(r.toJSON().amount).toBe('-5.00');
  });

  test('negate, and negative zero normalises to 0.00', () => {
    expect(m('5.00').negate().toJSON().amount).toBe('-5.00');
    expect(m('0.00').negate().toJSON().amount).toBe('0.00');
    expect(m('0.00').negate().isZero()).toBe(true);
  });

  test('scale is preserved (no implicit rounding)', () => {
    expect(m('1.10').add(m('2.25')).toJSON().amount).toBe('3.35');
    expect(m('100.00').subtract(m('0.01')).toJSON().amount).toBe('99.99');
  });

  test('immutability: operations return new instances', () => {
    const a = m('10.00');
    const b = a.add(m('1.00'));
    expect(a.toJSON().amount).toBe('10.00');
    expect(b).not.toBe(a);
  });

  test('predicates', () => {
    expect(m('0.00').isZero()).toBe(true);
    expect(m('0.01').isPositive()).toBe(true);
    expect(m('0.00').isPositive()).toBe(false);
    expect(m('1.00').isLessThan(m('2.00'))).toBe(true);
    expect(m('2.00').isLessThan(m('2.00'))).toBe(false);
  });

  test('toString', () => {
    expect(m('25.00').toString()).toBe('25.00 BRL');
  });
});

describe('Money currency conflicts', () => {
  test('add/subtract/isLessThan across currencies throw', () => {
    expect(() => m('1.00').add(m('1.00', 'USD'))).toThrow(CurrencyMismatchError);
    expect(() => m('1.00').subtract(m('1.00', 'USD'))).toThrow(CurrencyMismatchError);
    expect(() => m('1.00').isLessThan(m('1.00', 'USD'))).toThrow(CurrencyMismatchError);
  });

  test('equals across currencies is false (no throw)', () => {
    expect(m('1.00').equals(m('1.00', 'USD'))).toBe(false);
  });
});

describe('Money.fromSigned / zero', () => {
  test('rebuilds negative internal values', () => {
    expect(Money.fromSigned({ amount: '-12.34', currency: 'BRL' }).toJSON().amount).toBe('-12.34');
    expect(() => Money.fromSigned({ amount: '1.5', currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test('zero', () => {
    expect(Money.zero('USD').toJSON()).toEqual({ amount: '0.00', currency: 'USD' });
    expect(() => Money.zero('usd')).toThrow(InvalidMoneyError);
  });
});
