import test from 'node:test';
import assert from 'node:assert/strict';
import { div, toMils, toQty, pctToBps, milsToString, qtyToString, valueOf, changeBps, shiftByBps, orderPrice, fmtUsd, fmtPct } from '../src/money.js';

test('prices convert to exact mils without floating-point drift', () => {
  assert.equal(toMils(0.1 + 0.2), 300n);
  assert.equal(toMils(187.45199999999997), 187452n);
  assert.equal(toMils('187.4525'), 187453n); // half away from zero
  assert.equal(toMils('187.4525', 'down'), 187452n);
  assert.equal(toMils('-1.0005'), -1001n);
  assert.equal(milsToString(toMils('0.001')), '0.001');
  assert.equal(fmtUsd(-5n), '-$0.005');
});

test('quantities keep 8 decimals and values round to $0.001', () => {
  assert.equal(qtyToString(toQty('0.12345678')), '0.12345678');
  assert.equal(qtyToString(toQty('10')), '10');
  // 0.12345678 BTC at $64,123.456 = $7,916.47540... -> $7,916.475
  assert.equal(valueOf(toQty('0.12345678'), toMils('64123.456')), 7916475n);
  // Large positions stay exact (beyond Number's 2^53 integer range in qty units x mils).
  assert.equal(valueOf(toQty('250000'), toMils('99999.999')), 24999999750000n);
});

test('percentages are exact to 0.01%', () => {
  assert.equal(pctToBps(8), 800);
  assert.equal(pctToBps(0.01), 1);
  assert.equal(changeBps(100000n, 100010n), 1); // $100.000 -> $100.010 is +0.01%
  assert.equal(changeBps(100000n, 100004n), 0); // +0.004% rounds to 0.00%
  assert.equal(changeBps(100000n, 100005n), 1); // +0.005% rounds to 0.01%
  assert.equal(fmtPct(-512), '-5.12%');
  assert.equal(shiftByBps(187452n, -500, 'up'), 178080n); // 187.452 * 0.95 = 178.0794 -> up to 178.080
  assert.equal(shiftByBps(187452n, -500, 'down'), 178079n);
});

test('order prices snap to valid ticks in the protective direction', () => {
  assert.equal(orderPrice(178071n, 'stock', 'up'), 178080n); // stop sells sooner
  assert.equal(orderPrice(178079n, 'etf', 'down'), 178070n); // buy limit never overpays
  assert.equal(orderPrice(999n, 'stock', 'up'), 999n); // sub-dollar stocks keep $0.001
  assert.equal(orderPrice(64123457n, 'crypto', 'up'), 64123457n);
});

test('division rounding modes', () => {
  assert.equal(div(7n, 2n), 4n);
  assert.equal(div(-7n, 2n), -4n);
  assert.equal(div(-7n, 2n, 'up'), -3n);
  assert.equal(div(-7n, 2n, 'down'), -4n);
  assert.equal(div(7n, 2n, 'down'), 3n);
  assert.throws(() => div(1n, 0n), RangeError);
});
