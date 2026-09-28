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
  marketBackdrop: { SPY: 'S&P 500 ETF' },
};

function fakeFetch(url) {
  if (url.startsWith('https://feeds.example.com/')) return new Response(sampleFeedXml());
  const symbol = decodeURIComponent(url.split('/chart/')[1].split('?')[0]);
  if (symbol === 'FAKE') return jsonResponse({ chart: { result: null, error: { description: 'Not Found' } } }, 404);
  return jsonResponse(chartPayload(symbol, { dailyDrift: symbol === 'INTC' ? -0.003 : 0.003 }));
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
          if (prompt.startsWith('Extract investable signals')) {
            const articles = [...prompt.matchAll(/<article id="([^"]+)"[^>]*>\nTitle: (.*)/g)];
            answer = {
              articles: articles.map(([, id, title]) => ({
                article_id: id,
                themes: [title.includes('Oil') ? 'Red Sea shipping disruption' : 'AI capex boom'],
                signals: title.includes('Chipmakers')
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
              key_themes: [{ theme: 'AI capex boom', implication: 'Supports chip demand' }],
              recommendations: [
                ...bullish.map((c, i) => ({
                  rank: i + 1, symbol: c.symbol, name: c.name, asset_class: c.asset_class, action: 'buy', conviction: 'medium',
                  time_horizon: 'medium_term', suggested_allocation_pct: 20, thesis: 't', news_consensus: 'n', market_confirmation: 'm',
                  catalysts: ['c'], key_risks: ['r'], entry_note: 'e',
                })),
                { rank: 99, symbol: 'MADEUP', name: 'Invented', asset_class: 'stock', action: 'buy', conviction: 'low', time_horizon: 'short_term',
                  suggested_allocation_pct: 0, thesis: 't', news_consensus: 'n', market_confirmation: 'm', catalysts: [], key_risks: [], entry_note: 'e' },
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
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.equal(c.model, 'claude-opus-5-5');
    assert.equal(c.fallbacks, 'default');
    assert.deepEqual(c.betas, ['server-side-fallback-2026-07-01']);
  }
  assert.equal(calls[0].output_config.effort, 'low');
  assert.equal(calls[1].output_config.effort, 'high');

  assert.equal(report.meta.articleCount, 6);
  assert.equal(report.meta.sourcesWithArticles, 3);
  const symbols = report.advice.recommendations.map((r) => r.symbol).sort();
  assert.deepEqual(symbols, ['CL=F', 'NVDA']);
  assert.ok(report.advice.warnings.some((w) => w.includes('MADEUP')));
  assert.ok(report.advice.warnings.some((w) => w.includes('FAKE')));
  const nvda = report.advice.recommendations.find((r) => r.symbol === 'NVDA');
  assert.equal(nvda.sources.length, 3);
  assert.equal(nvda.market.trend, 'uptrend');
  assert.equal(report.backdrop[0].symbol, 'SPY');
  assert.match(report.markdown, /## Top 2 picks/);
  assert.match(report.markdown, /not personalized financial/);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'advisor-'));
  const files = await saveReport(report, dir);
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'latest.json'), 'utf8'));
  assert.equal(saved.advice.recommendations.length, 2);
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
  assert.ok(!calls[1].messages[0].content.includes('"symbol": "NVDA"'));
  assert.deepEqual(report.advice.recommendations.map((r) => r.symbol), ['CL=F']);
});
