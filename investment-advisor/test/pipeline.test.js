import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPipeline, saveReport } from '../src/pipeline.js';
import { chartPayload, jsonResponse, sampleFeedXml } from './helpers.js';

process.env.ADVISOR_QUIET = '1';

const config = {
  sources: ['BBC', 'Forbes', 'Wall Street Journal'].map((name, i) => ({
    id: `s${i}`, name, fullText: false, feeds: [`https://feeds.example.com/${i}`],
  })),
  marketMap: { 'US equities': { SPY: 'S&P 500' }, Commodities: { 'GC=F': 'Gold' } },
};

function fakeFetch(url) {
  if (url.startsWith('https://feeds.example.com/')) return new Response(sampleFeedXml());
  const symbol = decodeURIComponent(url.split('/chart/')[1].split('?')[0]);
  if (symbol === 'FAKE') return jsonResponse({ chart: { result: null, error: { description: 'Not Found' } } }, 404);
  const drift = { INTC: -0.003, SPY: 0, 'GC=F': 0.03 }[symbol] ?? 0.003; // SPY flat, gold makes an outsized move
  return jsonResponse(chartPayload(symbol, { dailyDrift: drift }));
}

/**
 * Stand-in for the Anthropic client. It answers the extraction and advice
 * prompts deterministically and validates every answer through the request's
 * own output_config.format, so schema/SDK mismatches fail the test.
 */
function fakeClient(calls) {
  return {
    beta: {
      messages: {
        stream(params) {
          calls.push(params);
          const prompt = params.messages[0].content;
          let answer;
          if (prompt.startsWith('Identify the market-relevant global events')) {
            const hormuz = [...prompt.matchAll(/\[([^\]]+)\] \([^)]*\) Naval clashes/g)].map((m) => m[1]);
            answer = {
              events: [
                {
                  name: 'Strait of Hormuz tensions', summary: 's', category: 'geopolitics_conflict', regions: ['Middle East'],
                  severity: 4, article_ids: [...hormuz, 'unknown-id'], outlook: 'o',
                  channels: [
                    { symbol: 'ita', name: 'Aerospace & Defense ETF', asset_class: 'etf', direction: 'up', order: 'second', mechanism: 'Conflict -> defense budgets' },
                    { symbol: 'CL=F', name: 'WTI Crude', asset_class: 'commodity', direction: 'up', order: 'first', mechanism: 'Supply risk' },
                  ],
                },
                { name: 'Uncovered event', summary: 's', category: 'macro_data', regions: [], severity: 2, article_ids: ['nope'], outlook: 'o', channels: [] },
              ],
            };
          } else if (prompt.startsWith('Extract investable signals')) {
            const articles = [...prompt.matchAll(/<article id="([^"]+)"[^>]*>\nTitle: (.*)/g)];
            answer = {
              articles: articles.map(([, id, title]) => ({
                article_id: id,
                themes: [title.includes('Oil') ? 'Red Sea shipping disruption' : 'AI capex boom'],
                signals: title.includes('Naval') ? [] : title.includes('Chipmakers')
                  ? [
                      { entity_name: 'Nvidia', symbol: 'nvda', asset_class: 'stock', sentiment: 'bullish', strength: 5, direct: true, rationale: 'Capex up' },
                      { entity_name: 'Intel', symbol: 'INTC', asset_class: 'stock', sentiment: 'bearish', strength: 3, direct: false, rationale: 'Losing share' },
                      { entity_name: 'Fake Co', symbol: 'FAKE', asset_class: 'stock', sentiment: 'bullish', strength: 2, direct: true, rationale: 'n/a' },
                    ]
                  : [{ entity_name: 'WTI Crude', symbol: 'CL=F', asset_class: 'commodity', sentiment: 'bullish', strength: 4, direct: true, rationale: 'Supply risk' }],
              })),
            };
          } else {
            const candidates = JSON.parse(prompt.match(/<candidates[^>]*>\n([\s\S]*?)\n<\/candidates>/)[1]);
            const bullish = candidates.filter((c) => c.news.stance === 'bullish');
            answer = {
              market_overview: 'AI spending and oil supply risk dominate.',
              event_analysis: [{ event: 'Strait of Hormuz tensions', implication: 'Oil and defense up', market_read: 'Oil reacting, defense lagging' }],
              recommendations: [
                ...bullish.map((c, i) => ({
                  rank: i + 1, symbol: c.symbol, name: c.name, asset_class: c.asset_class, action: 'buy', conviction: 'medium',
                  time_horizon: 'medium_term', suggested_allocation_pct: 20, thesis: 't', news_consensus: 'n', market_confirmation: 'm',
                  causal_chain: c.linked_events.length ? 'Hormuz -> defense' : 'company-specific', event_links: c.linked_events.map((e) => e.event),
                  catalysts: ['c'], key_risks: ['r'], entry_note: 'e',
                })),
                { rank: 99, symbol: 'MADEUP', name: 'Invented', asset_class: 'stock', action: 'buy', conviction: 'low', time_horizon: 'short_term',
                  suggested_allocation_pct: 0, thesis: 't', news_consensus: 'n', market_confirmation: 'm', causal_chain: 'x', event_links: [],
                  catalysts: [], key_risks: [], entry_note: 'e' },
              ],
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

test('runPipeline goes from feeds to a ranked, validated report', async () => {
  const calls = [];
  const report = await runPipeline({
    config,
    profile: { risk_tolerance: 'moderate', excluded_symbols: [] },
    fetchImpl: async (url) => fakeFetch(url),
    client: fakeClient(calls),
    minPicks: 2,
    maxPicks: 5,
  });

  // Requests use the default model, effort per stage, and server-side fallbacks.
  assert.equal(calls.length, 3);
  for (const c of calls) {
    assert.equal(c.model, 'claude-opus-5-5');
    assert.equal(c.fallbacks, 'default');
    assert.deepEqual(c.betas, ['server-side-fallback-2026-07-01']);
  }
  const effortFor = (prefix) => calls.find((c) => c.messages[0].content.startsWith(prefix)).output_config.effort;
  assert.equal(effortFor('Extract investable signals'), 'low');
  assert.equal(effortFor('Identify the market-relevant global events'), 'medium');
  assert.equal(effortFor('Today is'), 'high');

  assert.equal(report.meta.articleCount, 9);
  assert.equal(report.meta.sourcesWithArticles, 3);
  assert.equal(report.meta.eventCount, 1); // the event with no known articles is dropped

  // The world-news-only story reaches the picks through the event map: ITA was never
  // named in an article, but the Hormuz event covered by 3 outlets makes it a candidate.
  const symbols = report.advice.recommendations.map((r) => r.symbol).sort();
  assert.deepEqual(symbols, ['CL=F', 'ITA', 'NVDA']);
  const ita = report.advice.recommendations.find((r) => r.symbol === 'ITA');
  assert.equal(ita.sources.length, 3);
  assert.equal(ita.events[0].event, 'Strait of Hormuz tensions');
  assert.equal(ita.causal_chain, 'Hormuz -> defense');
  const [hormuz] = report.events;
  assert.deepEqual(hormuz.outlets, ['BBC', 'Forbes', 'Wall Street Journal']);
  assert.ok(hormuz.channels.every((c) => ['reacting', 'not yet reflected', 'diverging'].includes(c.reaction)));

  // The market map flags gold's outsized move.
  assert.deepEqual(report.marketMap.anomalies.map((r) => r.symbol), ['GC=F']);
  assert.match(report.markdown, /## Event transmission map/);
  assert.match(report.markdown, /## Market flux/);
  assert.match(report.markdown, /Causal chain:\*\* Hormuz -> defense/);
  assert.ok(report.advice.warnings.some((w) => w.includes('MADEUP')));
  assert.ok(report.advice.warnings.some((w) => w.includes('FAKE')));
  const nvda = report.advice.recommendations.find((r) => r.symbol === 'NVDA');
  assert.equal(nvda.sources.length, 3);
  assert.equal(nvda.market.trend, 'uptrend');
  assert.match(report.markdown, /## Top 3 picks/);
  assert.match(report.markdown, /not personalized financial/);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'advisor-'));
  const files = await saveReport(report, dir);
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'latest.json'), 'utf8'));
  assert.equal(saved.advice.recommendations.length, 3);
  assert.ok((await fs.readFile(files.markdown, 'utf8')).startsWith('# Investment Advisory Brief'));
});

test('excluded symbols never reach the advisor', async () => {
  const calls = [];
  const report = await runPipeline({
    config,
    profile: { excluded_symbols: ['nvda'] },
    fetchImpl: async (url) => fakeFetch(url),
    client: fakeClient(calls),
    minPicks: 1,
  });
  const advisePrompt = calls.find((c) => c.messages[0].content.startsWith('Today is')).messages[0].content;
  assert.ok(!advisePrompt.includes('"symbol": "NVDA"'));
  assert.deepEqual(report.advice.recommendations.map((r) => r.symbol).sort(), ['CL=F', 'ITA']);
});
