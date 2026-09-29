import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectNews } from './news.js';
import { extractSignals } from './extract.js';
import { buildConsensus, selectCandidates, scoreCandidates, topThemes, linkEvents } from './aggregate.js';
import { analyzeEvents, eventSignals, mergeWithMemory, measureForecasts, openTrackedEvents, updateMemory, summarizeScorecard } from './events.js';
import { fetchQuotes, buildMarketMap } from './market.js';
import { generateAdvice } from './advise.js';
import { renderMarkdown } from './report.js';
import { log } from './util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPORTS_DIR = process.env.ADVISOR_REPORTS_DIR || path.join(ROOT, 'reports');

export async function loadJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

export async function loadConfig() {
  return loadJson(path.join(ROOT, 'config', 'sources.json'));
}

const MEMORY_FILE = 'event-memory.json';

/** Events and forecasts carried between runs, so delayed effects stay tracked. */
export async function loadMemory(dir = REPORTS_DIR) {
  try {
    return await loadJson(path.join(dir, MEMORY_FILE));
  } catch (err) {
    if (err.code === 'ENOENT') return { version: 1, events: [], scorecard: { resolved: [] } };
    throw err;
  }
}

export async function loadProfile(file) {
  const candidates = [file, path.join(ROOT, 'profile.json'), path.join(ROOT, 'profile.example.json')].filter(Boolean);
  for (const f of candidates) {
    try {
      return await loadJson(f);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  throw new Error('No investor profile found. Copy profile.example.json to profile.json.');
}

/**
 * Full pipeline:
 *   news (markets + world affairs)
 *     -> Claude: per-article signals  +  Claude: global events and their transmission channels
 *     -> cross-outlet consensus
 *     -> live market data for candidates, event channels and the cross-asset market map
 *     -> each event forecast vs. how far the market has moved since the event broke
 *     -> Claude advisory synthesis -> report
 * Events and forecasts persist between runs (event memory) so slow effects, such
 * as a tariff feeding through to prices over weeks, stay tracked and are graded
 * when their window closes.
 */
export async function runPipeline({
  profile,
  config,
  lookbackHours = 72,
  maxPerSource = 60,
  minSources = 2,
  minPicks = 10,
  maxPicks = 20,
  maxEvents = 15,
  fetchImpl = fetch,
  client,
  memory,
  now = Date.now(),
  onStage = () => {},
} = {}) {
  config ??= await loadConfig();
  profile ??= await loadProfile();
  memory ??= await loadMemory();
  const warnings = [];

  onStage('news');
  const { articles, coverage } = await collectNews(config.sources, { fetchImpl, lookbackHours, maxPerSource });
  if (articles.length === 0) throw new Error('No articles collected from any source. Check network access and config/sources.json.');

  onStage('analyze');
  const [{ signals, themes }, allEvents] = await Promise.all([
    extractSignals(articles, { client }),
    analyzeEvents(articles, { client, tracked: openTrackedEvents(memory) }).catch((err) => {
      warnings.push(`Global event analysis failed: ${err.message}`);
      return [];
    }),
  ]);
  const byImpact = (a, b) => b.independentReports * b.severity - a.independentReports * a.severity;
  const events = mergeWithMemory(allEvents.sort(byImpact).slice(0, maxEvents), memory);
  const evSignals = eventSignals(events, signals);
  if (signals.length + evSignals.length === 0) throw new Error('No investable signals were extracted from the collected articles.');

  onStage('consensus');
  const sourcesWithArticles = coverage.filter((c) => c.articles > 0).length;
  const entities = buildConsensus([...signals, ...evSignals], { totalSources: sourcesWithArticles });
  const excluded = new Set((profile.excluded_symbols ?? []).map((s) => s.toUpperCase()));
  const candidates = selectCandidates(entities.filter((e) => !excluded.has(e.symbol)), {
    minSources,
    maxCandidates: Math.max(40, maxPicks * 2),
  });
  log(`${events.length} global events; ${entities.length} assets mentioned; ${candidates.length} candidates selected`);

  onStage('market');
  const mapSymbols = Object.values(config.marketMap ?? {}).flatMap((group) => Object.keys(group));
  const channelSymbols = events.flatMap((e) => e.channels.map((c) => c.symbol));
  const { quotes, series, failed } = await fetchQuotes(
    [...candidates.map((c) => c.symbol), ...channelSymbols, ...mapSymbols],
    { fetchImpl },
  );
  const marketMap = buildMarketMap(config.marketMap, quotes);
  const measuredEvents = measureForecasts(events, quotes, series, now);
  const nextMemory = updateMemory(measuredEvents, memory, now);
  const scorecard = summarizeScorecard(nextMemory);

  // Drop symbols the market data provider does not recognise; they are usually mis-mapped tickers.
  const priced = candidates.filter((c) => quotes[c.symbol]);
  const scored = scoreCandidates(linkEvents(priced.length >= minPicks ? priced : candidates, measuredEvents), quotes);
  const themeSummary = topThemes(themes);

  onStage('advise');
  const advice = await generateAdvice({
    candidates: scored,
    events: measuredEvents,
    marketMap,
    scorecard,
    themes: themeSummary,
    profile,
    minPicks,
    maxPicks,
    client,
  });
  advice.warnings.push(...warnings);
  const unpriced = failed.filter((s) => !mapSymbols.includes(s));
  if (unpriced.length) advice.warnings.push(`No market data for: ${unpriced.join(', ')}`);

  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      lookbackHours,
      articleCount: articles.length,
      sourcesWithArticles,
      signalCount: signals.length,
      eventCount: events.length,
      trackedEventCount: events.filter((e) => e.continuesTracked).length,
      entityCount: entities.length,
      pricedCount: priced.length,
      coverage,
    },
    profile,
    events: measuredEvents,
    marketMap,
    scorecard,
    themes: themeSummary,
    candidates: scored,
    advice,
    memory: nextMemory,
  };
  report.markdown = renderMarkdown(report);
  onStage('done');
  return report;
}

export async function saveReport(report, dir = REPORTS_DIR) {
  await fs.mkdir(dir, { recursive: true });
  const stamp = report.meta.generatedAt.replace(/[:.]/g, '-');
  const base = path.join(dir, `advice-${stamp}`);
  const { markdown, memory, ...json } = report;
  if (memory) await fs.writeFile(path.join(dir, MEMORY_FILE), JSON.stringify(memory, null, 2));
  await fs.writeFile(`${base}.json`, JSON.stringify(json, null, 2));
  await fs.writeFile(`${base}.md`, markdown);
  await fs.writeFile(path.join(dir, 'latest.json'), JSON.stringify(json, null, 2));
  await fs.writeFile(path.join(dir, 'latest.md'), markdown);
  return { json: `${base}.json`, markdown: `${base}.md` };
}
