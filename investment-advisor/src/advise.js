import { z } from 'zod';
import { callStructured } from './llm.js';

const RecommendationSchema = z.object({
  rank: z.number().int(),
  symbol: z.string().describe('Must be one of the candidate symbols provided'),
  name: z.string(),
  asset_class: z.enum(['stock', 'etf', 'crypto', 'commodity', 'bond', 'currency']),
  action: z.enum(['strong_buy', 'buy', 'accumulate', 'watch']),
  conviction: z.enum(['high', 'medium', 'low']),
  time_horizon: z.enum(['short_term', 'medium_term', 'long_term']).describe('weeks / months / a year or more'),
  suggested_allocation_pct: z.number().describe('Share of the investable amount; all allocations plus cash sum to 100'),
  thesis: z.string().describe('2-4 sentences on why, grounded in the cited reporting'),
  causal_chain: z
    .string()
    .describe('The path from world event to this asset, e.g. "Strait of Hormuz tension -> Gulf crude supply risk -> higher Brent -> integrated oil margins". Use "company-specific" if no global event drives it'),
  event_links: z.array(z.string()).describe('Names of the global events (from the list provided) that drive this pick'),
  news_consensus: z.string().describe('Which outlets agree, and on what'),
  market_confirmation: z.string().describe('What the price action says, citing the metrics'),
  catalysts: z.array(z.string()),
  key_risks: z.array(z.string()),
  entry_note: z.string().describe('Practical guidance, e.g. scale in over weeks, wait for a pullback toward the 50-day average'),
});

const AdviceSchema = z.object({
  market_overview: z
    .string()
    .describe('One or two paragraphs connecting today\'s global events to what is moving across the market map'),
  event_analysis: z.array(
    z.object({
      event: z.string(),
      implication: z.string().describe('Which assets, sectors, regions and currencies it should move, and why'),
      market_read: z.string().describe('What the market has priced in so far, what it has not, and what would change the picture'),
    }),
  ),
  recommendations: z.array(RecommendationSchema),
  avoid: z.array(
    z.object({ symbol: z.string(), name: z.string(), reason: z.string() }),
  ).describe('Assets where the news consensus and price action are negative'),
  cash_allocation_pct: z.number(),
  portfolio_notes: z.string().describe('Diversification, correlation, and sizing notes for this investor'),
});

const SYSTEM_PROMPT = `You are a global macro investment analyst producing a personal advisory brief. Your edge is connecting world events to market moves that most investors look at separately.

Your inputs:
1. Global events clustered from recent BBC, Al Jazeera, Business Insider, Forbes, New York Times, Wall Street Journal and Associated Press reporting, including world and political coverage. Each event has its transmission channels (asset, direction, first/second/third-order, mechanism) and the market's measured reaction since the event entered the news: "reacting" (moved as predicted by more than a normal move), "not yet reflected" (little move so far), or "diverging" (moved against the prediction). Moves are scaled by each asset's own volatility.
2. A cross-asset market map (US sectors, global regions, rates, currencies, commodities, crypto, volatility), with unusually large moves flagged as anomalies.
3. Candidate assets, each with its cross-outlet news consensus, linked events, and live market metrics.
4. The investor's profile.

How to decide:
- Start from the big picture. Explain which events are driving the market map's anomalies and which anomalies no reported event explains. Look for connections across asset classes: oil and airlines, the dollar and emerging markets, yields and growth stocks, conflict and defense, sanctions and commodity rerouting.
- Rank candidates by (a) how widely and independently the thesis is reported, (b) how clear the causal chain from event to asset is, and (c) what the market is saying. A well-corroborated channel that is "not yet reflected" can be an opportunity if the mechanism is sound, but explain why the market may be lagging rather than disagreeing. A channel that is already "reacting" strongly may be mostly priced in. A "diverging" channel means something else is dominating; say what, or lower conviction.
- Treat an RSI above 75 or a large 1-month run-up as elevated entry risk: lower the action to "accumulate" or "watch" and say so in entry_note, rather than dropping a well-corroborated idea.
- Fit the investor profile: respect their risk tolerance, time horizon, preferred and excluded asset classes, excluded symbols, and existing holdings (avoid piling into what they already hold heavily).
- Diversify across events, sectors and regions. Consider hedges: if several picks depend on the same event, say what happens if it reverses, and consider an asset that benefits in that case. Use ETFs when a theme is better held as a basket.
- Only recommend symbols from the candidate list. Cite outlets by name; do not invent facts beyond the evidence and metrics provided.
- Size positions for this investor: higher conviction and lower volatility earn more weight; speculative assets (most crypto, small caps) stay small unless the profile is aggressive. Allocations plus cash_allocation_pct must sum to 100.

Recommend between {MIN} and {MAX} assets, ranked 1..N. Put the clearest bearish consensus names in "avoid".`;

/**
 * Compact representation of a candidate for the prompt: the metrics that matter,
 * plus a few headlines of evidence.
 */
function candidateBrief(c) {
  const m = c.market;
  return {
    symbol: c.symbol,
    name: m?.name ?? c.name,
    asset_class: m?.assetClass ?? c.assetClass,
    news: {
      stance: c.stance,
      net_sentiment: c.netSentiment,
      outlets: c.sources,
      outlet_count: c.sourceCount,
      mentions: c.mentions,
      sentiment_counts: c.sentimentCounts,
      evidence: c.evidence.slice(0, 5).map((e) => `[${e.source}] ${e.title} - ${e.sentiment} (${e.strength}/5): ${e.rationale}`),
    },
    market: m
      ? {
          price: m.price,
          currency: m.currency,
          change_1d_pct: m.change1dPct,
          change_5d_pct: m.change5dPct,
          change_1mo_pct: m.change1moPct,
          change_3mo_pct: m.change3moPct,
          change_1y_pct: m.change1yPct,
          trend: m.trend,
          rsi14: m.rsi14,
          volatility_20d_annualized_pct: m.volatility20dPct,
          volume_vs_20d_avg: m.volumeRatio,
          pct_off_1y_high: m.offHighPct,
        }
      : null,
    market_confirmation: c.confirmation,
    linked_events: c.events ?? [],
    composite_score: c.compositeScore,
  };
}

function eventBrief(e) {
  return {
    event: e.name,
    category: e.category,
    regions: e.regions,
    severity: e.severity,
    outlets: e.outlets,
    articles: e.articleCount,
    first_reported: e.firstReported,
    summary: e.summary,
    outlook: e.outlook,
    channels: e.channels.map((c) => ({
      symbol: c.symbol,
      direction: c.direction,
      order: c.order,
      mechanism: c.mechanism,
      reaction: c.reaction,
      move_since_pct: c.moveSincePct ?? null,
      move_z: c.moveZ ?? null,
    })),
  };
}

export async function generateAdvice({ candidates, events = [], marketMap, themes, profile, minPicks = 10, maxPicks = 20, client }) {
  const system = SYSTEM_PROMPT.replace('{MIN}', minPicks).replace('{MAX}', maxPicks);
  const prompt = [
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
    `<investor_profile>\n${JSON.stringify(profile, null, 2)}\n</investor_profile>`,
    `<global_events count="${events.length}">\n${JSON.stringify(events.map(eventBrief), null, 2)}\n</global_events>`,
    `<market_map>\n${JSON.stringify(marketMap?.rows ?? [])}\n</market_map>`,
    `<market_anomalies note="moves of 1.5+ standard deviations for that asset">\n${JSON.stringify(marketMap?.anomalies ?? [])}\n</market_anomalies>`,
    `<recurring_themes>\n${JSON.stringify(themes, null, 2)}\n</recurring_themes>`,
    `<candidates count="${candidates.length}">\n${JSON.stringify(candidates.map(candidateBrief), null, 2)}\n</candidates>`,
    `Produce the advisory brief.`,
  ].join('\n\n');

  const advice = await callStructured({ client, system, prompt, schema: AdviceSchema, effort: 'high' });

  // Guard against hallucinated tickers: keep only symbols we actually analyzed.
  const known = new Map(candidates.map((c) => [c.symbol, c]));
  const warnings = [];
  const recommendations = advice.recommendations
    .filter((r) => {
      const ok = known.has(r.symbol.toUpperCase());
      if (!ok) warnings.push(`Dropped ${r.symbol}: not among analyzed candidates.`);
      return ok;
    })
    .sort((a, b) => a.rank - b.rank)
    .map((r, i) => {
      const c = known.get(r.symbol.toUpperCase());
      return { ...r, symbol: c.symbol, rank: i + 1, sources: c.sources, evidence: c.evidence, market: c.market, events: c.events ?? [] };
    });

  if (recommendations.length < minPicks) {
    warnings.push(`Only ${recommendations.length} recommendations met the bar (target ${minPicks}-${maxPicks}).`);
  }
  const allocated = recommendations.reduce((s, r) => s + r.suggested_allocation_pct, 0) + advice.cash_allocation_pct;
  if (Math.abs(allocated - 100) > 1) warnings.push(`Allocations sum to ${allocated.toFixed(1)}%, not 100%.`);

  return { ...advice, recommendations, warnings };
}
