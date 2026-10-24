import { expect, test } from 'bun:test';
import { assertBalanced, sellerFee } from '../src/core';

test('fee calculation preserves cents at the safe integer boundary', () => {
  for (const amount of [500_000, 5_000_000, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER]) {
    for (const bps of [0, 1, 333, 1000, 9999, 10000]) {
      const result = sellerFee(amount, bps);
      const exact = Number((BigInt(amount) * BigInt(bps) + 9999n) / 10000n);
      expect(result.feeCents).toBe(exact);
      expect(result.sellerNetCents + result.feeCents).toBe(amount);
    }
  }
});

test('journal rejects fractional, unsafe and repeated account entries', () => {
  for (const amount of [0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => assertBalanced([{accountId:'a',amountCents:amount},{accountId:'b',amountCents:-amount}])).toThrow();
  }
  // Repeated debits must not each pass a balance check independently.
  expect(() => assertBalanced([{accountId:'a',amountCents:-80},{accountId:'a',amountCents:-80},{accountId:'b',amountCents:160}])).toThrow(/distinct/);
});

test('balanced totals use exact arithmetic even when intermediate sums exceed safe integers', () => {
  const max=Number.MAX_SAFE_INTEGER;
  expect(() => assertBalanced([{accountId:'a',amountCents:max},{accountId:'b',amountCents:2},{accountId:'c',amountCents:-max},{accountId:'d',amountCents:-2}])).not.toThrow();
  expect(() => assertBalanced([{accountId:'a',amountCents:max},{accountId:'b',amountCents:2},{accountId:'c',amountCents:-max},{accountId:'d',amountCents:-1}])).toThrow(/unbalanced/);
});
