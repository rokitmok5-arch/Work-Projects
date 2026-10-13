import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  QTY,
  BPS,
  div,
  toMils,
  toQty,
  pctToBps,
  milsToString,
  qtyToString,
  valueOf,
  changeBps,
  shiftByBps,
  orderPrice,
  minBig,
  maxBig,
  fmtUsd,
  fmtPct,
} from './money.js';
import { valuePortfolio } from './portfolio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function loadRules(file = path.join(ROOT, 'config', 'rules.json')) {
  return compileRules(JSON.parse(await fs.readFile(file, 'utf8')));
}

/** Convert the human-readable config into exact units (bps, BigInt fractions). */
export function compileRules(raw) {
  const { entry, risk, exit } = raw;
  return {
    entry: {
      actions: new Set(entry.actions),
      minIndependentReports: entry.minIndependentReports,
      maxRsi: entry.maxRsi,
      maxExtensionBps: pctToBps(entry.maxExtensionAboveSma20Pct),
      accumulateBps: pctToBps(entry.accumulateFraction * 100),
      allowContradictedIfForecastAhead: entry.allowContradictedIfForecastAhead,
    },
    risk: {
      riskPerTradeBps: pctToBps(risk.riskPerTradePct),
      maxPositionBps: pctToBps(risk.maxPositionPct),
      stopSigma: risk.stopSigma,
      stopHorizonDays: risk.stopHorizonDays,
      minStopBps: pctToBps(risk.minStopPct),
      maxStopBps: pctToBps(risk.maxStopPct),
      rewardToRiskBps: pctToBps(risk.rewardToRisk * 100),
      fractionalShares: risk.fractionalShares,
    },
    exit: {
      takeProfitBps: pctToBps(exit.takeProfitFraction * 100),
      trailActivationBps: pctToBps(exit.trailActivationR * 100),
      reduceOnDivergingBps: pctToBps(exit.reduceOnDivergingFraction * 100),
      pricedInRsi: exit.pricedInRsi,
      timeStopMinBps: pctToBps(exit.timeStopMinR * 100),
      minIndependentReportsForFlip: exit.minIndependentReportsForFlip,
    },
  };
}

/** Smallest tradable quantity step: whole shares unless fractional trading is on; crypto is always fractional. */
function qtyStep(assetClass, rules) {
  return assetClass === 'crypto' || rules.risk.fractionalShares ? 1n : QTY;
}

const floorTo = (qty, step) => (qty / step) * step;
const ceilTo = (qty, step) => div(qty, step, 'up') * step;
const scale = (amount, bps, mode = 'down') => div(amount * BigInt(bps), BPS, mode);

/**
 * Stop distance from volatility: stopSigma daily standard deviations scaled to
 * the holding horizon (sigma * sqrt(days)), clamped to [minStop, maxStop].
 */
export function stopDistanceBps(dailyVolPct, rules) {
  const { stopSigma, stopHorizonDays, minStopBps, maxStopBps } = rules.risk;
  const raw = dailyVolPct ? Math.round(stopSigma * dailyVolPct * 100 * Math.sqrt(stopHorizonDays)) : maxStopBps;
  return Math.min(maxStopBps, Math.max(minStopBps, raw));
}

/**
 * Entry plan for a long position at `priceMils`: protective stop (rounded up,
 * so it never sits further away than the rule says), profit target (rounded
 * down, so it is never further than the forecast), and the highest price at
 * which the entry rules still allow buying.
 */
export function planEntry({ priceMils, sma20Mils, dailyVolPct, expectedMovePct, assetClass }, rules) {
  const stopBps = stopDistanceBps(dailyVolPct, rules);
  const stop = shiftByBps(priceMils, -stopBps, 'up');
  const risk = priceMils - stop;
  const rTarget = priceMils + scale(risk, rules.risk.rewardToRiskBps);
  const forecastTarget = expectedMovePct > 0 ? shiftByBps(priceMils, pctToBps(expectedMovePct), 'down') : null;
  const target = forecastTarget ?? rTarget;
  const maxEntry = sma20Mils ? shiftByBps(sma20Mils, rules.entry.maxExtensionBps, 'down') : null;
  return {
    entry: priceMils,
    stop,
    stopBps,
    risk,
    target,
    targetSource: forecastTarget ? 'forecast' : 'reward-to-risk',
    rewardBps: changeBps(priceMils, target),
    riskBps: changeBps(priceMils, stop),
    maxEntry,
    buyLimit: orderPrice(maxEntry ? minBig(priceMils, maxEntry) : priceMils, assetClass, 'down'),
    stopOrder: orderPrice(stop, assetClass, 'up'),
    targetOrder: orderPrice(target, assetClass, 'down'),
  };
}

function quoteFor(symbol, quotes, fallback) {
  const q = quotes[symbol] ?? fallback;
  if (!q || q.price == null) return null;
  return {
    ...q,
    priceMils: toMils(q.price),
    sma20Mils: q.sma20 != null ? toMils(q.sma20) : null,
  };
}

function eventsForSymbol(events, symbol, ids) {
  return (events ?? [])
    .filter((e) => !ids || ids.includes(e.id))
    .flatMap((e) => e.channels.filter((c) => c.symbol === symbol).map((c) => ({ ...c, eventId: e.id, event: e.name, eventStatus: e.status })));
}

const signal = (s) => ({
  ...s,
  quantity: s.quantity != null ? qtyToString(s.quantity) : null,
  price: s.price != null ? milsToString(s.price) : null,
  ...(s.plan
    ? {
        plan: {
          entry: milsToString(s.plan.entry),
          stop: milsToString(s.plan.stop),
          target: milsToString(s.plan.target),
          buy_limit: milsToString(s.plan.buyLimit),
          stop_order: milsToString(s.plan.stopOrder),
          target_order: milsToString(s.plan.targetOrder),
          max_entry: s.plan.maxEntry != null ? milsToString(s.plan.maxEntry) : null,
          stop_bps: s.plan.stopBps,
          stop_pct: (s.plan.stopBps / 100).toFixed(2),
          reward_pct: (s.plan.rewardBps / 100).toFixed(2),
          target_source: s.plan.targetSource,
        },
      }
    : {}),
});

/**
 * BUY / ADD / WAIT signals for the advisor's recommendations.
 * Entry rules (all must pass): an entry action from the advisor; enough
 * independent reports; RSI at or below the cap; price no more than the allowed
 * extension above its 20-day average; the market not contradicting the thesis
 * (unless a high-confidence forecast is still ahead of the move); and a profit
 * target at least as far away as the stop.
 * Size: the smallest of the advisor's allocation (halved for "accumulate"),
 * the per-trade risk budget divided by the distance to the stop, and available cash.
 */
export function buySignals({ advice, candidates = [], portfolio, quotes = {}, rules, valuation }) {
  const out = [];
  let cash = valuation.cash;
  const bySymbol = new Map(candidates.map((c) => [c.symbol, c]));

  for (const rec of advice?.recommendations ?? []) {
    const symbol = rec.symbol;
    const q = quoteFor(symbol, quotes, rec.market);
    if (!q) continue;
    const cand = bySymbol.get(symbol) ?? {};
    const held = valuation.rows.find((r) => r.symbol === symbol);
    const assetClass = rec.asset_class ?? cand.assetClass ?? 'stock';
    const plan = planEntry(
      { priceMils: q.priceMils, sma20Mils: q.sma20Mils, dailyVolPct: q.dailyVolPct, expectedMovePct: rec.expected_move_pct, assetClass },
      rules,
    );

    const blockers = [];
    if (!rules.entry.actions.has(rec.action)) blockers.push(`advisor action is "${rec.action}"`);
    const independent = rec.independentReports ?? cand.sourceCount ?? 0;
    if (independent < rules.entry.minIndependentReports) blockers.push(`only ${independent} independent report(s)`);
    if (q.rsi14 != null && q.rsi14 > rules.entry.maxRsi) blockers.push(`RSI ${q.rsi14} is above ${rules.entry.maxRsi}`);
    if (plan.maxEntry != null && q.priceMils > plan.maxEntry) {
      blockers.push(`price ${fmtUsd(q.priceMils)} is more than ${rules.entry.maxExtensionBps / 100}% above its 20-day average; buy at or below ${fmtUsd(plan.maxEntry)}`);
    }
    const forecastAhead = (rec.events ?? []).some((e) => e.status === 'ahead of the move' && e.confidence === 'high');
    const confirmation = cand.confirmation ?? null;
    if (confirmation === 'contradicted' && !(rules.entry.allowContradictedIfForecastAhead && forecastAhead)) {
      blockers.push('price trend contradicts the thesis');
    }
    if (plan.target - plan.entry < plan.risk) blockers.push(`reward to target (${fmtPct(plan.rewardBps)}) is smaller than the risk to the stop (${fmtPct(plan.riskBps)})`);

    if (blockers.length) {
      out.push(signal({ symbol, side: 'WAIT', action: 'wait', rule: 'entry-conditions', reason: blockers.join('; '), price: q.priceMils, plan, priority: 9 }));
      continue;
    }

    const step = qtyStep(assetClass, rules);
    let allocBps = pctToBps(rec.suggested_allocation_pct);
    if (rec.action === 'accumulate') allocBps = Number(scale(BigInt(allocBps), rules.entry.accumulateBps));
    allocBps = Math.min(allocBps, rules.risk.maxPositionBps);
    const allocValue = scale(valuation.total, allocBps) - (held?.value ?? 0n);
    const riskBudget = scale(valuation.total, rules.risk.riskPerTradeBps);
    const byAlloc = allocValue > 0n ? div(allocValue * QTY, plan.buyLimit, 'down') : 0n;
    const byRisk = plan.risk > 0n ? div(riskBudget * QTY, plan.risk, 'down') : 0n;
    const byCash = cash > 0n ? div(cash * QTY, plan.buyLimit, 'down') : 0n;
    const qty = floorTo(minBig(byAlloc, byRisk, byCash), step);
    if (qty <= 0n) {
      if (allocValue > 0n && byCash < step) {
        out.push(signal({ symbol, side: 'WAIT', action: 'wait', rule: 'insufficient-cash', reason: 'not enough cash for one tradable unit', price: q.priceMils, plan, priority: 9 }));
      }
      continue;
    }
    const cost = valueOf(qty, plan.buyLimit, 'up');
    cash -= cost;
    const limiting = qty === floorTo(byRisk, step) ? 'risk budget' : qty === floorTo(byCash, step) ? 'available cash' : 'target allocation';
    out.push(
      signal({
        symbol,
        side: 'BUY',
        action: held ? 'add' : 'buy',
        rule: 'entry-conditions-met',
        reason:
          `${rec.action.replace('_', ' ')} (rank ${rec.rank}); size limited by ${limiting}; ` +
          `stop ${fmtUsd(plan.stop)} (${fmtPct(plan.riskBps)}), target ${fmtUsd(plan.target)} (${fmtPct(plan.rewardBps)}, ${plan.targetSource})` +
          (['commodity', 'currency'].includes(assetClass) ? '; price is the futures/FX quote, trade it through an ETF or product that tracks it' : ''),
        quantity: qty,
        price: q.priceMils,
        value: milsToString(cost),
        plan,
        assetClass,
        eventIds: [...new Set((rec.events ?? []).map((e) => e.eventId).filter(Boolean))],
        windowEnds: (rec.events ?? []).map((e) => e.windowEnds).filter(Boolean).sort().at(-1) ?? null,
        priority: 5,
      }),
    );
  }
  return out;
}

/**
 * SELL / REDUCE / TAKE PROFIT / TRIM / HOLD for every open position, first
 * matching rule wins, in this order:
 *   1. stop-loss / trailing stop: price at or below the stop (exact to $0.001)
 *   2. advisor-avoid: the advisor now lists it under avoid
 *   3. consensus-turned-bearish: independent reporting now points down
 *   4. thesis-diverging: a linked event forecast is moving the other way, or the event resolved
 *   5. target-reached: price at or above the target; sell part, move the stop to breakeven
 *   6. priced-in: every linked forecast is priced in and RSI is stretched
 *   7. time-stop: the forecast window closed without the trade working
 *   8. overweight: the position has grown past the maximum weight
 * The trailing stop ratchets up (never down) once the gain reaches the
 * activation multiple of the initial risk. Returns updated position plans.
 */
export function sellSignals({ portfolio, quotes = {}, advice, candidates = [], events = [], rules, valuation, now = Date.now() }) {
  const signals = [];
  const positions = structuredClone(portfolio.positions);
  const avoid = new Set((advice?.avoid ?? []).map((a) => a.symbol.toUpperCase()));
  const bySymbol = new Map(candidates.map((c) => [c.symbol, c]));

  for (const pos of positions) {
    const q = quoteFor(pos.symbol, quotes, null);
    const row = valuation.rows.find((r) => r.symbol === pos.symbol);
    if (!q) {
      signals.push(signal({ symbol: pos.symbol, side: 'HOLD', action: 'hold', rule: 'no-price', reason: 'no current price; rules not evaluated', priority: 8 }));
      continue;
    }
    const price = q.priceMils;
    const qty = toQty(pos.quantity);
    const avg = toMils(pos.avg_cost);
    const step = qtyStep(pos.asset_class, rules);
    const plan = (pos.plan ??= {});

    // Positions recorded without a plan get one from the current price and volatility.
    if (!plan.stop) {
      const p = planEntry({ priceMils: avg, sma20Mils: null, dailyVolPct: q.dailyVolPct, assetClass: pos.asset_class }, rules);
      Object.assign(plan, { entry: plan.entry ?? milsToString(avg), stop: milsToString(p.stop), initial_stop: milsToString(p.stop), stop_bps: p.stopBps });
      plan.target ??= milsToString(p.target);
    }
    if (!plan.target) {
      const e = toMils(plan.entry ?? pos.avg_cost);
      plan.target = milsToString(e + scale(e - toMils(plan.stop), rules.risk.rewardToRiskBps));
    }
    const entry = toMils(plan.entry ?? pos.avg_cost);
    const initialStop = toMils(plan.initial_stop ?? plan.stop);
    const risk = maxBig(entry - initialStop, 1n);
    let stop = toMils(plan.stop);
    const target = toMils(plan.target);
    const highWater = maxBig(toMils(plan.high_water ?? plan.entry ?? pos.avg_cost), price);
    plan.high_water = milsToString(highWater);

    // Trailing stop: once up by the activation multiple of R, trail the high-water mark.
    if (!plan.trail_active && price - entry >= scale(risk, rules.exit.trailActivationBps)) plan.trail_active = true;
    if (plan.trail_active) {
      const trail = shiftByBps(highWater, -(plan.stop_bps ?? stopDistanceBps(q.dailyVolPct, rules)), 'up');
      if (trail > stop) stop = trail;
    }
    plan.stop = milsToString(stop);

    const base = {
      symbol: pos.symbol,
      price,
      avgCost: milsToString(avg),
      pnlPct: fmtPct(changeBps(avg, price)),
      stop: milsToString(stop),
      stopOrder: milsToString(orderPrice(stop, pos.asset_class, 'up')),
      target: milsToString(target),
      toStopPct: fmtPct(changeBps(price, stop)),
      toTargetPct: fmtPct(changeBps(price, target)),
    };
    const part = (bps) => {
      const portion = floorTo(scale(qty, bps), step);
      return portion > 0n ? portion : qty;
    };
    const linked = eventsForSymbol(events, pos.symbol, plan.event_ids?.length ? plan.event_ids : null);
    const cand = bySymbol.get(pos.symbol);
    const gainR = Number(div((price - entry) * BPS, risk)); // gain in units of initial risk, in bps (10000 = 1R)

    let s;
    if (price <= stop) {
      s = { side: 'SELL', action: 'sell_all', rule: plan.trail_active ? 'trailing-stop' : 'stop-loss', reason: `price ${fmtUsd(price)} is at or below the stop ${fmtUsd(stop)}`, quantity: qty, priority: 1 };
    } else if (avoid.has(pos.symbol)) {
      s = { side: 'SELL', action: 'sell_all', rule: 'advisor-avoid', reason: 'the advisor now lists this under avoid', quantity: qty, priority: 2 };
    } else if (cand?.stance === 'bearish' && cand.sourceCount >= rules.exit.minIndependentReportsForFlip) {
      s = { side: 'SELL', action: 'sell_all', rule: 'consensus-turned-bearish', reason: `${cand.sourceCount} independent reports now point down`, quantity: qty, priority: 2 };
    } else if (linked.some((c) => c.status === 'diverging' || c.eventStatus === 'resolved')) {
      const why = linked.find((c) => c.status === 'diverging' || c.eventStatus === 'resolved');
      s = {
        side: 'SELL',
        action: 'reduce',
        rule: 'thesis-diverging',
        reason: why.eventStatus === 'resolved' ? `"${why.event}" has resolved` : `"${why.event}" forecast is moving the other way (${fmtPct(Math.round((why.movedPct ?? 0) * 100))})`,
        quantity: part(rules.exit.reduceOnDivergingBps),
        priority: 3,
      };
    } else if (price >= target && !plan.partial_taken) {
      plan.target_hit_at ??= new Date(now).toISOString();
      if (avg > stop) {
        stop = avg; // breakeven
        plan.stop = milsToString(stop);
        base.stop = plan.stop;
        base.stopOrder = milsToString(orderPrice(stop, pos.asset_class, 'up'));
      }
      s = { side: 'SELL', action: 'take_profit', rule: 'target-reached', reason: `price ${fmtUsd(price)} reached the target ${fmtUsd(target)}; stop is now ${fmtUsd(stop)}, at or above breakeven`, quantity: part(rules.exit.takeProfitBps), priority: 4 };
    } else if (!plan.partial_taken && linked.length && linked.every((c) => c.status === 'priced in') && (q.rsi14 ?? 0) >= rules.exit.pricedInRsi) {
      s = { side: 'SELL', action: 'take_profit', rule: 'priced-in', reason: `linked forecasts are priced in and RSI is ${q.rsi14}`, quantity: part(rules.exit.takeProfitBps), priority: 4 };
    } else if (plan.window_ends && now >= Date.parse(plan.window_ends) && gainR < rules.exit.timeStopMinBps) {
      s = { side: 'SELL', action: 'sell_all', rule: 'time-stop', reason: `forecast window closed ${plan.window_ends.slice(0, 10)} with the trade at ${(gainR / 10000).toFixed(2)}R`, quantity: qty, priority: 5 };
    } else if (row && row.weightBps > rules.risk.maxPositionBps) {
      const excess = row.value - scale(valuation.total, rules.risk.maxPositionBps);
      s = { side: 'SELL', action: 'trim', rule: 'overweight', reason: `position is ${(row.weightBps / 100).toFixed(2)}% of the portfolio, above the ${(rules.risk.maxPositionBps / 100).toFixed(2)}% cap`, quantity: minBig(ceilTo(div(excess * QTY, price, 'up'), step), qty), priority: 6 };
    } else {
      s = { side: 'HOLD', action: 'hold', rule: 'no-exit-rule-triggered', reason: `stop ${fmtUsd(stop)} (${base.toStopPct}), target ${fmtUsd(target)} (${base.toTargetPct})`, priority: 8 };
    }
    if (s.quantity != null) s.value = milsToString(valueOf(s.quantity, price));
    signals.push(signal({ ...base, ...s }));
  }
  return { signals, positions };
}

/** Run all rules against the portfolio and the advisor's latest output. */
export function evaluateRules({ portfolio, advice, candidates, events, quotes, rules, now = Date.now() }) {
  const prices = Object.fromEntries(Object.entries(quotes).filter(([, q]) => q?.price != null).map(([s, q]) => [s, toMils(q.price)]));
  const valuation = valuePortfolio(portfolio, prices);
  const { signals: exits, positions } = sellSignals({ portfolio, quotes, advice, candidates, events, rules, valuation, now });
  const entries = buySignals({ advice, candidates, portfolio, quotes, rules, valuation });
  const signals = [...exits, ...entries].sort((a, b) => a.priority - b.priority);
  return {
    evaluatedAt: new Date(now).toISOString(),
    signals,
    portfolio: { ...portfolio, positions },
    valuation: {
      cash: milsToString(valuation.cash),
      total: milsToString(valuation.total),
      realized_pnl: milsToString(valuation.realized),
      positions: valuation.rows.map((r) => ({
        symbol: r.symbol,
        quantity: qtyToString(r.qty),
        avg_cost: milsToString(r.avg),
        price: r.price != null ? milsToString(r.price) : null,
        value: milsToString(r.value),
        unrealized_pnl: milsToString(r.pnl),
        unrealized_pct: fmtPct(r.pnlBps),
        weight_pct: (r.weightBps / 100).toFixed(2),
      })),
    },
  };
}

/** The plan to store on a position when a BUY signal is executed. */
export function planFromSignal(sig) {
  return {
    entry: sig.plan.entry,
    stop: sig.plan.stop,
    initial_stop: sig.plan.stop,
    stop_bps: sig.plan.stop_bps,
    target: sig.plan.target,
    high_water: sig.plan.entry,
    trail_active: false,
    partial_taken: false,
    event_ids: sig.eventIds ?? [],
    window_ends: sig.windowEnds ?? null,
    asset_class: sig.assetClass,
  };
}
