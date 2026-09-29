import test from 'node:test';
import assert from 'node:assert/strict';
import { collectNews, parseFeed, googleNewsUrl } from '../src/news.js';
import { sampleFeedXml } from './helpers.js';

process.env.ADVISOR_QUIET = '1';
const source = { id: 'demo', name: 'Demo', feeds: ['https://feeds.example.com/a'], googleNewsQueries: ["site:example.com"] };

test('parseFeed strips HTML and the Google News outlet suffix', async () => {
  const items = await parseFeed(sampleFeedXml(), source);
  assert.equal(items.length, 4);
  assert.equal(items[0].title, 'Chipmakers rally as AI data-centre spending surges');
  assert.equal(items[0].source, 'Demo');
  assert.ok(!items[0].summary.includes('<'));
  assert.match(items[0].id, /^demo-[0-9a-f]{10}$/);
});

test('collectNews drops stale articles and dedupes across feeds', async () => {
  const xml = sampleFeedXml();
  const twoFeeds = { ...source, feeds: ['https://feeds.example.com/a', 'https://feeds.example.com/b'] };
  const { articles, coverage } = await collectNews([twoFeeds], { fetchImpl: async () => new Response(xml), lookbackHours: 48 });
  assert.equal(articles.length, 3);
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
  assert.equal(articles.length, 3);
  assert.equal(coverage[0].usedFallback, true);
  assert.equal(coverage[0].errors.length, 1);
  assert.ok(requested.includes(googleNewsUrl(source.googleNewsQueries[0])));
});

test('balanceFeeds interleaves feeds so no single feed crowds out the rest', async () => {
  const { balanceFeeds } = await import('../src/news.js');
  const mk = (feed, n) => Array.from({ length: n }, (_, i) => ({ id: `${feed}${i}` }));
  const out = balanceFeeds([mk('biz', 10), mk('world', 10), mk('dupe', 0)], 6).map((a) => a.id);
  assert.deepEqual(out, ['biz0', 'world0', 'biz1', 'world1', 'biz2', 'world2']);
});

test('clusterStories links wire copy across outlets but keeps distinct stories apart', async () => {
  const { clusterStories } = await import('../src/news.js');
  const articles = clusterStories([
    { id: 'bbc-1', title: 'Oil prices surge as Iran closes Strait of Hormuz to tankers', summary: '' },
    { id: 'wsj-1', title: 'Oil Prices Surge After Iran Closes Strait of Hormuz to Tankers', summary: '' },
    { id: 'aj-1', title: 'Tehran defends move on shipping lane', summary: 'Iranian officials said the closure of the waterway to commercial tankers was a response to naval patrols and new sanctions on its exports' },
    { id: 'nyt-1', title: 'What the Hormuz closure means', summary: 'Iranian officials said the closure of the waterway to commercial tankers was a response to naval patrols and new sanctions on its exports' },
    { id: 'forbes-1', title: 'Fed holds rates steady amid inflation worries', summary: '' },
  ]);
  const story = Object.fromEntries(articles.map((a) => [a.id, a.storyId]));
  assert.equal(story['bbc-1'], story['wsj-1']);
  assert.equal(story['aj-1'], story['nyt-1']);
  assert.notEqual(story['bbc-1'], story['aj-1']);
  assert.equal(story['forbes-1'], 'forbes-1');
});
