import { z } from 'zod';
import { callStructured } from './llm.js';
import { moveSince } from './market.js';
import { log } from './util.js';

const ChannelSchema = z.object({
  symbol: z.string().describe('Yahoo Finance ticker of an asset this event moves'),
  name: z.string(),
  asset_class: z.enum(['stock', 'etf', 'crypto', 'commodity', 'bond', 'currency']),
  direction: z.enum(['up', 'down']).describe('Expected price direction as a result of this event'),
  order: z.enum(['first', 'second', 'third']).describe('first = directly hit; second/third = knock-on effects'),
  mechanism: z.string().describe('The causal chain in one sentence, e.g. "Houthi attacks -> Suez diversions -> longer voyages -> higher tanker day rates"'),
});

const EventsSchema = z.object({
  events: z.array(
    z.object({
      name: z.string().describe('Short event name, e.g. "Red Sea shipping attacks"'),
      summary: z.string().describe('What is happening, in 1-2 sentences'),
      category: z.enum([
        'geopolitics_conflict',
        'trade_sanctions',
        'monetary_policy',
        'fiscal_policy',
        'elections_politics',
        'energy_supply',
        'technology',
        'regulation_legal',
        'climate_disaster',
        'public_health',
        'macro_data',
        'corporate',
      ]),
      regions: z.array(z.string()),
      severity: z.number().int().describe('1 = minor, 5 = could reprice whole asset classes'),
      article_ids: z.array(z.string()).describe('Every article (by id) that reports on this event'),
      outlook: z.string().describe('How it could develop next and what would change the market impact'),
      channels: z.array(ChannelSchema),
    }),
  ),
});

const SYSTEM_PROMPT = `You are a global macro strategist. Markets move on world events long before those events appear in business pages, and investors routinely miss the link. Your job is to find that link.

You receive recent headlines from BBC, Al Jazeera, Business Insider, Forbes, The New York Times, The Wall Street Journal and the Associated Press, including their world and politics coverage.

1. Group the articles into distinct real-world events or developments (a conflict escalation, a central bank decision, an election, new tariffs or sanctions, a supply disruption, a policy shift, a disaster). Merge coverage of the same development across outlets; list every article that covers it.
2. Keep the events that plausibly matter to markets, including ones reported only as world or political news. Drop pure human-interest, sport and entertainment stories.
3. For each event, trace its transmission channels: the specific assets it moves and why. Go beyond the obvious first-order effect to second- and third-order effects through supply chains, commodities, currencies, interest rates, trade flows, defense budgets, insurance and shipping, and regional economies. Prefer liquid instruments: large-cap stocks, US-listed sector and country ETFs, major currencies, front-month commodity futures, major cryptocurrencies.
4. Use exact Yahoo Finance tickers (AAPL, ITA, EWZ, EURUSD=X, CL=F, GC=F, BTC-USD). Never invent a ticker; leave a channel out if you are unsure of the symbol.
5. Judge severity by the likely market impact, not by how dramatic the story is.`;

function formatHeadline(a) {
  const text = (a.fullText || a.summary || '').slice(0, 280);
  return `[${a.id}] (${a.source}, ${a.publishedAt?.slice(0, 16) ?? 'undated'}) ${a.title}${text ? ` — ${text}` : ''}`;
}

/**
 * Cluster articles from every outlet into global events and map each event to
 * the assets it moves. Adds coverage (which outlets, when first reported).
 */
export async function analyzeEvents(articles, { client } = {}) {
  log(`mapping global events across ${articles.length} articles`);
  const out = await callStructured({
    client,
    system: SYSTEM_PROMPT,
    prompt: `Identify the market-relevant global events in these ${articles.length} articles and map their transmission channels.\n\n${articles.map(formatHeadline).join('\n')}`,
    schema: EventsSchema,
    effort: 'medium',
  });

  const byId = new Map(articles.map((a) => [a.id, a]));
  return out.events
    .map((e) => {
      const covered = e.article_ids.map((id) => byId.get(id)).filter(Boolean);
      if (covered.length === 0) return null;
      const dates = covered.map((a) => Date.parse(a.publishedAt)).filter(Number.isFinite);
      return {
        name: e.name,
        summary: e.summary,
        category: e.category,
        regions: e.regions,
        severity: Math.min(5, Math.max(1, Math.round(e.severity))),
        outlook: e.outlook,
        outlets: [...new Set(covered.map((a) => a.source))].sort(),
        articleCount: covered.length,
        firstReported: dates.length ? new Date(Math.min(...dates)).toISOString() : null,
        headlines: covered.slice(0, 6).map((a) => ({ source: a.source, title: a.title, link: a.link })),
        channels: e.channels.map((c) => ({ ...c, symbol: c.symbol.trim().toUpperCase() })),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.outlets.length * b.severity - a.outlets.length * a.severity);
}

/**
 * Turn each event's channels into per-outlet signals so global events feed the
 * same cross-outlet consensus as article-level signals. An outlet that already
 * produced a direct article signal for the symbol is not counted twice.
 */
export function eventSignals(events, articleSignals) {
  const already = new Set(articleSignals.map((s) => `${s.symbol}|${s.source}`));
  const out = [];
  for (const e of events) {
    for (const c of e.channels) {
      for (const source of e.outlets) {
        const key = `${c.symbol}|${source}`;
        if (already.has(key)) continue;
        already.add(key);
        out.push({
          entity_name: c.name,
          symbol: c.symbol,
          asset_class: c.asset_class,
          sentiment: c.direction === 'up' ? 'bullish' : 'bearish',
          strength: e.severity,
          direct: c.order === 'first',
          rationale: `${e.name}: ${c.mechanism}`,
          source,
          title: `[Event] ${e.name}`,
          link: e.headlines.find((h) => h.source === source)?.link ?? null,
        });
      }
    }
  }
  return out;
}

/**
 * Compare each channel's predicted direction with how the asset has actually
 * moved since the event first hit the news, scaled by the asset's normal
 * volatility:
 *   reacting          - moved the predicted way by more than a normal move
 *   not yet reflected - little move so far; the market may be lagging the news
 *   diverging         - moved against the prediction; the thesis may be wrong or overwhelmed
 */
export function measureReactions(events, quotes, series) {
  return events.map((e) => ({
    ...e,
    channels: e.channels.map((c) => {
      const q = quotes[c.symbol];
      const s = series[c.symbol];
      if (!q || !s || !e.firstReported) return { ...c, reaction: 'no market data' };
      const move = moveSince(s, e.firstReported, { price: q.price, dailyVolPct: q.dailyVolPct });
      if (!move || move.z == null) return { ...c, reaction: 'no market data' };
      const aligned = (c.direction === 'up' ? 1 : -1) * move.z;
      const reaction = aligned >= 1 ? 'reacting' : aligned <= -1 ? 'diverging' : 'not yet reflected';
      return { ...c, reaction, moveSincePct: move.changePct, moveZ: move.z, tradingDays: move.bars };
    }),
  }));
}
