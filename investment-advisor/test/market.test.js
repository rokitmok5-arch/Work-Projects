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
