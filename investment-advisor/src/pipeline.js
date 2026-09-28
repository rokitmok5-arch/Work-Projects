import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectNews } from './news.js';
import { extractSignals } from './extract.js';
import { buildConsensus, selectCandidates, scoreCandidates, topThemes } from './aggregate.js';
import { fetchQuotes } from './market.js';
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
 * Full pipeline: news -> Claude signal extraction -> cross-source consensus ->
 * live market data -> Claude advisory synthesis -> report.
 */
export async function runPipeline({
  profile,
  config,
  lookbackHours = 72,
  maxPerSource = 40,
  minSources = 2,
  minPicks = 10,
  maxPicks = 20,
  fetchImpl = fetch,
  client,
  onStage = () => {},
} = {}) {
  config ??= await loadConfig();
  profile ??= await loadProfile();

  onStage('news');
  const { articles, coverage } = await collectNews(config.sources, { fetchImpl, lookbackHours, maxPerSource });
  if (articles.length === 0) throw new Error('No articles collected from any source. Check network access and config/sources.json.');

  onStage('extract');
  const { signals, themes } = await extractSignals(articles, { client });
  if (signals.length === 0) throw new Error('No investable signals were extracted from the collected articles.');

  onStage('consensus');
  const sourcesWithArticles = coverage.filter((c) => c.articles > 0).length;
  const entities = buildConsensus(signals, { totalSources: sourcesWithArticles });
  const excluded = new Set((profile.excluded_symbols ?? []).map((s) => s.toUpperCase()));
  const candidates = selectCandidates(entities.filter((e) => !excluded.has(e.symbol)), {
    minSources,
    maxCandidates: Math.max(40, maxPicks * 2),
  });
  log(`${entities.length} assets mentioned; ${candidates.length} candidates selected`);

  onStage('market');
  const backdropSymbols = Object.keys(config.marketBackdrop ?? {});
  const { quotes, failed } = await fetchQuotes([...candidates.map((c) => c.symbol), ...backdropSymbols], { fetchImpl });
  // Drop symbols the market data provider does not recognise; they are usually mis-mapped tickers.
  const priced = candidates.filter((c) => quotes[c.symbol]);
  const scored = scoreCandidates(priced.length >= minPicks ? priced : candidates, quotes);
  const backdrop = backdropSymbols
    .filter((s) => quotes[s])
    .map((s) => ({ symbol: s, label: config.marketBackdrop[s], ...quotes[s] }));
  const themeSummary = topThemes(themes);

  onStage('advise');
  const advice = await generateAdvice({
    candidates: scored,
    themes: themeSummary,
    backdrop: backdrop.map(({ symbol, label, price, change1dPct, change1moPct, trend }) => ({ symbol, label, price, change1dPct, change1moPct, trend })),
    profile,
    minPicks,
    maxPicks,
    client,
  });
  if (failed.length) advice.warnings.push(`No market data for: ${failed.join(', ')}`);

  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      articleCount: articles.length,
      sourcesWithArticles,
      signalCount: signals.length,
      entityCount: entities.length,
      pricedCount: priced.length,
      coverage,
    },
    profile,
    backdrop,
    themes: themeSummary,
    candidates: scored,
    advice,
  };
  report.markdown = renderMarkdown(report);
  onStage('done');
  return report;
}

export async function saveReport(report, dir = REPORTS_DIR) {
  await fs.mkdir(dir, { recursive: true });
  const stamp = report.meta.generatedAt.replace(/[:.]/g, '-');
  const base = path.join(dir, `advice-${stamp}`);
  const { markdown, ...json } = report;
  await fs.writeFile(`${base}.json`, JSON.stringify(json, null, 2));
  await fs.writeFile(`${base}.md`, markdown);
  await fs.writeFile(path.join(dir, 'latest.json'), JSON.stringify(json, null, 2));
  await fs.writeFile(path.join(dir, 'latest.md'), markdown);
  return { json: `${base}.json`, markdown: `${base}.md` };
}
