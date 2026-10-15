#!/usr/bin/env node
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { loadPortfolio, savePortfolio, newPortfolio, applyTrade, PORTFOLIO_PATH } from './portfolio.js';
import { runCheck, planForNewBuy } from './check.js';
import { renderSignals } from './report.js';
import { toMils, milsToString } from './money.js';

const USAGE = `Usage: npm run portfolio -- <command> [args]

  show                                  Positions, cost basis and stop/target levels (default)
  init <cash>                           Start a portfolio with this much cash (add --force to replace one)
  deposit <amount> | withdraw <amount>  Move cash in or out
  buy <symbol> <qty> <price>            Record a filled buy. Uses the stop/target from the latest BUY signal
      [--fees n] [--stop p] [--target p] for the symbol unless --stop/--target are given.
  sell <symbol> <qty> <price> [--fees n] Record a filled sell
  check [--json]                        Re-run every buy/sell rule on fresh prices (no new AI analysis)

Prices are recorded to $0.001 and quantities to 0.00000001.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    fees: { type: 'string', default: '0' },
    stop: { type: 'string' },
    target: { type: 'string' },
    force: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

async function requirePortfolio() {
  const p = await loadPortfolio();
  if (!p) throw new Error('No portfolio yet. Run `npm run portfolio -- init <cash>` first.');
  return p;
}

function show(p) {
  console.log(`Cash $${p.cash_usd} · realized P&L $${p.realized_pnl_usd} · ${p.positions.length} position(s) · ${PORTFOLIO_PATH}`);
  if (!p.positions.length) return;
  console.log('');
  console.log('| Symbol | Qty | Avg cost | Stop | Target | Trailing | Opened |');
  console.log('|---|---:|---:|---:|---:|---|---|');
  for (const pos of p.positions) {
    const plan = pos.plan ?? {};
    console.log(`| ${pos.symbol} | ${pos.quantity} | ${pos.avg_cost} | ${plan.stop ?? 'set on next check'} | ${plan.target ?? ''} | ${plan.trail_active ? 'yes' : 'no'} | ${pos.opened_at.slice(0, 10)} |`);
  }
}

async function main() {
  const [command = 'show', ...args] = positionals;
  if (values.help) return console.log(USAGE);

  switch (command) {
    case 'show':
      return show(await requirePortfolio());

    case 'init': {
      if ((await loadPortfolio()) && !values.force) throw new Error('A portfolio already exists. Use --force to replace it.');
      const p = newPortfolio(args[0] ?? 0);
      await savePortfolio(p);
      return show(p);
    }

    case 'deposit':
    case 'withdraw': {
      const p = await requirePortfolio();
      const amount = toMils(args[0]);
      if (amount <= 0n) throw new Error('amount must be positive');
      p.cash_usd = milsToString(toMils(p.cash_usd) + (command === 'deposit' ? amount : -amount));
      await savePortfolio(p);
      return show(p);
    }

    case 'buy':
    case 'sell': {
      const [symbolArg, quantity, price] = args;
      if (!symbolArg || !quantity || !price) throw new Error(`Usage: npm run portfolio -- ${command} <symbol> <qty> <price>`);
      const symbol = symbolArg.toUpperCase();
      const p = await requirePortfolio();
      let plan;
      let assetClass;
      if (command === 'buy' && !p.positions.some((x) => x.symbol === symbol)) {
        ({ plan, assetClass } = await planForNewBuy({ symbol, price, stop: values.stop, target: values.target }));
        if (plan) console.log(`Risk plan: stop ${plan.stop ?? 'from volatility'}, target ${plan.target ?? '2x risk'}.`);
        else console.log('No BUY signal or --stop/--target for this symbol; a volatility-based stop and target are set on the next check.');
      }
      const next = applyTrade(p, { side: command, symbol, quantity, price, fees: values.fees, plan, assetClass });
      await savePortfolio(next);
      return show(next);
    }

    case 'check': {
      const out = await runCheck();
      if (values.json) return console.log(JSON.stringify(out, null, 2));
      console.log(renderSignals(out.signals, out.portfolio).join('\n'));
      if (out.unpriced.length) console.log(`No current price for: ${out.unpriced.join(', ')}`);
      return;
    }

    default:
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
