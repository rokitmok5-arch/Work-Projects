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
  news_consensus: z.string().describe('Which outlets agree, and on what'),
  market_confirmation: z.string().describe('What the price action says, citing the metrics'),
  catalysts: z.array(z.string()),
  key_risks: z.array(z.string()),
  entry_note: z.string().describe('Practical guidance, e.g. scale in over weeks, wait for a pullback toward the 50-day average'),
});

const AdviceSchema = z.object({
  market_overview: z.string().describe('One paragraph on the macro and geopolitical backdrop driving today\'s picks'),
  key_themes: z.array(z.object({ theme: z.string(), implication: z.string() })),
  recommendations: z.array(RecommendationSchema),
  avoid: z.array(
    z.object({ symbol: z.string(), name: z.string(), reason: z.string() }),
  ).describe('Assets where the news consensus and price action are negative'),
  cash_allocation_pct: z.number(),
  portfolio_notes: z.string().describe('Diversification, correlation, and sizing notes for this investor'),
});

const SYSTEM_PROMPT = `You are a disciplined investment research analyst producing a personal advisory brief. Your inputs are (1) a consensus of investable signals extracted from recent reporting by BBC, Al Jazeera, Business Insider, Forbes, The New York Times, The Wall Street Journal and the Associated Press, and (2) live market metrics for each candidate.

How to decide:
- Rank candidates by the strength of cross-outlet agreement AND whether the market is confirming it. A thesis reported by several independent outlets and confirmed by price trend outranks one reported widely but contradicted by the market; say so when you rank a contradicted name, and explain why.
- Treat an RSI above 75 or a large 1-month run-up as elevated entry risk: lower the action to "accumulate" or "watch" and say so in entry_note, rather than dropping a well-corroborated idea.
- Fit the investor profile: respect their risk tolerance, time horizon, preferred and excluded asset classes, excluded symbols, and existing holdings (avoid piling into what they already hold heavily).
- Diversify: avoid concentrating the list in one sector or one theme, and include ETFs where a theme is better held as a basket.
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
    composite_score: c.compositeScore,
  };
}

export async function generateAdvice({ candidates, themes, backdrop, profile, minPicks = 10, maxPicks = 20, client }) {
  const system = SYSTEM_PROMPT.replace('{MIN}', minPicks).replace('{MAX}', maxPicks);
  const prompt = [
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
    `<investor_profile>\n${JSON.stringify(profile, null, 2)}\n</investor_profile>`,
    `<market_backdrop>\n${JSON.stringify(backdrop, null, 2)}\n</market_backdrop>`,
    `<top_themes>\n${JSON.stringify(themes, null, 2)}\n</top_themes>`,
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
      return { ...r, symbol: c.symbol, rank: i + 1, sources: c.sources, evidence: c.evidence, market: c.market };
    });

  if (recommendations.length < minPicks) {
    warnings.push(`Only ${recommendations.length} recommendations met the bar (target ${minPicks}-${maxPicks}).`);
  }
  const allocated = recommendations.reduce((s, r) => s + r.suggested_allocation_pct, 0) + advice.cash_allocation_pct;
  if (Math.abs(allocated - 100) > 1) warnings.push(`Allocations sum to ${allocated.toFixed(1)}%, not 100%.`);

  return { ...advice, recommendations, warnings };
}
