import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConsensus, selectCandidates, marketConfirmation, scoreCandidates, topThemes } from '../src/aggregate.js';

const sig = (symbol, source, sentiment, strength = 4, direct = true) => ({
  symbol, source, sentiment, strength, direct,
  entity_name: symbol, asset_class: 'stock', rationale: 'r', title: `${source} on ${symbol}`, link: null,
});

test('multi-outlet agreement outranks one outlet repeating itself', () => {
  const signals = [
    sig('NVDA', 'BBC', 'bullish'), sig('NVDA', 'Forbes', 'bullish'), sig('NVDA', 'Wall Street Journal', 'bullish'),
    ...Array.from({ length: 5 }, () => sig('HYPE', 'Business Insider', 'bullish')),
  ];
  const [first, second] = buildConsensus(signals, { totalSources: 7 });
  assert.equal(first.symbol, 'NVDA');
  assert.equal(first.sourceCount, 3);
  assert.equal(second.symbol, 'HYPE');
  assert.equal(second.sourceCount, 1);
});

test('conflicting coverage produces a mixed stance', () => {
  const [e] = buildConsensus([sig('XOM', 'BBC', 'bullish'), sig('XOM', 'Forbes', 'bearish')], { totalSources: 7 });
  assert.equal(e.stance, 'mixed');
  assert.equal(e.netSentiment, 0);
});

test('inferred signals count for less than direct ones', () => {
  const [e] = buildConsensus([sig('CL=F', 'BBC', 'bullish', 5, true), sig('CL=F', 'Al Jazeera', 'bearish', 5, false)], { totalSources: 7 });
  assert.equal(e.stance, 'bullish');
});

test('selectCandidates prefers corroborated names and tops up when short', () => {
  const entities = buildConsensus(
    [sig('A', 'BBC', 'bullish'), sig('A', 'Forbes', 'bullish'), sig('B', 'BBC', 'bullish'), sig('C', 'BBC', 'bearish'), sig('D', 'BBC', 'neutral')],
    { totalSources: 7 },
  );
  assert.deepEqual(selectCandidates(entities, { minSources: 2, minCandidates: 1 }).map((e) => e.symbol), ['A']);
  const topped = selectCandidates(entities, { minSources: 2, minCandidates: 3 }).map((e) => e.symbol);
  assert.equal(topped[0], 'A');
  assert.deepEqual(topped.slice(1).sort(), ['B', 'C']);
});

test('marketConfirmation compares news stance with price trend', () => {
  assert.equal(marketConfirmation('bullish', { trend: 'uptrend', change1moPct: 5 }), 'confirmed');
  assert.equal(marketConfirmation('bullish', { trend: 'downtrend', change1moPct: -5 }), 'contradicted');
  assert.equal(marketConfirmation('bearish', { trend: 'downtrend', change1moPct: -5 }), 'confirmed');
  assert.equal(marketConfirmation('bullish', { trend: 'mixed', change1moPct: 1 }), 'neutral');
  assert.equal(marketConfirmation('bullish', null), 'no market data');
});

test('scoreCandidates lets market confirmation break a news tie', () => {
  const [a, b] = buildConsensus(
    [sig('A', 'BBC', 'bullish'), sig('A', 'Forbes', 'bullish'), sig('B', 'BBC', 'bullish'), sig('B', 'Forbes', 'bullish')],
    { totalSources: 7 },
  );
  const scored = scoreCandidates([a, b], {
    A: { trend: 'downtrend', change1moPct: -8 },
    B: { trend: 'uptrend', change1moPct: 8 },
  });
  assert.equal(scored[0].symbol, 'B');
  assert.equal(scored[0].confirmation, 'confirmed');
});

test('topThemes ranks by outlet breadth', () => {
  const themes = topThemes([
    { theme: 'Fed rate cuts', source: 'BBC' }, { theme: 'fed rate cuts', source: 'Forbes' },
    { theme: 'Crypto ETF flows', source: 'Forbes' }, { theme: 'Crypto ETF flows', source: 'Forbes' },
  ]);
  assert.equal(themes[0].theme, 'Fed rate cuts');
  assert.deepEqual(themes[0].sources, ['BBC', 'Forbes']);
});

test('outlets republishing one wire story count as a single independent report', async () => {
  const { independentReports } = await import('../src/aggregate.js');
  const wire = (source) => ({ ...sig('NVDA', source, 'bullish'), storyId: 'ap-1' });
  assert.equal(independentReports([wire('BBC'), wire('Forbes'), wire('Wall Street Journal')]), 1);
  assert.equal(independentReports([wire('BBC'), wire('Forbes'), { ...sig('NVDA', 'Al Jazeera', 'bullish'), storyId: 'aj-7' }]), 2);

  const [syndicated] = buildConsensus([wire('BBC'), wire('Forbes'), wire('Wall Street Journal')], { totalSources: 7 });
  assert.equal(syndicated.sourceCount, 1);
  assert.equal(syndicated.outletCount, 3);
  assert.deepEqual(selectCandidates([syndicated], { minSources: 2, minCandidates: 0 }), []);
});

test('forecast score rewards aligned moves that are still ahead, not ones priced in', async () => {
  const { forecastScore } = await import('../src/aggregate.js');
  const ev = (status, remainingPct, extra = {}) => ({ direction: 'up', status, confidence: 'high', expectedMovePct: 10, remainingPct, ...extra });
  assert.equal(forecastScore({ stance: 'bullish', events: [ev('ahead of the move', 10)] }), 1);
  assert.equal(forecastScore({ stance: 'bullish', events: [ev('underway', 5, { confidence: 'medium' })] }), 0.35);
  assert.equal(forecastScore({ stance: 'bullish', events: [ev('priced in', 1)] }), 0);
  assert.equal(forecastScore({ stance: 'bearish', events: [ev('ahead of the move', 10)] }), 0);
  assert.equal(forecastScore({ stance: 'bullish' }), 0);
});
