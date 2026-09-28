import test from 'node:test';
import assert from 'node:assert/strict';
import { eventSignals, measureReactions } from '../src/events.js';

const event = {
  name: 'Strait of Hormuz tensions',
  severity: 4,
  outlets: ['Al Jazeera', 'BBC', 'Wall Street Journal'],
  firstReported: '2026-09-27T12:00:00Z',
  headlines: [{ source: 'BBC', title: 'Naval clashes', link: 'https://example.com/bbc' }],
  channels: [
    { symbol: 'CL=F', name: 'WTI crude', asset_class: 'commodity', direction: 'up', order: 'first', mechanism: 'supply risk' },
    { symbol: 'ITA', name: 'Defense ETF', asset_class: 'etf', direction: 'up', order: 'second', mechanism: 'defense spending' },
    { symbol: 'JETS', name: 'Airlines ETF', asset_class: 'etf', direction: 'down', order: 'second', mechanism: 'fuel costs' },
  ],
};

test('eventSignals spreads an event across its outlets without double counting', () => {
  const articleSignals = [{ symbol: 'CL=F', source: 'BBC' }];
  const out = eventSignals([event], articleSignals);
  const oil = out.filter((s) => s.symbol === 'CL=F');
  assert.deepEqual(oil.map((s) => s.source).sort(), ['Al Jazeera', 'Wall Street Journal']);
  assert.ok(oil.every((s) => s.direct && s.sentiment === 'bullish' && s.strength === 4));
  const ita = out.filter((s) => s.symbol === 'ITA');
  assert.equal(ita.length, 3);
  assert.equal(ita[0].direct, false);
  assert.equal(out.find((s) => s.symbol === 'JETS').sentiment, 'bearish');
  assert.equal(out.find((s) => s.source === 'BBC' && s.symbol === 'ITA').link, 'https://example.com/bbc');
});

test('measureReactions labels reacting, lagging and diverging channels', () => {
  const t0 = Date.parse('2026-09-26T20:00:00Z') / 1000;
  const bars = (a, b) => [{ t: t0, close: a }, { t: t0 + 86400, close: b }];
  const quotes = {
    'CL=F': { price: 105, dailyVolPct: 2 }, // +5% = 2.5σ, predicted up -> reacting
    ITA: { price: 100.5, dailyVolPct: 1 }, // +0.5% = 0.5σ -> not yet reflected
    JETS: { price: 104, dailyVolPct: 1.5 }, // +4% but predicted down -> diverging
  };
  const series = { 'CL=F': bars(100, 105), ITA: bars(100, 100.5), JETS: bars(100, 104) };
  const [e] = measureReactions([event], quotes, series);
  const byId = Object.fromEntries(e.channels.map((c) => [c.symbol, c]));
  assert.equal(byId['CL=F'].reaction, 'reacting');
  assert.equal(byId['CL=F'].moveSincePct, 5);
  assert.equal(byId.ITA.reaction, 'not yet reflected');
  assert.equal(byId.JETS.reaction, 'diverging');
  assert.equal(measureReactions([event], {}, {})[0].channels[0].reaction, 'no market data');
});
