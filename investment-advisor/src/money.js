/**
 * Exact fixed-point arithmetic for prices, quantities and percentages.
 *
 * Floating point cannot represent most decimal prices exactly (0.1 + 0.2 !== 0.3),
 * so every rule comparison is done on integers:
 *   - money in mils:   1n = $0.001
 *   - quantities in:   1n = 0.00000001 units (fractional shares and crypto)
 *   - percentages in:  1  = 0.01% (one basis point)
 * Rounding is always explicit, so a stop at $187.452 fires at exactly $187.452.
 */

export const MILS = 1000n; // $1 = 1000 mils
export const QTY = 100_000_000n; // 1 unit = 1e8 qty units
export const BPS = 10_000n; // 100% = 10000 bps

/** Divide with an explicit rounding mode: 'half' (half away from zero), 'up' (ceiling), 'down' (floor). */
export function div(a, b, mode = 'half') {
  if (b === 0n) throw new RangeError('division by zero');
  if (b < 0n) return div(-a, -b, mode);
  const q = a / b; // truncates toward zero
  const r = a % b;
  if (r === 0n) return q;
  if (mode === 'down') return a < 0n ? q - 1n : q;
  if (mode === 'up') return a > 0n ? q + 1n : q;
  const twice = (r < 0n ? -r : r) * 2n;
  if (twice >= b) return a < 0n ? q - 1n : q + 1n;
  return q;
}

/** Parse a decimal string or number into an integer at `scale` decimal places, rounding as asked. */
export function parseDecimal(value, scale, mode = 'half') {
  if (typeof value === 'bigint') return value * 10n ** BigInt(scale);
  // toFixed(12) turns 187.45199999999997 back into its intended decimal before rounding.
  const text = typeof value === 'number' ? value.toFixed(12) : String(value).trim();
  const match = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || (match[2] === '' && !match[3])) throw new TypeError(`not a decimal: ${value}`);
  const [, sign, int, frac = ''] = match;
  const digits = BigInt((int || '0') + frac);
  const value10 = sign === '-' ? -digits : digits;
  const shift = scale - frac.length;
  return shift >= 0 ? value10 * 10n ** BigInt(shift) : div(value10, 10n ** BigInt(-shift), mode);
}

export const toMils = (v, mode = 'half') => parseDecimal(v, 3, mode);
export const toQty = (v, mode = 'down') => parseDecimal(v, 8, mode);
export const pctToBps = (v, mode = 'half') => Number(parseDecimal(v, 2, mode));

/** Render a scaled integer back to a fixed-decimal string. */
export function formatDecimal(n, scale) {
  const neg = n < 0n;
  const s = (neg ? -n : n).toString().padStart(scale + 1, '0');
  const out = scale ? `${s.slice(0, -scale)}.${s.slice(-scale)}` : s;
  return neg ? `-${out}` : out;
}

export const milsToString = (m) => formatDecimal(m, 3);
export const qtyToString = (q) => formatDecimal(q, 8).replace(/\.?0+$/, '') || '0';
export const bpsToString = (b) => formatDecimal(BigInt(b), 2);
export const fmtUsd = (m) => `${m < 0n ? '-' : ''}$${milsToString(m < 0n ? -m : m)}`;
export const fmtPct = (b) => `${b > 0 ? '+' : ''}${bpsToString(b)}%`;

/** Market value of a quantity at a price, in mils. */
export const valueOf = (qty, priceMils, mode = 'half') => div(qty * priceMils, QTY, mode);

/** Percentage change from `from` to `to`, in bps (0.01%). */
export const changeBps = (from, to, mode = 'half') => Number(div((to - from) * BPS, from, mode));

/** Move a price by `bps` (negative for down), rounding the result as asked. */
export const shiftByBps = (priceMils, bps, mode = 'half') => div(priceMils * (BPS + BigInt(bps)), BPS, mode);

/**
 * Snap a trigger level to a price an exchange will accept. US stocks and ETFs
 * at or above $1 trade in whole cents, so an order price is rounded to the cent
 * in the protective direction ('up' for stops and sell limits that should fill
 * sooner, 'down' for buy limits that should not overpay).
 */
export function orderPrice(priceMils, assetClass, mode) {
  const centTick = (assetClass === 'stock' || assetClass === 'etf') && priceMils >= MILS;
  return centTick ? div(priceMils, 10n, mode) * 10n : priceMils;
}

export const minBig = (...xs) => xs.reduce((a, b) => (b < a ? b : a));
export const maxBig = (...xs) => xs.reduce((a, b) => (b > a ? b : a));
