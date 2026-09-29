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
  expected_move_pct: z
    .number()
    .describe('Expected further price move from here, in percent (negative for a decline), if the thesis plays out; 0 if you cannot estimate it'),
  expected_timing: z
    .string()
    .describe('When the move should land and why, e.g. "2-6 weeks, as the tariff takes effect Nov 1 and importers reprice"'),
  watch_signals: z
    .array(z.string())
    .describe('What would confirm the move is arriving, and what would mean the thesis has failed (exit signals)'),
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
      timeline: z.string().describe('How the effects should unfold from here: what moves in days, weeks and months'),
    }),
  ),
  recommendations: z.array(RecommendationSchema),
  avoid: z.array(
    z.object({ symbol: z.string(), name: z.string(), reason: z.string() }),
  ).describe('Assets where the news consensus and price action are negative'),
  cash_allocation_pct: z.number(),
  portfolio_notes: z.string().describe('Diversification, correlation, and sizing notes for this investor'),
});

const SYSTEM_PROMPT = `You are a global macro investment analyst producing a personal advisory brief. Your edge is connecting world events to market moves that most investors look at separately, and anticipating moves that are still coming rather than chasing ones that already happened.

Your inputs:
1. Global events clustered from recent BBC, Al Jazeera, Business Insider, Forbes, New York Times, Wall Street Journal and Associated Press reporting, including world and political coverage, plus events tracked from earlier runs whose effects are still playing out ("ongoing"). Each event has a status (proposed or threatened, announced, in effect, escalating, de-escalating) and transmission channels. Each channel carries a forecast (direction, lag, expected move, confidence, leading indicators) and a measurement of how far the asset has moved since the event broke, with a status:
   - "ahead of the move": little has happened yet and the effect is still expected to land. This is the predictive window.
   - "underway": moving as forecast with more to come.
   - "priced in": most of the forecast move has already happened.
   - "diverging": moving against the forecast; something else dominates.
   - "not reacting": an effect expected within days has not appeared; the market is skeptical.
   Independent report counts treat outlets republishing the same wire story as one source.
2. A cross-asset market map (US sectors, global regions, rates, currencies, commodities, crypto, volatility), with unusually large moves flagged.
3. Candidate assets, each with its cross-outlet news consensus, linked event forecasts, and live market metrics.
4. The track record of past forecasts, graded when their windows closed.
5. The investor's profile.

How to decide:
- Start from the big picture. Explain which events are driving the market map's anomalies, which anomalies no reported event explains, and how each major event should unfold over the coming days, weeks and months.
- Favor being early over being late. The best ideas are well-corroborated events with a clear causal chain whose slower effects are still "ahead of the move" or only partly "underway": for example, a strait closure already reflected in crude futures but not yet in refiners, shippers or airlines, or a tariff already hitting the named sector but not yet showing up in importers' margins or the targeted currency. Say when the move should land (expected_timing), roughly how big it should be (expected_move_pct), and what would confirm or break it (watch_signals).
- Be skeptical in the right places. A "priced in" effect needs a new catalyst to justify buying. A "diverging" or "not reacting" channel means the market disagrees; either explain why it is wrong or lower conviction. A proposed or threatened policy may never be enacted; size for that probability. Calibrate confidence to the track record: if past forecasts at a given lag missed often, say so and be more conservative.
- Treat an RSI above 75 or a large 1-month run-up as elevated entry risk: lower the action to "accumulate" or "watch" and say so in entry_note, rather than dropping a well-corroborated idea.
- Fit the investor profile: respect their risk tolerance, time horizon, preferred and excluded asset classes, excluded symbols, and existing holdings (avoid piling into what they already hold heavily).
- Diversify across events, sectors and regions. Consider hedges: if several picks depend on the same event, say what happens if it reverses, and consider an asset that benefits in that case. Use ETFs when a theme is better held as a basket.
- Only recommend symbols from the candidate list. Cite outlets by name; do not invent facts beyond the evidence and metrics provided. Forecasts are estimates, not certainties; word them that way.
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
      outlet_count: c.outletCount ?? c.sources.length,
      independent_reports: c.sourceCount,
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
    linked_event_forecasts: c.events ?? [],
    forecast_score: c.forecastScore,
    composite_score: c.compositeScore,
  };
}

function eventBrief(e) {
  return {
    event: e.name,
    category: e.category,
    status: e.status,
    effective_date: e.effectiveDate,
    ongoing_from_earlier_runs: e.ongoing,
    regions: e.regions,
    severity: e.severity,
    outlets: e.outlets,
    independent_reports: e.independentReports,
    first_reported: e.firstReported,
    summary: e.summary,
    outlook: e.outlook,
    channels: e.channels.map((c) => ({
      symbol: c.symbol,
      direction: c.direction,
      order: c.order,
      mechanism: c.mechanism,
      lag: c.lag,
      confidence: c.confidence,
      expected_move_pct: c.expectedMovePct,
      moved_so_far_pct: c.movedPct ?? null,
      priced_in_pct: c.pricedInPct ?? null,
      status: c.status,
      days_since_event: c.daysElapsed,
      window_ends: c.windowEnds,
      leading_indicators: c.leadingIndicators,
    })),
  };
}

export async function generateAdvice({ candidates, events = [], marketMap, scorecard, themes, profile, minPicks = 10, maxPicks = 20, client }) {
  const system = SYSTEM_PROMPT.replace('{MIN}', minPicks).replace('{MAX}', maxPicks);
  const prompt = [
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
    `<investor_profile>\n${JSON.stringify(profile, null, 2)}\n</investor_profile>`,
    `<global_events count="${events.length}">\n${JSON.stringify(events.map(eventBrief), null, 2)}\n</global_events>`,
    `<market_map>\n${JSON.stringify(marketMap?.rows ?? [])}\n</market_map>`,
    `<market_anomalies note="moves of 1.5+ standard deviations for that asset">\n${JSON.stringify(marketMap?.anomalies ?? [])}\n</market_anomalies>`,
    `<forecast_track_record>\n${JSON.stringify(scorecard ?? { graded: 0 }, null, 2)}\n</forecast_track_record>`,
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
