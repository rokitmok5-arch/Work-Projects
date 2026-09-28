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

async function fetchSource(source, { fetchImpl, lookbackHours, maxPerSource }) {
  const feeds = [...source.feeds];
  let items = [];
  const errors = [];

  for (const url of feeds) {
    try {
      items.push(...(await parseFeed(await fetchText(url, { fetchImpl }), source)));
    } catch (err) {
      errors.push(`${url}: ${err.message}`);
    }
  }

  let usedFallback = false;
  if (items.length === 0 && source.googleNewsQuery) {
    usedFallback = true;
    try {
      items = await parseFeed(await fetchText(googleNewsUrl(source.googleNewsQuery), { fetchImpl }), source);
    } catch (err) {
      errors.push(`google-news fallback: ${err.message}`);
    }
  }

  const cutoff = Date.now() - lookbackHours * 3600 * 1000;
  const seen = new Set();
  const fresh = items
    .filter((a) => !a.publishedAt || Date.parse(a.publishedAt) >= cutoff)
    .filter((a) => (seen.has(a.id) ? false : seen.add(a.id)))
    .sort((a, b) => (Date.parse(b.publishedAt ?? 0) || 0) - (Date.parse(a.publishedAt ?? 0) || 0))
    .slice(0, maxPerSource);

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

/**
 * Collect recent articles from every configured source.
 * Returns { articles, coverage } where coverage records per-source counts and errors.
 */
export async function collectNews(sources, { fetchImpl = fetch, lookbackHours = 72, maxPerSource = 40 } = {}) {
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
  return { articles: results.flatMap((r) => r.articles), coverage };
}
