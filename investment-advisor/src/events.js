import { z } from 'zod';
import { createHash } from 'node:crypto';
import { callStructured } from './llm.js';
import { moveSince } from './market.js';
import { log, round } from './util.js';

/** Calendar days a forecast stays open, by how long the effect takes to reach prices. */
export const LAG_DAYS = { immediate: 7, weeks: 42, months: 180, long_term: 365 };
const DAY_MS = 86400 * 1000;

const ChannelSchema = z.object({
  symbol: z.string().describe('Yahoo Finance ticker of an asset this event moves'),
  name: z.string(),
  asset_class: z.enum(['stock', 'etf', 'crypto', 'commodity', 'bond', 'currency']),
  direction: z.enum(['up', 'down']).describe('Expected price direction as a result of this event'),
  order: z.enum(['first', 'second', 'third']).describe('first = directly hit; second/third = knock-on effects'),
  mechanism: z.string().describe('The causal chain in one sentence, e.g. "Houthi attacks -> Suez diversions -> longer voyages -> higher tanker day rates"'),
  lag: z
    .enum(['immediate', 'weeks', 'months', 'long_term'])
    .describe('When the bulk of the price effect should land: immediate (days), weeks (1-6), months (1-6), long_term (6+ months)'),
  expected_move_pct: z.number().describe('Your best estimate of the total price move (a positive percentage) once the effect has fully landed'),
  confidence: z.enum(['high', 'medium', 'low']),
  leading_indicators: z
    .array(z.string())
    .describe('Observable signs that the effect is arriving or fading, e.g. "tanker day rates", "import price index", "Brent-WTI spread"'),
});

const EventsSchema = z.object({
  events: z.array(
    z.object({
      tracked_event_id: z
        .string()
        .describe('If this is a continuation of one of the tracked events, its id exactly; otherwise an empty string'),
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
      status: z
        .enum(['proposed_or_threatened', 'announced', 'in_effect', 'escalating', 'de_escalating', 'resolved'])
        .describe('Where the event stands. A threatened tariff and one in effect move markets on different timelines'),
      effective_date: z.string().describe('ISO date the policy or measure takes effect, if reported; otherwise an empty string'),
      regions: z.array(z.string()),
      severity: z.number().int().describe('1 = minor, 5 = could reprice whole asset classes'),
      article_ids: z.array(z.string()).describe('Every article (by id) that reports on this event'),
      outlook: z.string().describe('How it could develop next and what would change the market impact'),
      channels: z.array(ChannelSchema),
    }),
  ),
});

const SYSTEM_PROMPT = `You are a global macro strategist. Markets move on world events, often with a delay, and investors routinely miss the link. Your job is to find that link and to forecast price moves before they fully happen.

You receive recent headlines from BBC, Al Jazeera, Business Insider, Forbes, The New York Times, The Wall Street Journal and the Associated Press, including their world and politics coverage, plus a list of events you are already tracking from earlier runs.

1. Group the articles into distinct real-world events or developments (a conflict escalation, a central bank decision, an election, new tariffs or sanctions, a supply disruption, a bill advancing, a disaster). Merge coverage of the same development across outlets; list every article that covers it. When articles continue a tracked event, return it under the tracked event's id so its forecasts stay continuous, and update its status.
2. Keep the events that plausibly matter to markets, including ones reported only as world or political news. Drop pure human-interest, sport and entertainment stories.
3. For each event, trace its transmission channels: the specific assets it moves and why. Go beyond the obvious first-order effect to second- and third-order effects through supply chains, input costs and consumer prices, commodities, currencies, interest rates, trade flows, defense budgets, insurance and shipping, and regional economies.
4. Forecast the timing and size of each channel, because many effects arrive with a lag:
   - Sentiment and positioning react in days: futures, currencies, volatility, the most directly exposed stocks.
   - Physical and policy effects arrive over weeks to months: a strait closure first moves oil futures, then over the following weeks refined products, shipping and insurance rates, airline fuel costs and inflation expectations; a tariff moves the named sector at once, then over weeks to months shows up in importers' input costs and margins, consumer prices, domestic competitors' pricing power, and the targeted country's currency and exporters.
   - Status matters: a proposed or threatened measure is partly priced on probability; the rest arrives when it is enacted and takes effect. Use effective dates when reported.
   Estimate expected_move_pct as the total move once the effect lands, sized to the asset's usual volatility and the shock's magnitude, and give leading indicators that would show the effect arriving or fading.
5. Prefer liquid instruments: large-cap stocks, US-listed sector and country ETFs, major currencies, front-month commodity futures, major cryptocurrencies. Use exact Yahoo Finance tickers (AAPL, ITA, EWZ, EURUSD=X, CL=F, GC=F, BTC-USD). Never invent a ticker; leave a channel out if you are unsure of the symbol.
6. Judge severity by the likely market impact, not by how dramatic the story is.`;

function formatHeadline(a) {
  const text = (a.fullText || a.summary || '').slice(0, 280);
  return `[${a.id}] (${a.source}, ${a.publishedAt?.slice(0, 16) ?? 'undated'}) ${a.title}${text ? ` — ${text}` : ''}`;
}

function formatTracked(e) {
  return `[${e.id}] ${e.name} (${e.status}, first reported ${e.firstReported?.slice(0, 10) ?? 'unknown'}): ${e.summary}`;
}

function eventId(name, when) {
  return `evt-${createHash('sha1').update(`${name}|${when}`).digest('hex').slice(0, 10)}`;
}

function toChannel(c, baseline) {
  return {
    symbol: c.symbol.trim().toUpperCase(),
    name: c.name,
    asset_class: c.asset_class,
    direction: c.direction,
    order: c.order,
    mechanism: c.mechanism,
    lag: c.lag,
    expectedMovePct: Math.abs(c.expected_move_pct),
    confidence: c.confidence,
    leadingIndicators: c.leading_indicators,
    baseline,
  };
}

/**
 * Cluster articles from every outlet into global events, map each event to the
 * assets it moves with a timing and size forecast, and record coverage.
 * `tracked` are open events from earlier runs that new articles may continue.
 */
export async function analyzeEvents(articles, { client, tracked = [] } = {}) {
  log(`mapping global events across ${articles.length} articles (${tracked.length} tracked)`);
  const prompt = [
    tracked.length ? `<tracked_events>\n${tracked.map(formatTracked).join('\n')}\n</tracked_events>` : '<tracked_events>none</tracked_events>',
    `Identify the market-relevant global events in these ${articles.length} articles, map their transmission channels and forecast them.`,
    articles.map(formatHeadline).join('\n'),
  ].join('\n\n');
  const out = await callStructured({ client, system: SYSTEM_PROMPT, prompt, schema: EventsSchema, effort: 'medium' });

  const byId = new Map(articles.map((a) => [a.id, a]));
  const trackedIds = new Set(tracked.map((e) => e.id));
  return out.events
    .map((e) => {
      const covered = e.article_ids.map((id) => byId.get(id)).filter(Boolean);
      if (covered.length === 0) return null;
      const dates = covered.map((a) => Date.parse(a.publishedAt)).filter(Number.isFinite);
      const firstReported = dates.length ? new Date(Math.min(...dates)).toISOString() : new Date().toISOString();
      const outletStories = {};
      for (const a of covered) outletStories[a.source] ??= a.storyId ?? a.id;
      const outlets = Object.keys(outletStories).sort();
      return {
        id: trackedIds.has(e.tracked_event_id) ? e.tracked_event_id : eventId(e.name, firstReported),
        continuesTracked: trackedIds.has(e.tracked_event_id),
        name: e.name,
        summary: e.summary,
        category: e.category,
        status: e.status,
        effectiveDate: e.effective_date || null,
        regions: e.regions,
        severity: Math.min(5, Math.max(1, Math.round(e.severity))),
        outlook: e.outlook,
        outlets,
        outletStories,
        independentReports: Math.min(outlets.length, new Set(Object.values(outletStories)).size),
        articleCount: covered.length,
        firstReported,
        lastReported: dates.length ? new Date(Math.max(...dates)).toISOString() : firstReported,
        headlines: covered.slice(0, 6).map((a) => ({ source: a.source, title: a.title, link: a.link })),
        ongoing: false,
        channels: e.channels.map((c) => toChannel(c, firstReported)),
      };
    })
    .filter(Boolean);
}

/** Tracked events whose forecasts are still open and worth re-checking. */
export function openTrackedEvents(memory) {
  return (memory?.events ?? []).filter((e) => e.status !== 'resolved' && e.channels.length > 0);
}

/**
 * Combine this run's events with tracked events from earlier runs.
 * A continued event keeps its original first-reported date and each existing
 * channel keeps its original baseline, so a slow-moving effect is measured
 * from when the event first broke, not from today's headline. Tracked events
 * with no new coverage stay in play (marked ongoing) while their forecasts are open.
 */
export function mergeWithMemory(fresh, memory) {
  const previous = new Map((memory?.events ?? []).map((e) => [e.id, e]));
  const merged = fresh.map((e) => {
    const old = e.continuesTracked ? previous.get(e.id) : null;
    if (!old) return e;
    previous.delete(e.id);
    const oldChannels = new Map(old.channels.map((c) => [c.symbol, c]));
    const outletStories = { ...old.outletStories, ...e.outletStories };
    const outlets = Object.keys(outletStories).sort();
    return {
      ...e,
      firstReported: old.firstReported < e.firstReported ? old.firstReported : e.firstReported,
      outlets,
      outletStories,
      independentReports: Math.min(outlets.length, new Set(Object.values(outletStories)).size),
      articleCount: old.articleCount + e.articleCount,
      channels: [
        ...e.channels.map((c) => (oldChannels.has(c.symbol) ? { ...c, baseline: oldChannels.get(c.symbol).baseline } : c)),
        // Channels the model did not repeat this time stay tracked until their window closes.
        ...old.channels.filter((c) => !e.channels.some((n) => n.symbol === c.symbol)),
      ],
    };
  });
  const carried = openTrackedEvents({ events: [...previous.values()] }).map((e) => ({ ...e, ongoing: true, continuesTracked: true }));
  return [...merged, ...carried];
}

/**
 * Turn each event's channels into per-outlet signals so global events feed the
 * same cross-outlet consensus as article-level signals. An outlet that already
 * produced an article signal for the symbol is not counted twice. Ongoing
 * events with no new coverage count for a little less.
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
          strength: e.ongoing ? Math.max(1, e.severity - 1) : e.severity,
          direct: c.order === 'first',
          rationale: `${e.name}: ${c.mechanism}`,
          source,
          storyId: e.outletStories?.[source],
          title: `${e.ongoing ? '[Ongoing event]' : '[Event]'} ${e.name}`,
          link: e.headlines.find((h) => h.source === source)?.link ?? null,
        });
      }
    }
  }
  return out;
}

/**
 * Compare each channel's forecast with how the asset has actually moved since
 * the event first broke, and classify where it stands:
 *   ahead of the move - little move yet and the effect is still expected to land (the predictive window)
 *   underway          - moving as forecast, but more of the expected move remains
 *   priced in         - has already moved 80%+ of the forecast
 *   diverging         - moving against the forecast; something else is dominating
 *   not reacting      - an effect expected within days has not shown up; the market is skeptical
 *   resolved          - the event itself has been resolved
 * Moves are also sized against the asset's own volatility so noise isn't read as a reaction.
 */
export function measureForecasts(events, quotes, series, now = Date.now()) {
  return events.map((e) => ({
    ...e,
    channels: e.channels.map((c) => {
      const windowEnds = new Date(Date.parse(c.baseline) + LAG_DAYS[c.lag] * DAY_MS).toISOString();
      const daysElapsed = round((now - Date.parse(c.baseline)) / DAY_MS, 1);
      const base = { ...c, windowEnds, daysElapsed };
      const q = quotes[c.symbol];
      const s = series[c.symbol];
      const move = q && s ? moveSince(s, c.baseline, { price: q.price, dailyVolPct: q.dailyVolPct }) : null;
      if (!move || move.z == null) return { ...base, status: 'no market data' };

      const sign = c.direction === 'up' ? 1 : -1;
      const movedPct = round(sign * move.changePct);
      const alignedZ = sign * move.z;
      const pricedInPct = c.expectedMovePct > 0 ? round((100 * movedPct) / c.expectedMovePct, 0) : null;
      const remainingPct = round(Math.max(0, c.expectedMovePct - movedPct));

      let status;
      if (e.status === 'resolved') status = 'resolved';
      else if (alignedZ <= -1) status = 'diverging';
      else if (pricedInPct != null && pricedInPct >= 80) status = 'priced in';
      else if (alignedZ >= 1) status = 'underway';
      else if (c.lag === 'immediate' && daysElapsed >= 3) status = 'not reacting';
      else status = 'ahead of the move';

      return { ...base, status, movedPct, moveZ: move.z, pricedInPct, remainingPct, tradingDays: move.bars };
    }),
  }));
}

/**
 * Grade forecasts whose window has closed and carry the rest forward.
 * hit: moved at least half the forecast in the predicted direction;
 * partial: moved the right way but less; miss: flat or the wrong way.
 */
export function updateMemory(measuredEvents, memory, now = Date.now()) {
  const resolved = [...(memory?.scorecard?.resolved ?? [])];
  const graded = new Set(resolved.map((r) => `${r.eventId}|${r.symbol}`));
  const events = [];

  for (const e of measuredEvents) {
    const open = [];
    for (const c of e.channels) {
      const closed = now >= Date.parse(c.windowEnds);
      if (closed && c.movedPct != null && !graded.has(`${e.id}|${c.symbol}`)) {
        const outcome = c.movedPct >= c.expectedMovePct * 0.5 ? 'hit' : c.movedPct > 0 ? 'partial' : 'miss';
        resolved.push({
          eventId: e.id,
          event: e.name,
          symbol: c.symbol,
          direction: c.direction,
          lag: c.lag,
          confidence: c.confidence,
          expectedMovePct: c.expectedMovePct,
          movedPct: c.movedPct,
          outcome,
          baseline: c.baseline,
          resolvedAt: new Date(now).toISOString(),
        });
        graded.add(`${e.id}|${c.symbol}`);
      } else if (!closed || (c.movedPct == null && now < Date.parse(c.windowEnds) + 30 * DAY_MS)) {
        const { status, movedPct, moveZ, pricedInPct, remainingPct, tradingDays, windowEnds, daysElapsed, ...stored } = c;
        open.push(stored);
      }
    }
    if (e.status !== 'resolved' && open.length) {
      const { ongoing, continuesTracked, ...stored } = e;
      events.push({ ...stored, channels: open });
    }
  }
  return { version: 1, updatedAt: new Date(now).toISOString(), events, scorecard: { resolved: resolved.slice(-300) } };
}

/** Hit rate of past forecasts, overall and by lag, so the advisor can calibrate. */
export function summarizeScorecard(memory) {
  const resolved = memory?.scorecard?.resolved ?? [];
  const tally = (list) => {
    const hits = list.filter((r) => r.outcome === 'hit').length;
    const partial = list.filter((r) => r.outcome === 'partial').length;
    return { graded: list.length, hits, partial, misses: list.length - hits - partial, hitRate: list.length ? round(hits / list.length) : null };
  };
  const byLag = {};
  for (const lag of Object.keys(LAG_DAYS)) {
    const list = resolved.filter((r) => r.lag === lag);
    if (list.length) byLag[lag] = tally(list);
  }
  return { ...tally(resolved), byLag, recent: resolved.slice(-10).reverse() };
}
