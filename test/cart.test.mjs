import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTotals, formatMoney, parsePrice, cartProblems, clampQty } from '../src/cart.mjs';

test('computeTotals applies flat shipping, free threshold and tax', () => {
  const s = { tax_rate: '8.25', shipping_flat_cents: '799', free_shipping_over_cents: '10000' };
  const t = computeTotals([{ price_cents: 2500, qty: 2 }], s);
  assert.equal(t.subtotal, 5000);
  assert.equal(t.shipping, 799);
  assert.equal(t.tax, 413);
  assert.equal(t.total, 5000 + 799 + 413);
  assert.equal(t.count, 2);
  const big = computeTotals([{ price_cents: 10000, qty: 1 }], s);
  assert.equal(big.shipping, 0);
  assert.equal(computeTotals([], s).total, 0);
  assert.equal(computeTotals([{ price_cents: 100, qty: 1 }], { shipping_flat_cents: '500', free_shipping_over_cents: '' }).shipping, 500);
});

test('formatMoney handles decimal and zero-decimal currencies', () => {
  assert.equal(formatMoney(123456, 'usd'), '$1,234.56');
  assert.equal(formatMoney(1500, 'jpy'), '¥1,500');
  assert.equal(formatMoney(0, 'eur'), '€0.00');
});

test('parsePrice parses human input', () => {
  assert.equal(parsePrice('12.50'), 1250);
  assert.equal(parsePrice('$1,299'), 129900);
  assert.equal(parsePrice('0'), 0);
  assert.equal(parsePrice('abc'), null);
  assert.equal(parsePrice(''), null);
  assert.equal(parsePrice('-5'), null);
  assert.equal(parsePrice('1500', 'jpy'), 1500);
  assert.equal(parsePrice('0.015'), 2);
});

test('cartProblems flags stock and status issues', () => {
  const lines = [
    { product_id: 1, name: 'A', qty: 1, stock: 5, status: 'active' },
    { product_id: 2, name: 'B', qty: 3, stock: 2, status: 'active' },
    { product_id: 3, name: 'C', qty: 1, stock: 0, status: 'active' },
    { product_id: 4, name: 'D', qty: 1, stock: 9, status: 'archived' },
  ];
  const p = cartProblems(lines);
  assert.deepEqual(p.map((x) => x.product_id), [2, 3, 4]);
  assert.match(p[0].message, /Only 2/);
  assert.match(p[1].message, /sold out/);
});

test('clampQty', () => {
  assert.equal(clampQty('3'), 3);
  assert.equal(clampQty('x'), 1);
  assert.equal(clampQty(-2), 0);
  assert.equal(clampQty(500), 99);
  assert.equal(clampQty(2.7), 2);
});
