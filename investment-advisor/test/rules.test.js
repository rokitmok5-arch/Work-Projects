import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { compileRules, planEntry, evaluateRules, stopDistanceBps, planFromSignal } from '../src/rules.js';
import { newPortfolio, applyTrade } from '../src/portfolio.js';
import { toMils } from '../src/money.js';

const rules = compileRules(JSON.parse(fs.readFileSync(new URL('../config/rules.json', import.meta.url))));
const quote = (price, extra = {}) => ({ price, sma20: price, dailyVolPct: 1, rsi14: 55, ...extra });

/** A portfolio holding 10 shares of XYZ at $100.000 with an explicit plan. */
function holding(plan = {}) {
  const p = applyTrade(newPortfolio(10000), { side: 'buy', symbol: 'XYZ', quantity: 10, price: '100.000' });
  p.positions[0].plan = { entry: '100.000', stop: '95.123', initial_stop: '95.123', stop_bps: 488, target: '110.000', high_water: '100.000', ...plan };
  return p;
}
const exitFor = (portfolio, q, extra = {}) =>
  evaluateRules({ portfolio, quotes: { XYZ: q }, rules, advice: { recommendations: [], avoid: [] }, ...extra }).signals.find((s) => s.symbol === 'XYZ');

test('stop distance scales with volatility and is clamped', () => {
  assert.equal(stopDistanceBps(1, rules), 632); // 2 sigma * 1% * sqrt(10) = 6.32%
  assert.equal(stopDistanceBps(0.2, rules), 300); // floor 3%
  assert.equal(stopDistanceBps(6, rules), 2500); // cap 25%
});

test('entry plan levels are exact and rounded in the protective direction', () => {
  const plan = planEntry({ priceMils: toMils('187.452'), sma20Mils: toMils('180.000'), dailyVolPct: 1, assetClass: 'stock' }, rules);
  assert.equal(plan.stop, toMils('175.606')); // 187.452 * (1 - 6.32%) = 175.60503 -> up
  assert.equal(plan.target, toMils('211.144')); // entry + 2R = 187.452 + 2 * 11.846
  assert.equal(plan.maxEntry, toMils('194.400')); // 20-day average + 8%
  assert.equal(plan.stopOrder, toMils('175.610')); // whole cent, rounded up
  assert.equal(plan.buyLimit, toMils('187.450')); // whole cent, rounded down
  const withForecast = planEntry({ priceMils: toMils('100.000'), sma20Mils: null, dailyVolPct: 1, expectedMovePct: 12.345, assetClass: 'stock' }, rules);
  assert.equal(withForecast.target, toMils('112.350')); // 12.345% is held to 0.01% precision: 12.35%
  assert.equal(withForecast.targetSource, 'forecast');
});

test('stop-loss fires at exactly the stop price, not $0.001 above it', () => {
  assert.equal(exitFor(holding(), quote('95.124')).action, 'hold');
  const hit = exitFor(holding(), quote('95.123'));
  assert.equal(hit.action, 'sell_all');
  assert.equal(hit.rule, 'stop-loss');
  assert.equal(hit.quantity, '10');
  assert.equal(hit.stopOrder, '95.130');
});

test('target takes partial profit at exactly the target and lifts the stop to at least breakeven', () => {
  assert.equal(exitFor(holding(), quote('109.999')).action, 'hold');
  const result = evaluateRules({ portfolio: holding(), quotes: { XYZ: quote('110.000') }, rules, advice: { recommendations: [], avoid: [] } });
  const tp = result.signals[0];
  assert.equal(tp.rule, 'target-reached');
  assert.equal(tp.quantity, '5');
  // The trailing stop (110.000 * (1 - 4.88%) = 104.6320) is already above breakeven, so it wins.
  assert.equal(tp.stop, '104.632');
  assert.equal(result.portfolio.positions[0].plan.stop, '104.632');

  // With a wide stop the trail is still below cost, so the stop is lifted to breakeven.
  const wide = holding({ stop: '80.000', initial_stop: '80.000', stop_bps: 2000, target: '105.000' });
  const be = evaluateRules({ portfolio: wide, quotes: { XYZ: quote('105.000') }, rules, advice: {} }).signals[0];
  assert.equal(be.rule, 'target-reached');
  assert.equal(be.stop, '100.000');
  assert.equal(be.stopOrder, '100.000');
  assert.ok(result.portfolio.positions[0].plan.target_hit_at);

  // Recording the partial sale marks it taken; the rest rides the trailing stop.
  const after = applyTrade(result.portfolio, { side: 'sell', symbol: 'XYZ', quantity: 5, price: '110.000' });
  assert.equal(after.positions[0].plan.partial_taken, true);
  assert.equal(exitFor(after, quote('111.000')).action, 'hold');
});

test('trailing stop activates at 1R and only ratchets up', () => {
  // R = 100.000 - 95.123 = 4.877; activation at 104.877.
  const below = evaluateRules({ portfolio: holding(), quotes: { XYZ: quote('104.876') }, rules, advice: {} });
  assert.equal(below.portfolio.positions[0].plan.trail_active, undefined);
  const up = evaluateRules({ portfolio: holding(), quotes: { XYZ: quote('108.000') }, rules, advice: {} });
  const plan = up.portfolio.positions[0].plan;
  assert.equal(plan.trail_active, true);
  assert.equal(plan.high_water, '108.000');
  assert.equal(plan.stop, '102.730'); // 108.000 * (1 - 4.88%) = 102.7296 -> up
  // A pullback does not lower the stop, and a touch of it sells.
  const back = { ...up.portfolio };
  assert.equal(exitFor(back, quote('102.731')).action, 'hold');
  const hit = exitFor(back, quote('102.730'));
  assert.equal(hit.rule, 'trailing-stop');
});

test('thesis, avoid, consensus, time and weight rules', () => {
  const events = [{ id: 'evt-1', name: 'Tariff', status: 'in_effect', channels: [{ symbol: 'XYZ', status: 'diverging', movedPct: -3.21 }] }];
  const diverging = exitFor(holding({ event_ids: ['evt-1'] }), quote('101.000'), { events });
  assert.equal(diverging.rule, 'thesis-diverging');
  assert.equal(diverging.quantity, '5');

  const avoid = exitFor(holding(), quote('101.000'), { advice: { avoid: [{ symbol: 'xyz' }] } });
  assert.equal(avoid.rule, 'advisor-avoid');

  const flip = exitFor(holding(), quote('101.000'), { candidates: [{ symbol: 'XYZ', stance: 'bearish', sourceCount: 2 }] });
  assert.equal(flip.rule, 'consensus-turned-bearish');

  const now = Date.parse('2026-12-01T00:00:00Z');
  const expired = holding({ window_ends: '2026-11-30T00:00:00Z' });
  const timeStop = evaluateRules({ portfolio: expired, quotes: { XYZ: quote('102.000') }, rules, advice: {}, now }).signals[0];
  assert.equal(timeStop.rule, 'time-stop'); // +2.000 is 0.41R, below the 0.5R bar
  const working = evaluateRules({ portfolio: expired, quotes: { XYZ: quote('102.439') }, rules, advice: {}, now }).signals[0];
  assert.equal(working.rule, 'no-exit-rule-triggered'); // +2.439 is 0.5001R

  const heavy = applyTrade(newPortfolio(1000), { side: 'buy', symbol: 'XYZ', quantity: 10, price: '100.000' });
  heavy.positions[0].plan = holding().positions[0].plan;
  const trim = exitFor(heavy, quote('101.000'));
  assert.equal(trim.rule, 'overweight');
  // Total 1010.000; cap 15% = 151.500; excess 858.500 / 101.000 = 8.5 -> 9 whole shares.
  assert.equal(trim.quantity, '9');
});

test('buy signals size by allocation, risk budget and cash, and wait when entry rules fail', () => {
  const rec = (symbol, extra = {}) => ({
    rank: 1, symbol, name: symbol, asset_class: 'stock', action: 'buy', suggested_allocation_pct: 10, expected_move_pct: 0,
    independentReports: 3, events: [], ...extra,
  });
  const portfolio = newPortfolio(10000);
  const result = evaluateRules({
    portfolio,
    rules,
    quotes: { AAA: quote('50.000'), HOT: quote('100.000', { rsi14: 78 }), FAR: quote('120.000', { sma20: '100.000' }), THIN: quote('50.000') },
    advice: { recommendations: [rec('AAA'), rec('HOT'), rec('FAR'), rec('THIN', { independentReports: 1 })], avoid: [] },
  });
  const by = Object.fromEntries(result.signals.map((s) => [s.symbol, s]));

  // Allocation 10% of $10,000 = $1,000 -> 20 shares; risk 1% = $100 / $3.160 per share -> 31 shares; cash 200 -> 20.
  assert.equal(by.AAA.side, 'BUY');
  assert.equal(by.AAA.quantity, '20');
  assert.equal(by.AAA.plan.stop, '46.840');
  assert.equal(by.AAA.plan.target, '56.320');
  assert.equal(by.AAA.value, '1000.000');

  assert.equal(by.HOT.side, 'WAIT');
  assert.match(by.HOT.reason, /RSI 78 is above 70/);
  assert.equal(by.FAR.side, 'WAIT');
  assert.match(by.FAR.reason, /buy at or below \$108\.000/);
  assert.match(by.THIN.reason, /only 1 independent report/);

  const plan = planFromSignal(by.AAA);
  assert.equal(plan.stop_bps, 632);
  assert.equal(plan.initial_stop, '46.840');
});
