import { z } from 'zod';
import { callStructured } from './llm.js';
import { chunk, mapLimit, log } from './util.js';

const SignalSchema = z.object({
  entity_name: z.string().describe('Company, fund, coin or commodity name'),
  symbol: z
    .string()
    .describe('Yahoo Finance ticker: AAPL, 7203.T, SPY, XLE, BTC-USD, ETH-USD, GC=F, CL=F, EURUSD=X'),
  asset_class: z.enum(['stock', 'etf', 'crypto', 'commodity', 'bond', 'currency']),
  sentiment: z.enum(['bullish', 'bearish', 'neutral']),
  strength: z.number().int().describe('1 = passing mention, 5 = the article is centrally about a material catalyst'),
  direct: z.boolean().describe('true if the article names this asset; false if it is an inferred beneficiary or casualty'),
  rationale: z.string().describe('One sentence: why this article moves this asset'),
});

const ExtractionSchema = z.object({
  articles: z.array(
    z.object({
      article_id: z.string(),
      themes: z.array(z.string()).describe('Macro or sector themes, e.g. "Fed rate cuts", "Red Sea shipping disruption"'),
      signals: z.array(SignalSchema),
    }),
  ),
});

const SYSTEM_PROMPT = `You are the research desk for a personal investment advisor. You read news articles from global outlets and extract the investable signals each one contains.

For each article:
- List the tradable assets whose outlook the article materially affects: individual stocks, ETFs (sector, country, thematic, bond), cryptocurrencies, commodities and currencies.
- Include second-order effects when the link is strong (for example, a Gulf shipping disruption is bullish for crude oil futures and tanker operators). Mark those direct=false.
- Use the exact Yahoo Finance ticker format. Use liquid, US-listed ETFs when a theme is best expressed as a basket (XLE for US energy, SMH for semiconductors, EWJ for Japan). For crypto use SYMBOL-USD; for commodities use the front-month futures ticker (GC=F gold, CL=F WTI crude, NG=F natural gas).
- Skip assets you cannot map to a real ticker with confidence. Never invent tickers.
- Sentiment is the article's implication for the asset's price over the coming weeks to months, not the article's tone.
- Articles with no investable content get an empty signals list. Most world-news articles still carry macro themes worth recording.

Return one entry per article, using the article_id exactly as given.`;

function formatArticle(a) {
  const body = a.fullText || a.summary || '';
  return [
    `<article id="${a.id}" source="${a.source}" published="${a.publishedAt ?? 'unknown'}">`,
    `Title: ${a.title}`,
    body ? `Text: ${body}` : null,
    '</article>',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Ask Claude to extract investable signals from every article.
 * Returns a flat list of signals, each tagged with its article's source and headline.
 */
export async function extractSignals(articles, { batchSize = 30, concurrency = 3, client } = {}) {
  const byId = new Map(articles.map((a) => [a.id, a]));
  const batches = chunk(articles, batchSize);
  log(`extracting signals from ${articles.length} articles in ${batches.length} batches`);

  const results = await mapLimit(batches, concurrency, async (batch, i) => {
    try {
      const out = await callStructured({
        client,
        system: SYSTEM_PROMPT,
        prompt: `Extract investable signals from these ${batch.length} articles.\n\n${batch.map(formatArticle).join('\n\n')}`,
        schema: ExtractionSchema,
        effort: 'low',
      });
      log(`batch ${i + 1}/${batches.length} done`);
      return out.articles;
    } catch (err) {
      log(`batch ${i + 1}/${batches.length} failed: ${err.message}`);
      return [];
    }
  });

  const signals = [];
  const themes = [];
  for (const entry of results.flat()) {
    const article = byId.get(entry.article_id);
    if (!article) continue;
    for (const t of entry.themes ?? []) themes.push({ theme: t, source: article.source });
    for (const s of entry.signals ?? []) {
      signals.push({
        ...s,
        symbol: s.symbol.trim().toUpperCase(),
        strength: Math.min(5, Math.max(1, Math.round(s.strength))),
        articleId: article.id,
        source: article.source,
        title: article.title,
        link: article.link,
        publishedAt: article.publishedAt,
      });
    }
  }
  return { signals, themes };
}
