import test from 'node:test';
import assert from 'node:assert/strict';
import { eventSignals, measureForecasts, mergeWithMemory, updateMemory, summarizeScorecard, openTrackedEvents } from '../src/events.js';

const DAY = 86400 * 1000;
const T0 = Date.parse('2026-09-01T12:00:00Z');

function channel(symbol, direction, lag, expectedMovePct, extra = {}) {
  return { symbol, name: symbol, asset_class: 'etf', direction, order: 'second', mechanism: 'm', lag, expectedMovePct, confidence: 'high', leadingIndicators: ['x'], baseline: new Date(T0).toISOString(), ...extra };
}

function event(extra = {}) {
  return {
    id: 'evt-hormuz',
    name: 'Strait of Hormuz closure',
    status: 'in_effect',
    severity: 5,
    outlets: ['Al Jazeera', 'BBC', 'Wall Street Journal'],
    outletStories: { 'Al Jazeera': 's1', BBC: 's2', 'Wall Street Journal': 's2' },
    independentReports: 2,
    articleCount: 3,
    firstReported: new Date(T0).toISOString(),
    headlines: [{ source: 'BBC', title: 'Strait closed', link: 'https://example.com/bbc' }],
    ongoing: false,
    channels: [channel('CL=F', 'up', 'weeks', 15), channel('JETS', 'down', 'weeks', 10)],
    ...extra,
  };
}

/** Two daily bars: the close before the event, and the latest close. */
function bars(before, after) {
  return [{ t: (T0 - DAY) / 1000, close: before }, { t: (T0 + DAY) / 1000, close: after }];
}

test('eventSignals spreads an event across outlets, keeping wire-copy story ids', () => {
  const out = eventSignals([event()], [{ symbol: 'CL=F', source: 'BBC' }]);
  const oil = out.filter((s) => s.symbol === 'CL=F');
  assert.deepEqual(oil.map((s) => s.source).sort(), ['Al Jazeera', 'Wall Street Journal']);
  assert.equal(oil.find((s) => s.source === 'Wall Street Journal').storyId, 's2');
  assert.ok(out.every((s) => s.strength === 5 && s.direct === false));
  assert.equal(out.find((s) => s.symbol === 'JETS').sentiment, 'bearish');

  const ongoing = eventSignals([event({ ongoing: true })], []);
  assert.ok(ongoing.every((s) => s.strength === 4 && s.title.startsWith('[Ongoing event]')));
});

test('measureForecasts separates moves still ahead from ones already priced in', () => {
  const now = T0 + 5 * DAY;
  const e = event({
    channels: [
      channel('AHEAD', 'up', 'weeks', 15),
      channel('UNDERWAY', 'up', 'weeks', 15),
      channel('PRICED', 'up', 'weeks', 5),
      channel('AGAINST', 'down', 'weeks', 10),
      channel('STALLED', 'up', 'immediate', 5),
      channel('MISSING', 'up', 'weeks', 5),
    ],
  });
  const quotes = {
    AHEAD: { price: 100.5, dailyVolPct: 1 }, // +0.5%: noise so far, effect expected over weeks
    UNDERWAY: { price: 104, dailyVolPct: 1 }, // +4% of 15%: real move, most still to come
    PRICED: { price: 104.5, dailyVolPct: 1 }, // +4.5% of 5%
    AGAINST: { price: 103, dailyVolPct: 1 }, // forecast down, moved up 3%
    STALLED: { price: 100.2, dailyVolPct: 1 }, // expected within days, nothing after 5 days
  };
  const series = Object.fromEntries(Object.entries(quotes).map(([s, q]) => [s, bars(100, q.price)]));
  const [measured] = measureForecasts([e], quotes, series, now);
  const by = Object.fromEntries(measured.channels.map((c) => [c.symbol, c]));

  assert.equal(by.AHEAD.status, 'ahead of the move');
  assert.equal(by.AHEAD.remainingPct, 14.5);
  assert.equal(by.UNDERWAY.status, 'underway');
  assert.equal(by.UNDERWAY.pricedInPct, 27);
  assert.equal(by.PRICED.status, 'priced in');
  assert.equal(by.AGAINST.status, 'diverging');
  assert.equal(by.AGAINST.movedPct, -3);
  assert.equal(by.STALLED.status, 'not reacting');
  assert.equal(by.MISSING.status, 'no market data');
  assert.equal(by.AHEAD.windowEnds, new Date(T0 + 42 * DAY).toISOString());
  assert.equal(by.AHEAD.daysElapsed, 5);
});

test('mergeWithMemory keeps the original baseline for continued events and carries open ones forward', () => {
  const memory = {
    events: [
      event(),
      { ...event(), id: 'evt-tariff', name: 'China tariffs', channels: [channel('XRT', 'down', 'months', 8)] },
      { ...event(), id: 'evt-done', name: 'Resolved', status: 'resolved' },
    ],
  };
  assert.deepEqual(openTrackedEvents(memory).map((e) => e.id), ['evt-hormuz', 'evt-tariff']);

  const later = new Date(T0 + 10 * DAY).toISOString();
  const fresh = [{
    ...event(),
    continuesTracked: true,
    firstReported: later,
    outlets: ['Forbes'],
    outletStories: { Forbes: 's9' },
    articleCount: 1,
    status: 'escalating',
    channels: [channel('CL=F', 'up', 'weeks', 20, { baseline: later }), channel('ZIM', 'up', 'weeks', 12, { baseline: later })],
  }];
  const merged = mergeWithMemory(fresh, memory);
  const hormuz = merged.find((e) => e.id === 'evt-hormuz');
  assert.equal(hormuz.status, 'escalating');
  assert.equal(hormuz.firstReported, new Date(T0).toISOString());
  assert.deepEqual(hormuz.outlets, ['Al Jazeera', 'BBC', 'Forbes', 'Wall Street Journal']);
  assert.equal(hormuz.independentReports, 3);
  const oil = hormuz.channels.find((c) => c.symbol === 'CL=F');
  assert.equal(oil.baseline, new Date(T0).toISOString()); // measured from the original break
  assert.equal(oil.expectedMovePct, 20); // with the revised forecast
  assert.equal(hormuz.channels.find((c) => c.symbol === 'ZIM').baseline, later);
  assert.ok(hormuz.channels.some((c) => c.symbol === 'JETS')); // not repeated, still tracked

  const tariff = merged.find((e) => e.id === 'evt-tariff');
  assert.equal(tariff.ongoing, true);
  assert.ok(!merged.some((e) => e.id === 'evt-done'));
});

test('updateMemory grades forecasts when their window closes and keeps open ones', () => {
  const now = T0 + 50 * DAY; // past the 42-day "weeks" window, inside the "months" window
  const e = event({ channels: [channel('HIT', 'up', 'weeks', 10), channel('MISS', 'up', 'weeks', 10), channel('OPEN', 'down', 'months', 8)] });
  const quotes = { HIT: { price: 108, dailyVolPct: 1 }, MISS: { price: 99, dailyVolPct: 1 }, OPEN: { price: 97, dailyVolPct: 1 } };
  const series = Object.fromEntries(Object.entries(quotes).map(([s, q]) => [s, bars(100, q.price)]));
  const measured = measureForecasts([e], quotes, series, now);
  const memory = updateMemory(measured, { events: [], scorecard: { resolved: [] } }, now);

  assert.deepEqual(memory.events[0].channels.map((c) => c.symbol), ['OPEN']);
  assert.equal(memory.events[0].channels[0].status, undefined); // measurements are not persisted
  const outcomes = Object.fromEntries(memory.scorecard.resolved.map((r) => [r.symbol, r.outcome]));
  assert.deepEqual(outcomes, { HIT: 'hit', MISS: 'miss' });

  // Grading is idempotent across runs.
  const again = updateMemory(measureForecasts(memory.events, quotes, series, now), memory, now);
  assert.equal(again.scorecard.resolved.length, 2);

  const sc = summarizeScorecard(again);
  assert.equal(sc.graded, 2);
  assert.equal(sc.hits, 1);
  assert.equal(sc.hitRate, 0.5);
  assert.equal(sc.byLag.weeks.misses, 1);
});
