import fs from 'node:fs/promises';
import path from 'node:path';
import { REPORTS_DIR } from './pipeline.js';
import { fetchQuotes } from './market.js';
import { loadRules, evaluateRules, planFromSignal } from './rules.js';
import { toMils, milsToString } from './money.js';
import { loadPortfolio, savePlans, PORTFOLIO_PATH } from './portfolio.js';

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Re-evaluate every buy and sell rule against fresh prices without a new
 * Claude analysis. Uses the latest report for the advisor's picks, avoid list,
 * consensus and event forecasts. Fast enough to run every few minutes, which is
 * what makes $0.001 trigger levels meaningful.
 */
export async function runCheck({ fetchImpl = fetch, portfolioPath = PORTFOLIO_PATH, reportsDir = REPORTS_DIR, rules, now = Date.now() } = {}) {
  rules ??= await loadRules();
  const portfolio = await loadPortfolio(portfolioPath);
  if (!portfolio) throw new Error('No portfolio yet. Run `npm run portfolio -- init <cash>` first.');
  const latest = await readJson(path.join(reportsDir, 'latest.json'));

  const symbols = [...portfolio.positions.map((p) => p.symbol), ...(latest?.advice?.recommendations ?? []).map((r) => r.symbol)];
  const { quotes, failed } = await fetchQuotes(symbols, { fetchImpl });
  const result = evaluateRules({
    portfolio,
    advice: latest?.advice,
    candidates: latest?.candidates,
    events: latest?.events,
    quotes,
    rules,
    now,
  });
  await savePlans(result.portfolio, portfolioPath);

  const out = {
    evaluatedAt: result.evaluatedAt,
    reportGeneratedAt: latest?.meta?.generatedAt ?? null,
    pricesAsOf: Object.fromEntries(Object.entries(quotes).map(([s, q]) => [s, q.asOf])),
    unpriced: failed,
    signals: result.signals,
    portfolio: result.valuation,
  };
  await fs.mkdir(reportsDir, { recursive: true });
  await fs.writeFile(path.join(reportsDir, 'signals-latest.json'), JSON.stringify(out, null, 2));
  return out;
}

/**
 * The risk plan to attach to a new position: the stop and target from the most
 * recent BUY signal for the symbol (last check, then last full report), with
 * entry set to the actual fill price. Explicit stop/target values override it.
 * Returns { plan, assetClass, source } where plan may be undefined, in which
 * case the next rule check derives one from volatility.
 */
export async function planForNewBuy({ symbol, price, stop, target, reportsDir = REPORTS_DIR }) {
  let sig = null;
  for (const file of ['signals-latest.json', 'latest.json']) {
    const data = await readJson(path.join(reportsDir, file));
    sig = data?.signals?.find((s) => s.symbol === symbol && s.side === 'BUY') ?? null;
    if (sig) break;
  }
  const fill = milsToString(toMils(price));
  let plan = sig ? { ...planFromSignal(sig), entry: fill, high_water: fill } : undefined;
  if (stop || target) {
    plan = { ...(plan ?? { entry: fill, high_water: fill }) };
    if (stop) Object.assign(plan, { stop: milsToString(toMils(stop)), initial_stop: milsToString(toMils(stop)), stop_bps: undefined });
    if (target) plan.target = milsToString(toMils(target));
  }
  return { plan, assetClass: sig?.assetClass, source: stop || target ? 'manual' : sig ? 'signal' : 'none' };
}
