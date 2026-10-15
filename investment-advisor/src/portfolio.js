import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  QTY,
  BPS,
  div,
  toMils,
  toQty,
  milsToString,
  qtyToString,
  valueOf,
  changeBps,
} from './money.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PORTFOLIO_PATH = process.env.ADVISOR_PORTFOLIO || path.join(ROOT, 'portfolio.json');

/**
 * Portfolio file format. All money and quantities are decimal strings so they
 * round-trip exactly: money to $0.001, quantities to 1e-8.
 * {
 *   cash_usd, realized_pnl_usd,
 *   positions: [{ symbol, asset_class, quantity, avg_cost, opened_at, plan: {...} }],
 *   transactions: [{ at, side, symbol, quantity, price, fees, realized_pnl }]
 * }
 */
export function newPortfolio(cashUsd = 0) {
  return { version: 1, cash_usd: milsToString(toMils(cashUsd)), realized_pnl_usd: '0.000', positions: [], transactions: [] };
}

export async function loadPortfolio(file = PORTFOLIO_PATH) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function savePortfolio(portfolio, file = PORTFOLIO_PATH) {
  await fs.writeFile(file, `${JSON.stringify(portfolio, null, 2)}\n`);
}

/**
 * Record a filled trade. Buys average into the position's cost basis (fees
 * included); sells realize P&L against that basis. Returns a new portfolio.
 */
export function applyTrade(portfolio, { side, symbol, quantity, price, fees = 0, at = new Date().toISOString(), plan, assetClass }) {
  const p = structuredClone(portfolio);
  symbol = symbol.toUpperCase();
  const qty = toQty(quantity);
  const px = toMils(price);
  const fee = toMils(fees);
  if (qty <= 0n) throw new RangeError('quantity must be positive');
  if (px <= 0n) throw new RangeError('price must be positive');
  const gross = valueOf(qty, px);
  const idx = p.positions.findIndex((x) => x.symbol === symbol);
  const pos = idx >= 0 ? p.positions[idx] : null;
  let realized = 0n;

  if (side === 'buy') {
    const cost = gross + fee;
    if (pos) {
      const oldQty = toQty(pos.quantity);
      const oldCost = valueOf(oldQty, toMils(pos.avg_cost));
      const newQty = oldQty + qty;
      pos.quantity = qtyToString(newQty);
      pos.avg_cost = milsToString(div((oldCost + cost) * QTY, newQty));
      if (plan) pos.plan = { ...pos.plan, ...plan };
    } else {
      p.positions.push({
        symbol,
        asset_class: assetClass ?? plan?.asset_class ?? 'stock',
        quantity: qtyToString(qty),
        avg_cost: milsToString(div(cost * QTY, qty)),
        opened_at: at,
        plan: plan ?? {},
      });
    }
    p.cash_usd = milsToString(toMils(p.cash_usd) - cost);
  } else if (side === 'sell') {
    if (!pos) throw new RangeError(`no open position in ${symbol}`);
    const held = toQty(pos.quantity);
    if (qty > held) throw new RangeError(`cannot sell ${qtyToString(qty)} ${symbol}; only ${pos.quantity} held`);
    realized = gross - valueOf(qty, toMils(pos.avg_cost)) - fee;
    p.cash_usd = milsToString(toMils(p.cash_usd) + gross - fee);
    p.realized_pnl_usd = milsToString(toMils(p.realized_pnl_usd) + realized);
    if (qty === held) p.positions.splice(idx, 1);
    else {
      pos.quantity = qtyToString(held - qty);
      if (pos.plan?.target_hit_at) pos.plan.partial_taken = true;
    }
  } else {
    throw new TypeError(`side must be "buy" or "sell", not ${side}`);
  }

  p.transactions.push({
    at,
    side,
    symbol,
    quantity: qtyToString(qty),
    price: milsToString(px),
    fees: milsToString(fee),
    ...(side === 'sell' ? { realized_pnl: milsToString(realized) } : {}),
  });
  return p;
}

/**
 * Value the portfolio at current prices (a map of symbol -> price in mils).
 * Positions without a price are valued at cost and flagged.
 */
export function valuePortfolio(portfolio, prices) {
  const cash = toMils(portfolio.cash_usd);
  const rows = portfolio.positions.map((pos) => {
    const qty = toQty(pos.quantity);
    const avg = toMils(pos.avg_cost);
    const price = prices[pos.symbol] ?? null;
    const value = valueOf(qty, price ?? avg);
    const cost = valueOf(qty, avg);
    return {
      symbol: pos.symbol,
      assetClass: pos.asset_class,
      qty,
      avg,
      price,
      value,
      pnl: value - cost,
      pnlBps: price ? changeBps(avg, price) : 0,
      priced: price != null,
    };
  });
  const total = cash + rows.reduce((s, r) => s + r.value, 0n);
  for (const r of rows) r.weightBps = total > 0n ? Number(div(r.value * BPS, total)) : 0;
  return { cash, total, realized: toMils(portfolio.realized_pnl_usd), rows };
}

/**
 * Save rule-managed plan state (high-water marks, ratcheted stops, target hits)
 * without overwriting trades recorded while the rules were running: plans are
 * merged into the portfolio as it is on disk now, matched by symbol.
 */
export async function savePlans(evaluated, file = PORTFOLIO_PATH) {
  const current = (await loadPortfolio(file)) ?? evaluated;
  const plans = new Map(evaluated.positions.map((p) => [p.symbol, p.plan]));
  const merged = {
    ...current,
    positions: current.positions.map((p) => (plans.has(p.symbol) ? { ...p, plan: { ...p.plan, ...plans.get(p.symbol) } } : p)),
  };
  await savePortfolio(merged, file);
  return merged;
}
