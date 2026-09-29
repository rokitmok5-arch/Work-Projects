import Parser from 'rss-parser';
import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import { fetchText, mapLimit, log } from './util.js';

const parser = new Parser();

const MAX_SUMMARY_CHARS = 600;
const MAX_FULLTEXT_CHARS = 2500;

export function googleNewsUrl(query) {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
}

function stripHtml(html = '') {
  return cheerio.load(`<div>${html}</div>`)('div').text().replace(/\s+/g, ' ').trim();
}

function normalizeTitle(title = '') {
  // Google News appends " - Outlet Name"; drop it so duplicates across feeds match.
  return title.replace(/\s+-\s+[^-]{2,60}$/, '').replace(/\s+/g, ' ').trim();
}

function articleId(sourceId, title) {
  return `${sourceId}-${createHash('sha1').update(title.toLowerCase()).digest('hex').slice(0, 10)}`;
}

/** Parse RSS/Atom XML into normalized article records for one source. */
export async function parseFeed(xml, source) {
  const feed = await parser.parseString(xml);
  return (feed.items ?? [])
    .map((item) => {
      const title = normalizeTitle(item.title);
      if (!title) return null;
      const published = item.isoDate || item.pubDate;
      return {
        id: articleId(source.id, title),
        sourceId: source.id,
        source: source.name,
        title,
        link: item.link ?? null,
        publishedAt: published ? new Date(published).toISOString() : null,
        summary: stripHtml(item.contentSnippet || item.content || item.summary || '').slice(0, MAX_SUMMARY_CHARS),
      };
    })
    .filter(Boolean);
}

async function fetchFullText(article, fetchImpl) {
  try {
    const html = await fetchText(article.link, { fetchImpl, timeoutMs: 12000 });
    const $ = cheerio.load(html);
    const text = $('article p, main p')
      .map((_, el) => $(el).text().trim())
      .get()
      .filter((p) => p.length > 40)
      .join(' ');
    return text.slice(0, MAX_FULLTEXT_CHARS) || null;
  } catch {
    return null;
  }
}

async function fetchList(url, source, fetchImpl, errors, label = url) {
  try {
    return await parseFeed(await fetchText(url, { fetchImpl }), source);
  } catch (err) {
    errors.push(`${label}: ${err.message}`);
    return [];
  }
}

/**
 * Take articles round-robin across feeds (newest first within each) so an
 * outlet's world and politics coverage is not crowded out by its business feed.
 */
export function balanceFeeds(lists, max) {
  const queues = lists.map((l) => [...l]);
  const seen = new Set();
  const out = [];
  while (out.length < max && queues.some((q) => q.length)) {
    for (const q of queues) {
      while (q.length) {
        const a = q.shift();
        if (seen.has(a.id)) continue;
        seen.add(a.id);
        out.push(a);
        break;
      }
      if (out.length >= max) break;
    }
  }
  return out;
}

async function fetchSource(source, { fetchImpl, lookbackHours, maxPerSource }) {
  const errors = [];
  let lists = await Promise.all(source.feeds.map((url) => fetchList(url, source, fetchImpl, errors)));

  let usedFallback = false;
  const queries = source.googleNewsQueries ?? [];
  if (lists.every((l) => l.length === 0) && queries.length) {
    usedFallback = true;
    lists = await Promise.all(
      queries.map((q) => fetchList(googleNewsUrl(q), source, fetchImpl, errors, `google-news "${q}"`)),
    );
  }

  const cutoff = Date.now() - lookbackHours * 3600 * 1000;
  const newest = (a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0);
  const fresh = balanceFeeds(
    lists.map((l) => l.filter((a) => !a.publishedAt || Date.parse(a.publishedAt) >= cutoff).sort(newest)),
    maxPerSource,
  );

  if (source.fullText) {
    await mapLimit(fresh.filter((a) => a.link), 4, async (a) => {
      a.fullText = await fetchFullText(a, fetchImpl);
    });
  }

  return {
    source: { id: source.id, name: source.name },
    articles: fresh,
    usedFallback,
    errors,
  };
}

const STOPWORDS = new Set(
  'the and for with from that this into over after amid about says said will would could have has had are was were its their than more new what why how who but not'.split(' '),
);

function tokens(text = '') {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
  );
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * Find articles that are the same underlying story, typically a wire (AP,
 * Reuters) piece republished by several outlets under near-identical
 * headlines or ledes. Each article gets a storyId; outlets that share a
 * storyId are one voice, not independent corroboration.
 */
export function clusterStories(articles, { titleThreshold = 0.6, summaryThreshold = 0.6 } = {}) {
  const parent = articles.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const titleTok = articles.map((a) => tokens(a.title));
  const summaryTok = articles.map((a) => tokens(a.summary));

  for (let i = 0; i < articles.length; i++) {
    for (let j = i + 1; j < articles.length; j++) {
      const sameTitle = titleTok[i].size >= 4 && titleTok[j].size >= 4 && jaccard(titleTok[i], titleTok[j]) >= titleThreshold;
      const sameLede =
        summaryTok[i].size >= 10 && summaryTok[j].size >= 10 && jaccard(summaryTok[i], summaryTok[j]) >= summaryThreshold;
      if (sameTitle || sameLede) parent[find(i)] = find(j);
    }
  }
  articles.forEach((a, i) => (a.storyId = articles[find(i)].id));
  return articles;
}

/**
 * Collect recent articles from every configured source.
 * Returns { articles, coverage } where coverage records per-source counts and errors.
 */
export async function collectNews(sources, { fetchImpl = fetch, lookbackHours = 72, maxPerSource = 60 } = {}) {
  const results = await mapLimit(sources, 4, (s) => fetchSource(s, { fetchImpl, lookbackHours, maxPerSource }));
  const coverage = results.map((r) => ({
    source: r.source.name,
    articles: r.articles.length,
    usedFallback: r.usedFallback,
    errors: r.errors,
  }));
  for (const c of coverage) {
    log(`${c.source}: ${c.articles} articles${c.usedFallback ? ' (Google News fallback)' : ''}`);
    for (const e of c.errors) log(`  ! ${e}`);
  }
  const articles = clusterStories(results.flatMap((r) => r.articles));
  const syndicated = articles.length - new Set(articles.map((a) => a.storyId)).size;
  if (syndicated) log(`${syndicated} articles are republished copies of stories carried by other outlets`);
  return { articles, coverage };
}
