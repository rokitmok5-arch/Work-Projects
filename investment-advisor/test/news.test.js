import test from 'node:test';
import assert from 'node:assert/strict';
import { collectNews, parseFeed, googleNewsUrl } from '../src/news.js';
import { sampleFeedXml } from './helpers.js';

process.env.ADVISOR_QUIET = '1';
const source = { id: 'demo', name: 'Demo', feeds: ['https://feeds.example.com/a'], googleNewsQuery: 'site:example.com' };

test('parseFeed strips HTML and the Google News outlet suffix', async () => {
  const items = await parseFeed(sampleFeedXml(), source);
  assert.equal(items.length, 3);
  assert.equal(items[0].title, 'Chipmakers rally as AI data-centre spending surges');
  assert.equal(items[0].source, 'Demo');
  assert.ok(!items[0].summary.includes('<'));
  assert.match(items[0].id, /^demo-[0-9a-f]{10}$/);
});

test('collectNews drops stale articles and dedupes across feeds', async () => {
  const xml = sampleFeedXml();
  const twoFeeds = { ...source, feeds: ['https://feeds.example.com/a', 'https://feeds.example.com/b'] };
  const { articles, coverage } = await collectNews([twoFeeds], { fetchImpl: async () => new Response(xml), lookbackHours: 48 });
  assert.equal(articles.length, 2);
  assert.equal(coverage[0].usedFallback, false);
});

test('collectNews falls back to Google News when every feed fails', async () => {
  const xml = sampleFeedXml();
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    return url.startsWith('https://news.google.com/') ? new Response(xml) : new Response('nope', { status: 403 });
  };
  const { articles, coverage } = await collectNews([source], { fetchImpl });
  assert.equal(articles.length, 2);
  assert.equal(coverage[0].usedFallback, true);
  assert.equal(coverage[0].errors.length, 1);
  assert.ok(requested.includes(googleNewsUrl(source.googleNewsQuery)));
});
