import { describe, expect, test } from 'bun:test';
import { Money } from '../../../../src/domain/value-objects/money';

const createBrl = (amount: string): Money =>
  Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test('calculates decimal values exactly and preserves operands', () => {
    const original = createBrl('0.10');
    const result = original.add(createBrl('0.20'));
    expect(result.toJSON()).toEqual({ amount: '0.30', currency: 'BRL' });
    expect(original.toString()).toBe('0.10');
    expect(result).not.toBe(original);
    expect(Object.isFrozen(original)).toBe(true);
  });

  test('preserves cents beyond the safe integer range of JavaScript', () => {
    expect(
      createBrl('9999999999999999.98').add(createBrl('0.01')).toString(),
    ).toBe('9999999999999999.99');
  });

  test('supports signed arithmetic and exact rehydration', () => {
    const result = createBrl('1.00').subtract(createBrl('2.00'));
    expect(result.isNegative()).toBe(true);
    expect(result.toString()).toBe('-1.00');
    expect(result.negate().equals(createBrl('1.00'))).toBe(true);
    expect(Money.rehydrate(result.toJSON()).equals(result)).toBe(true);
  });

  test('compares values and treats zero as neither positive nor negative', () => {
    const zero = Money.zero('BRL');
    expect(zero.isZero()).toBe(true);
    expect(zero.isPositive()).toBe(false);
    expect(zero.isNegative()).toBe(false);
    expect(createBrl('0.01').isPositive()).toBe(true);
    expect(zero.isLessThan(createBrl('0.01'))).toBe(true);
    expect(createBrl('1.00').equals(createBrl('2.00'))).toBe(false);
    expect(zero.negate().toString()).toBe('0.00');
  });

  test.each([
    '',
    ' ',
    'NaN',
    'Infinity',
    '1e2',
    '1',
    '1.0',
    '1.001',
    '1.005',
    '-1.00',
    '-0.00',
    '+1.00',
    '01.00',
    '.10',
    '1,00',
    ' 1.00',
    '1.00\n',
    '10000000000000000.00',
  ])('rejects invalid input without rounding: %j', (amount) => {
    expect(() => createBrl(amount)).toThrow('Amount must be');
  });

  test.each(['add', 'subtract', 'equals', 'isLessThan'] as const)(
    'rejects mixed currencies in %s',
    (operation) => {
      const usd = Money.from({ amount: '1.00', currency: 'USD' });
      expect(() => createBrl('1.00')[operation](usd)).toThrow(
        'currencies must match',
      );
    },
  );

  test.each(['', 'brl', 'ZZZ'])(
    'rejects unsupported currency %j',
    (currency) => {
      expect(() => Money.zero(currency)).toThrow('Supported currencies');
    },
  );

  test('rejects arithmetic overflow on either side of the supported range', () => {
    const maximum = createBrl('9999999999999999.99');
    expect(() => maximum.add(createBrl('0.01'))).toThrow(
      'exceeds numeric(18,2)',
    );
    expect(() => maximum.negate().subtract(createBrl('0.01'))).toThrow(
      'exceeds numeric(18,2)',
    );
  });

  test('serializes money as decimal strings in JSON', () => {
    expect(JSON.stringify(createBrl('25.00'))).toBe(
      '{"amount":"25.00","currency":"BRL"}',
    );
  });
});
