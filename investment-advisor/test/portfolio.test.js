import test from 'node:test';
import assert from 'node:assert/strict';
import { newPortfolio, applyTrade, valuePortfolio } from '../src/portfolio.js';
import { toMils } from '../src/money.js';

test('buys average into cost basis with fees, sells realize exact P&L', () => {
  let p = newPortfolio(10000);
  p = applyTrade(p, { side: 'buy', symbol: 'nvda', quantity: 10, price: '100.123', fees: '1.000' });
  p = applyTrade(p, { side: 'buy', symbol: 'NVDA', quantity: 5, price: '110.456' });
  const [pos] = p.positions;
  // (10 * 100.123 + 1.000 + 5 * 110.456) / 15 = 1554.510 / 15 = 103.634
  assert.equal(pos.avg_cost, '103.634');
  assert.equal(pos.quantity, '15');
  assert.equal(p.cash_usd, '8445.490');

  p = applyTrade(p, { side: 'sell', symbol: 'NVDA', quantity: 6, price: '120.001', fees: '0.500' });
  // 6 * (120.001 - 103.634) - 0.500 = 97.702
  assert.equal(p.realized_pnl_usd, '97.702');
  assert.equal(p.positions[0].quantity, '9');
  assert.equal(p.cash_usd, '9164.996'); // 8445.490 + 6 * 120.001 - 0.500

  p = applyTrade(p, { side: 'sell', symbol: 'NVDA', quantity: 9, price: '103.634' });
  assert.equal(p.positions.length, 0);
  assert.equal(p.realized_pnl_usd, '97.702');
  assert.equal(p.transactions.length, 4);
});

test('invalid trades are rejected', () => {
  const p = applyTrade(newPortfolio(1000), { side: 'buy', symbol: 'XLE', quantity: 2, price: 90 });
  assert.throws(() => applyTrade(p, { side: 'sell', symbol: 'XLE', quantity: 3, price: 90 }), /only 2 held/);
  assert.throws(() => applyTrade(p, { side: 'sell', symbol: 'SPY', quantity: 1, price: 90 }), /no open position/);
  assert.throws(() => applyTrade(p, { side: 'buy', symbol: 'SPY', quantity: 0, price: 90 }), /positive/);
});

test('valuePortfolio computes weights and unrealized P&L at current prices', () => {
  let p = newPortfolio(1000);
  p = applyTrade(p, { side: 'buy', symbol: 'BTC-USD', quantity: '0.01', price: '60000.000', assetClass: 'crypto' });
  const v = valuePortfolio(p, { 'BTC-USD': toMils('63000.000') });
  assert.equal(v.total, toMils('1030.000'));
  assert.equal(v.rows[0].pnl, toMils('30.000'));
  assert.equal(v.rows[0].pnlBps, 500);
  assert.equal(v.rows[0].weightBps, 6117); // 630 / 1030 = 61.165% -> 61.17%
});
