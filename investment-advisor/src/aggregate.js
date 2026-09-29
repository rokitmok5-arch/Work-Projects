import { round } from './util.js';

const SENTIMENT_SIGN = { bullish: 1, bearish: -1, neutral: 0 };
const INFERRED_WEIGHT = 0.6;

/**
 * How many independent reports back a claim: outlets that only republished the
 * same wire story share one voice. Approximated as the smaller of the number of
 * outlets and the number of distinct underlying stories.
 */
export function independentReports(signals) {
  const outlets = new Set(signals.map((s) => s.source));
  const stories = new Set(signals.map((s) => s.storyId ?? `${s.source}|${s.articleId ?? s.title}`));
  return Math.min(outlets.size, stories.size);
}

/**
 * Cross-reference signals by symbol. An asset's news score rewards
 * (a) agreement in direction, (b) the number of independent reports behind it,
 * and (c) signal strength, with diminishing returns on raw mention count so one
 * outlet running ten stories, or ten outlets running one wire story, cannot
 * outvote several independent outlets.
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
    const independent = independentReports(list);
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
    const sourceCoverage = independent / Math.max(totalSources, 1); // 0..1
    const newsScore = netSentiment * Math.sqrt(sourceCoverage) * (1 + Math.log(list.length)) * (totalWeight / list.length / 5);

    const names = list.map((s) => s.entity_name);
    const assetClasses = list.map((s) => s.asset_class);
    entities.push({
      symbol,
      name: mode(names),
      assetClass: mode(assetClasses),
      mentions: list.length,
      sourceCount: independent,
      outletCount: sources.size,
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
 * independent reports, topped up with single-source names if too few qualify.
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
const CONFIDENCE_WEIGHT = { high: 1, medium: 0.7, low: 0.4 };

/**
 * The predictive part of the score: the best linked event forecast that points
 * the same way as the news stance and still has most of its expected move ahead
 * of it. An effect that is already priced in scores nothing here.
 */
export function forecastScore(candidate) {
  let best = 0;
  for (const ev of candidate.events ?? []) {
    const aligned = (ev.direction === 'up') === (candidate.stance === 'bullish');
    if (!aligned || !['ahead of the move', 'underway'].includes(ev.status)) continue;
    const remaining = ev.expectedMovePct > 0 ? Math.min(1, Math.max(0, ev.remainingPct / ev.expectedMovePct)) : 0;
    best = Math.max(best, CONFIDENCE_WEIGHT[ev.confidence] * remaining);
  }
  return best;
}

/**
 * Attach market data and a composite score: 55% news consensus, 25% market
 * confirmation, 20% forecast (expected move still to come). The composite
 * ranks candidates before Claude's final review.
 */
export function scoreCandidates(candidates, quotes) {
  const maxNews = Math.max(...candidates.map((c) => Math.abs(c.newsScore)), 1e-9);
  return candidates
    .map((c) => {
      const quote = quotes[c.symbol] ?? null;
      const confirmation = marketConfirmation(c.stance, quote);
      const forecast = forecastScore(c);
      const composite = 0.55 * (Math.abs(c.newsScore) / maxNews) + 0.25 * CONFIRMATION_SCORE[confirmation] + 0.2 * forecast;
      return { ...c, market: quote, confirmation, forecastScore: round(forecast), compositeScore: round(composite, 3) };
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

/** Attach the global events that move each candidate, with each forecast and where it stands. */
export function linkEvents(candidates, events) {
  return candidates.map((c) => ({
    ...c,
    events: events.flatMap((e) =>
      e.channels
        .filter((ch) => ch.symbol === c.symbol)
        .map((ch) => ({
          event: e.name,
          eventStatus: e.status,
          effectiveDate: e.effectiveDate,
          ongoing: e.ongoing,
          severity: e.severity,
          outlets: e.outlets.length,
          independentReports: e.independentReports,
          direction: ch.direction,
          order: ch.order,
          mechanism: ch.mechanism,
          lag: ch.lag,
          confidence: ch.confidence,
          expectedMovePct: ch.expectedMovePct,
          movedPct: ch.movedPct ?? null,
          pricedInPct: ch.pricedInPct ?? null,
          remainingPct: ch.remainingPct ?? null,
          status: ch.status,
          since: ch.baseline,
          windowEnds: ch.windowEnds,
          leadingIndicators: ch.leadingIndicators,
        })),
    ),
  }));
}
