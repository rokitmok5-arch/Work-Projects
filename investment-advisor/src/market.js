import { mapLimit, round, USER_AGENT, log } from './util.js';

// Yahoo Finance's public chart endpoint covers stocks, ETFs, crypto (BTC-USD),
// futures (GC=F), indices (^VIX) and FX (EURUSD=X) with no API key.
const CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/';

const INSTRUMENT_CLASS = {
  EQUITY: 'stock',
  ETF: 'etf',
  MUTUALFUND: 'etf',
  CRYPTOCURRENCY: 'crypto',
  FUTURE: 'commodity',
  CURRENCY: 'currency',
  INDEX: 'index',
};

function sma(values, n) {
  if (values.length < n) return null;
  return values.slice(-n).reduce((a, b) => a + b, 0) / n;
}

function pctChange(values, n) {
  if (values.length <= n) return null;
  const base = values[values.length - 1 - n];
  return base ? (values[values.length - 1] / base - 1) * 100 : null;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

function annualizedVolatility(values, n = 20) {
  if (values.length <= n) return null;
  const rets = [];
  for (let i = values.length - n; i < values.length; i++) rets.push(Math.log(values[i] / values[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252) * 100;
}

/** Turn a Yahoo chart payload into a compact set of price/trend metrics. */
export function computeMetrics(chartResult) {
  const meta = chartResult.meta ?? {};
  const quote = chartResult.indicators?.quote?.[0] ?? {};
  const closes = (quote.close ?? []).filter((v) => Number.isFinite(v));
  const volumes = (quote.volume ?? []).filter((v) => Number.isFinite(v));
  if (closes.length < 2) return null;

  const price = Number.isFinite(meta.regularMarketPrice) ? meta.regularMarketPrice : closes.at(-1);
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const high = Math.max(...closes);
  const avgVol20 = volumes.length > 21 ? sma(volumes.slice(0, -1), 20) : null;

  let trend = 'mixed';
  if (sma20 != null && sma50 != null) {
    if (price > sma50 && sma20 > sma50) trend = 'uptrend';
    else if (price < sma50 && sma20 < sma50) trend = 'downtrend';
  }

  return {
    symbol: meta.symbol,
    name: meta.longName || meta.shortName || meta.symbol,
    assetClass: INSTRUMENT_CLASS[meta.instrumentType] ?? meta.instrumentType?.toLowerCase() ?? null,
    exchange: meta.exchangeName ?? null,
    currency: meta.currency ?? null,
    price: round(price, 4),
    change1dPct: round(pctChange(closes, 1)),
    change5dPct: round(pctChange(closes, 5)),
    change1moPct: round(pctChange(closes, 21)),
    change3moPct: round(pctChange(closes, 63)),
    change1yPct: round(pctChange(closes, closes.length - 1)),
    sma20: round(sma20, 4),
    sma50: round(sma50, 4),
    rsi14: round(rsi(closes)),
    volatility20dPct: round(annualizedVolatility(closes)),
    volumeRatio: avgVol20 ? round(volumes.at(-1) / avgVol20) : null,
    offHighPct: round((price / high - 1) * 100),
    trend,
    asOf: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
  };
}

export async function fetchQuote(symbol, { fetchImpl = fetch } = {}) {
  const url = `${CHART_URL}${encodeURIComponent(symbol)}?range=1y&interval=1d`;
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const result = body?.chart?.result?.[0];
  if (!result) throw new Error(body?.chart?.error?.description ?? 'no data');
  const metrics = computeMetrics(result);
  if (!metrics) throw new Error('insufficient price history');
  return metrics;
}

/** Fetch metrics for many symbols. Returns { quotes: {SYMBOL: metrics}, failed: [symbol] }. */
export async function fetchQuotes(symbols, { fetchImpl = fetch } = {}) {
  const quotes = {};
  const failed = [];
  await mapLimit([...new Set(symbols)], 6, async (symbol) => {
    try {
      quotes[symbol] = await fetchQuote(symbol, { fetchImpl });
    } catch (err) {
      failed.push(symbol);
      log(`market data unavailable for ${symbol}: ${err.message}`);
    }
  });
  return { quotes, failed };
}
