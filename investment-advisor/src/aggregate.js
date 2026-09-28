import { round } from './util.js';

const SENTIMENT_SIGN = { bullish: 1, bearish: -1, neutral: 0 };
const INFERRED_WEIGHT = 0.6;

/**
 * Cross-reference signals by symbol. An asset's news score rewards
 * (a) agreement in direction, (b) the number of distinct outlets reporting it,
 * and (c) signal strength, with diminishing returns on raw mention count so one
 * outlet running ten stories cannot outvote several independent outlets.
 */
export function buildConsensus(signals, { totalSources }) {
  const groups = new Map();
  for (const s of signals) {
    if (!groups.has(s.symbol)) groups.set(s.symbol, []);
    groups.get(s.symbol).push(s);
  }

  const entities = [];
  for (const [symbol, list] of groups) {
    const sources = new Set(list.map((s) => s.source));
    let weighted = 0;
    let totalWeight = 0;
    const counts = { bullish: 0, bearish: 0, neutral: 0 };
    for (const s of list) {
      const w = s.strength * (s.direct ? 1 : INFERRED_WEIGHT);
      weighted += SENTIMENT_SIGN[s.sentiment] * w;
      totalWeight += w;
      counts[s.sentiment]++;
    }
    const netSentiment = totalWeight ? weighted / totalWeight : 0; // -1..1
    const sourceCoverage = sources.size / Math.max(totalSources, 1); // 0..1
    const newsScore = netSentiment * Math.sqrt(sourceCoverage) * (1 + Math.log(list.length)) * (totalWeight / list.length / 5);

    const names = list.map((s) => s.entity_name);
    const assetClasses = list.map((s) => s.asset_class);
    entities.push({
      symbol,
      name: mode(names),
      assetClass: mode(assetClasses),
      mentions: list.length,
      sourceCount: sources.size,
      sources: [...sources].sort(),
      sentimentCounts: counts,
      netSentiment: round(netSentiment),
      stance: netSentiment > 0.15 ? 'bullish' : netSentiment < -0.15 ? 'bearish' : 'mixed',
      newsScore: round(newsScore, 3),
      evidence: list
        .sort((a, b) => b.strength - a.strength)
        .slice(0, 8)
        .map((s) => ({
          source: s.source,
          title: s.title,
          link: s.link,
          sentiment: s.sentiment,
          strength: s.strength,
          direct: s.direct,
          rationale: s.rationale,
        })),
    });
  }
  return entities.sort((a, b) => Math.abs(b.newsScore) - Math.abs(a.newsScore));
}

function mode(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/**
 * Keep the entities worth pricing: those corroborated by at least `minSources`
 * outlets, topped up with single-source names if too few qualify.
 */
export function selectCandidates(entities, { minSources = 2, maxCandidates = 40, minCandidates = 25 } = {}) {
  const directional = entities.filter((e) => e.stance !== 'mixed');
  const corroborated = directional.filter((e) => e.sourceCount >= minSources);
  const picked = corroborated.slice(0, maxCandidates);
  if (picked.length < minCandidates) {
    const rest = directional.filter((e) => e.sourceCount < minSources);
    picked.push(...rest.slice(0, minCandidates - picked.length));
  }
  return picked;
}

/** How the live market agrees or disagrees with the news stance. */
export function marketConfirmation(stance, quote) {
  if (!quote) return 'no market data';
  const momentum = quote.change1moPct ?? 0;
  if (stance === 'bullish') {
    if (quote.trend === 'uptrend' && momentum > 0) return 'confirmed';
    if (quote.trend === 'downtrend' && momentum < 0) return 'contradicted';
  } else if (stance === 'bearish') {
    if (quote.trend === 'downtrend' && momentum < 0) return 'confirmed';
    if (quote.trend === 'uptrend' && momentum > 0) return 'contradicted';
  }
  return 'neutral';
}

const CONFIRMATION_SCORE = { confirmed: 1, neutral: 0.5, contradicted: 0, 'no market data': 0.25 };

/**
 * Attach market data and a composite score (65% news consensus, 35% market
 * confirmation). The composite ranks candidates before Claude's final review.
 */
export function scoreCandidates(candidates, quotes) {
  const maxNews = Math.max(...candidates.map((c) => Math.abs(c.newsScore)), 1e-9);
  return candidates
    .map((c) => {
      const quote = quotes[c.symbol] ?? null;
      const confirmation = marketConfirmation(c.stance, quote);
      const composite = 0.65 * (Math.abs(c.newsScore) / maxNews) + 0.35 * CONFIRMATION_SCORE[confirmation];
      return { ...c, market: quote, confirmation, compositeScore: round(composite, 3) };
    })
    .sort((a, b) => b.compositeScore - a.compositeScore);
}

/** Most frequently reported themes, with the outlets that reported each. */
export function topThemes(themes, limit = 15) {
  const map = new Map();
  for (const { theme, source } of themes) {
    const key = theme.toLowerCase().trim();
    if (!map.has(key)) map.set(key, { theme, count: 0, sources: new Set() });
    const entry = map.get(key);
    entry.count++;
    entry.sources.add(source);
  }
  return [...map.values()]
    .sort((a, b) => b.sources.size - a.sources.size || b.count - a.count)
    .slice(0, limit)
    .map((e) => ({ theme: e.theme, mentions: e.count, sources: [...e.sources].sort() }));
}

/** Attach the global events that move each candidate, with the market's reaction so far. */
export function linkEvents(candidates, events) {
  return candidates.map((c) => ({
    ...c,
    events: events.flatMap((e) =>
      e.channels
        .filter((ch) => ch.symbol === c.symbol)
        .map((ch) => ({
          event: e.name,
          severity: e.severity,
          outlets: e.outlets.length,
          direction: ch.direction,
          order: ch.order,
          mechanism: ch.mechanism,
          reaction: ch.reaction,
          moveSincePct: ch.moveSincePct ?? null,
        })),
    ),
  }));
}
