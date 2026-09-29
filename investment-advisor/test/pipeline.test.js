import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPipeline, saveReport } from '../src/pipeline.js';
import { chartPayload, feedXml, jsonResponse } from './helpers.js';

process.env.ADVISOR_QUIET = '1';

// Each outlet writes its own headlines, except the Wall Street Journal, which
// runs BBC's wire copy word for word and so must not count as an extra source.
const HEADLINES = {
  BBC: [
    'Chipmakers rally as AI data-centre spending surges',
    'Oil climbs after shipping disruption in the Red Sea',
    'Naval clashes raise tensions in the Strait of Hormuz',
  ],
  Forbes: [
    'Nvidia leads semiconductor gains on cloud capex boom',
    'Crude prices jump as tankers reroute around Yemen',
    'Warships trade fire near Gulf shipping lanes',
  ],
};
HEADLINES['Wall Street Journal'] = HEADLINES.BBC;

const config = {
  sources: Object.keys(HEADLINES).map((name, i) => ({ id: `s${i}`, name, fullText: false, feeds: [`https://feeds.example.com/${i}`] })),
  marketMap: { 'US equities': { SPY: 'S&P 500' }, Commodities: { 'GC=F': 'Gold' } },
};

const isChip = (t) => /Chipmakers|semiconductor/.test(t);
const isOil = (t) => /Oil climbs|Crude prices/.test(t);
const isHormuz = (t) => /Naval clashes|Warships/.test(t);

function fakeFetch(url) {
  if (url.startsWith('https://feeds.example.com/')) {
    const source = config.sources[Number(url.at(-1))].name;
    return new Response(feedXml(HEADLINES[source].map((title) => ({ title }))));
  }
  const symbol = decodeURIComponent(url.split('/chart/')[1].split('?')[0]);
  if (symbol === 'FAKE') return jsonResponse({ chart: { result: null, error: { description: 'Not Found' } } }, 404);
  const drift = { INTC: -0.003, SPY: 0, 'GC=F': 0.03 }[symbol] ?? 0.003; // SPY flat, gold makes an outsized move
  return jsonResponse(chartPayload(symbol, { dailyDrift: drift }));
}

const signal = (entity_name, symbol, asset_class, sentiment, strength, direct) => ({
  entity_name, symbol, asset_class, sentiment, strength, direct, rationale: 'r',
});

/**
 * Stand-in for the Anthropic client. It answers the extraction, event and
 * advice prompts deterministically and validates every answer through the
 * request's own output_config.format, so schema/SDK mismatches fail the test.
 */
function fakeClient(calls) {
  return {
    beta: {
      messages: {
        stream(params) {
          calls.push(params);
          const prompt = params.messages[0].content;
          let answer;
          if (prompt.startsWith('<tracked_events>')) {
            const trackedId = prompt.match(/<tracked_events>\n\[(evt-[0-9a-f]+)\]/)?.[1] ?? '';
            const hormuz = [...prompt.matchAll(/\[([^\]]+)\] \([^)]*\) (.*)/g)].filter(([, , t]) => isHormuz(t)).map(([, id]) => id);
            answer = {
              events: [
                {
                  tracked_event_id: trackedId, name: 'Strait of Hormuz tensions', summary: 's', category: 'geopolitics_conflict',
                  status: 'escalating', effective_date: '', regions: ['Middle East'], severity: 4, article_ids: [...hormuz, 'unknown-id'], outlook: 'o',
                  channels: [
                    { symbol: 'ita', name: 'Aerospace & Defense ETF', asset_class: 'etf', direction: 'up', order: 'second', mechanism: 'Conflict -> defense budgets',
                      lag: 'months', expected_move_pct: 8, confidence: 'medium', leading_indicators: ['defense budget votes'] },
                    { symbol: 'CL=F', name: 'WTI Crude', asset_class: 'commodity', direction: 'up', order: 'first', mechanism: 'Supply risk',
                      lag: 'immediate', expected_move_pct: -6, confidence: 'high', leading_indicators: ['tanker rates'] },
                  ],
                },
                { tracked_event_id: '', name: 'Uncovered event', summary: 's', category: 'macro_data', status: 'announced', effective_date: '',
                  regions: [], severity: 2, article_ids: ['nope'], outlook: 'o', channels: [] },
              ],
            };
          } else if (prompt.startsWith('Extract investable signals')) {
            const articles = [...prompt.matchAll(/<article id="([^"]+)"[^>]*>\nTitle: (.*)/g)];
            answer = {
              articles: articles.map(([, id, title]) => ({
                article_id: id,
                themes: [isOil(title) ? 'Red Sea shipping disruption' : 'AI capex boom'],
                signals: isChip(title)
                  ? [
                      signal('Nvidia', 'nvda', 'stock', 'bullish', 5, true),
                      signal('Intel', 'INTC', 'stock', 'bearish', 3, false),
                      signal('Fake Co', 'FAKE', 'stock', 'bullish', 2, true),
                    ]
                  : isOil(title)
                    ? [signal('WTI Crude', 'CL=F', 'commodity', 'bullish', 4, true)]
                    : [],
              })),
            };
          } else {
            const candidates = JSON.parse(prompt.match(/<candidates[^>]*>\n([\s\S]*?)\n<\/candidates>/)[1]);
            const bullish = candidates.filter((c) => c.news.stance === 'bullish');
            const rec = (c, i) => ({
              rank: i + 1, symbol: c.symbol, name: c.name, asset_class: c.asset_class, action: 'buy', conviction: 'medium',
              time_horizon: 'medium_term', suggested_allocation_pct: 20, thesis: 't', news_consensus: 'n', market_confirmation: 'm',
              causal_chain: c.linked_event_forecasts.length ? 'Hormuz -> defense' : 'company-specific',
              event_links: c.linked_event_forecasts.map((e) => e.event),
              expected_move_pct: c.linked_event_forecasts.length ? 8 : 0, expected_timing: '1-3 months', watch_signals: ['w'],
              catalysts: ['c'], key_risks: ['r'], entry_note: 'e',
            });
            answer = {
              market_overview: 'AI spending and oil supply risk dominate.',
              event_analysis: [{ event: 'Strait of Hormuz tensions', implication: 'Oil and defense up', market_read: 'Oil reacting, defense lagging', timeline: 'Oil in days, defense over months' }],
              recommendations: [...bullish.map(rec), { ...rec({ symbol: 'MADEUP', name: 'Invented', asset_class: 'stock', linked_event_forecasts: [] }, 98), suggested_allocation_pct: 0 }],
              avoid: [{ symbol: 'INTC', name: 'Intel', reason: 'Bearish consensus in a downtrend' }],
              cash_allocation_pct: 100 - bullish.length * 20,
              portfolio_notes: 'Keep crypto small.',
            };
          }
          const parsed = params.output_config.format.parse(JSON.stringify(answer));
          return { finalMessage: async () => ({ stop_reason: 'end_turn', stop_details: null, parsed_output: parsed }) };
        },
      },
    },
  };
}

const emptyMemory = () => ({ version: 1, events: [], scorecard: { resolved: [] } });
const run = (calls, overrides = {}) =>
  runPipeline({
    config,
    profile: { risk_tolerance: 'moderate', excluded_symbols: [] },
    fetchImpl: async (url) => fakeFetch(url),
    client: fakeClient(calls),
    memory: emptyMemory(),
    minPicks: 2,
    maxPicks: 5,
    ...overrides,
  });

test('runPipeline goes from feeds to a ranked, validated report', async () => {
  const calls = [];
  const report = await run(calls);

  // Requests use the default model, effort per stage, and server-side fallbacks.
  assert.equal(calls.length, 3);
  for (const c of calls) {
    assert.equal(c.model, 'claude-opus-5-5');
    assert.equal(c.fallbacks, 'default');
    assert.deepEqual(c.betas, ['server-side-fallback-2026-07-01']);
  }
  const effortFor = (prefix) => calls.find((c) => c.messages[0].content.startsWith(prefix)).output_config.effort;
  assert.equal(effortFor('Extract investable signals'), 'low');
  assert.equal(effortFor('<tracked_events>'), 'medium');
  assert.equal(effortFor('Today is'), 'high');

  assert.equal(report.meta.articleCount, 9);
  assert.equal(report.meta.sourcesWithArticles, 3);
  assert.equal(report.meta.eventCount, 1); // the event with no known articles is dropped

  // Wire copy: WSJ's chip story is BBC's, so three outlets are two independent reports.
  const nvda = report.candidates.find((c) => c.symbol === 'NVDA');
  assert.equal(nvda.outletCount, 3);
  assert.equal(nvda.sourceCount, 2);

  // The world-news-only story reaches the picks through the event map: ITA was never
  // named in an article, but the Hormuz event makes it a candidate.
  const symbols = report.advice.recommendations.map((r) => r.symbol).sort();
  assert.deepEqual(symbols, ['CL=F', 'ITA', 'NVDA']);
  const [hormuz] = report.events;
  assert.deepEqual(hormuz.outlets, ['BBC', 'Forbes', 'Wall Street Journal']);
  assert.equal(hormuz.independentReports, 2);
  assert.equal(hormuz.status, 'escalating');

  // Forecasts: expected moves are stored as magnitudes and measured against prices.
  const ita = report.advice.recommendations.find((r) => r.symbol === 'ITA');
  assert.equal(ita.events[0].lag, 'months');
  assert.equal(ita.events[0].status, 'ahead of the move');
  assert.equal(ita.expected_timing, '1-3 months');
  assert.equal(hormuz.channels.find((c) => c.symbol === 'CL=F').expectedMovePct, 6);
  assert.ok(report.candidates.find((c) => c.symbol === 'ITA').forecastScore > 0);

  assert.deepEqual(report.marketMap.anomalies.map((r) => r.symbol), ['GC=F']);
  assert.ok(report.advice.warnings.some((w) => w.includes('MADEUP')));
  assert.ok(report.advice.warnings.some((w) => w.includes('FAKE')));
  for (const heading of ['## Forecast: moves still ahead', '## Top 3 picks', '## Event transmission map', '## Market flux', '## Forecast track record']) {
    assert.ok(report.markdown.includes(heading), heading);
  }
  assert.match(report.markdown, /not personalized financial/);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'advisor-'));
  const files = await saveReport(report, dir);
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'latest.json'), 'utf8'));
  assert.equal(saved.advice.recommendations.length, 3);
  assert.equal(saved.memory, undefined);
  const memory = JSON.parse(await fs.readFile(path.join(dir, 'event-memory.json'), 'utf8'));
  assert.equal(memory.events[0].name, 'Strait of Hormuz tensions');
  assert.ok((await fs.readFile(files.markdown, 'utf8')).startsWith('# Investment Advisory Brief'));
});

test('a later run continues tracked events and grades forecasts whose window closed', async () => {
  const first = await run([]);
  const calls = [];
  const later = Date.now() + 10 * 86400 * 1000; // after the "immediate" window, inside "months"
  const second = await run(calls, { memory: first.memory, now: later });

  const eventsPrompt = calls.find((c) => c.messages[0].content.startsWith('<tracked_events>')).messages[0].content;
  assert.match(eventsPrompt, /\[evt-[0-9a-f]+\] Strait of Hormuz tensions \(escalating/);

  const [hormuz] = second.events;
  assert.equal(hormuz.id, first.events[0].id);
  assert.equal(second.meta.trackedEventCount, 1);
  assert.equal(hormuz.firstReported, first.events[0].firstReported);

  // CL=F's "immediate" forecast is graded; ITA's "months" forecast stays open.
  assert.deepEqual(second.memory.scorecard.resolved.map((r) => r.symbol), ['CL=F']);
  assert.deepEqual(second.memory.events[0].channels.map((c) => c.symbol), ['ITA']);
  assert.equal(second.scorecard.graded, 1);
  assert.match(second.markdown, /1 forecasts graded/);
});

test('excluded symbols never reach the advisor', async () => {
  const calls = [];
  const report = await run(calls, { profile: { excluded_symbols: ['nvda'] } });
  const advisePrompt = calls.find((c) => c.messages[0].content.startsWith('Today is')).messages[0].content;
  assert.ok(!advisePrompt.includes('"symbol": "NVDA"'));
  assert.deepEqual(report.advice.recommendations.map((r) => r.symbol).sort(), ['CL=F', 'ITA']);
});
