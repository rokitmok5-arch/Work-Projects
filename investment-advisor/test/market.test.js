import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, fetchQuotes } from '../src/market.js';
import { chartPayload, jsonResponse } from './helpers.js';

process.env.ADVISOR_QUIET = '1';

test('computeMetrics flags a rising series as an uptrend', () => {
  const m = computeMetrics(chartPayload('UP', { dailyDrift: 0.004 }).chart.result[0]);
  assert.equal(m.symbol, 'UP');
  assert.equal(m.assetClass, 'stock');
  assert.equal(m.trend, 'uptrend');
  assert.ok(m.change1moPct > 0);
  assert.ok(m.change1yPct > 100);
  assert.ok(m.rsi14 > 50 && m.rsi14 <= 100);
  assert.ok(m.volatility20dPct > 0);
  assert.ok(m.offHighPct <= 0);
});

test('computeMetrics flags a falling series as a downtrend', () => {
  const m = computeMetrics(chartPayload('DOWN', { dailyDrift: -0.004, instrumentType: 'CRYPTOCURRENCY' }).chart.result[0]);
  assert.equal(m.trend, 'downtrend');
  assert.equal(m.assetClass, 'crypto');
  assert.ok(m.change1moPct < 0);
  assert.ok(m.rsi14 < 50);
});

test('fetchQuotes records symbols the provider rejects', async () => {
  const fetchImpl = async (url) =>
    url.includes('GOOD') ? jsonResponse(chartPayload('GOOD')) : jsonResponse({ chart: { result: null, error: { description: 'Not Found' } } }, 404);
  const { quotes, failed } = await fetchQuotes(['GOOD', 'FAKE'], { fetchImpl });
  assert.deepEqual(Object.keys(quotes), ['GOOD']);
  assert.deepEqual(failed, ['FAKE']);
});

test('moveSince measures the move from the last close before an event, scaled by volatility', async () => {
  const { moveSince } = await import('../src/market.js');
  const day = 86400;
  const series = [100, 101, 100, 110].map((close, i) => ({ t: 1_700_000_000 + i * day, close }));
  const eventTime = new Date((1_700_000_000 + 2 * day + 3600) * 1000).toISOString(); // after bar 2's timestamp
  const move = moveSince(series, eventTime, { dailyVolPct: 1 });
  assert.equal(move.changePct, 10);
  assert.equal(move.bars, 1);
  assert.equal(move.z, 10);
  assert.equal(moveSince(series, '2000-01-01T00:00:00Z', { dailyVolPct: 1 }), null);
});

test('buildMarketMap flags instruments moving far outside their normal range', async () => {
  const { buildMarketMap } = await import('../src/market.js');
  const quotes = {
    SPY: { price: 500, change1dPct: 0.2, change5dPct: 0.5, move1dZ: 0.2, move5dZ: 0.3, trend: 'uptrend' },
    'CL=F': { price: 90, change1dPct: 6, change5dPct: 9, move1dZ: 2.8, move5dZ: 2.1, trend: 'uptrend' },
  };
  const map = buildMarketMap({ Equities: { SPY: 'S&P 500', MISSING: 'x' }, Commodities: { 'CL=F': 'WTI crude' } }, quotes);
  assert.equal(map.rows.length, 2);
  assert.deepEqual(map.anomalies.map((r) => r.symbol), ['CL=F']);
  assert.equal(map.anomalies[0].group, 'Commodities');
});
