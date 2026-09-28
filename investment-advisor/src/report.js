export const DISCLAIMER =
  'This report is generated automatically by an AI system from news headlines and public market data. ' +
  'It is research to inform your own decisions, not personalized financial, legal or tax advice. ' +
  'News-driven signals can be wrong or already priced in, and every investment can lose value. ' +
  'Verify the facts, consider your full financial situation, and consult a licensed financial advisor before investing.';

const ACTION_LABEL = { strong_buy: 'Strong buy', buy: 'Buy', accumulate: 'Accumulate', watch: 'Watch' };
const HORIZON_LABEL = { short_term: 'Weeks', medium_term: 'Months', long_term: '1y+' };

function pct(v) {
  if (v == null) return 'n/a';
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
}

function cell(v) {
  return String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function renderMarkdown(report) {
  const { advice, meta } = report;
  const lines = [];
  lines.push(`# Investment Advisory Brief — ${meta.generatedAt.slice(0, 10)}`);
  lines.push('');
  lines.push(
    `Analyzed **${meta.articleCount} articles** from **${meta.sourcesWithArticles}/${meta.coverage.length} outlets**, ` +
      `extracted **${meta.signalCount} signals** on **${meta.entityCount} assets**, priced **${meta.pricedCount} candidates**.`,
  );
  lines.push('');
  lines.push(`> ${DISCLAIMER}`);
  lines.push('');

  lines.push('## Market overview');
  lines.push('');
  lines.push(advice.market_overview);
  lines.push('');

  if (report.backdrop?.length) {
    lines.push('| Benchmark | Price | 1d | 1mo | Trend |');
    lines.push('|---|---:|---:|---:|---|');
    for (const b of report.backdrop) {
      lines.push(`| ${cell(b.label)} (${b.symbol}) | ${b.price ?? 'n/a'} | ${pct(b.change1dPct)} | ${pct(b.change1moPct)} | ${b.trend} |`);
    }
    lines.push('');
  }

  if (advice.key_themes?.length) {
    lines.push('## Key themes');
    lines.push('');
    for (const t of advice.key_themes) lines.push(`- **${t.theme}** — ${t.implication}`);
    lines.push('');
  }

  lines.push(`## Top ${advice.recommendations.length} picks`);
  lines.push('');
  lines.push('| # | Asset | Class | Action | Conviction | Horizon | Alloc. | Price | 1mo | Outlets | Market |');
  lines.push('|---:|---|---|---|---|---|---:|---:|---:|---:|---|');
  for (const r of advice.recommendations) {
    const m = r.market;
    lines.push(
      `| ${r.rank} | **${cell(r.symbol)}** ${cell(r.name)} | ${r.asset_class} | ${ACTION_LABEL[r.action]} | ${r.conviction} | ` +
        `${HORIZON_LABEL[r.time_horizon]} | ${r.suggested_allocation_pct}% | ${m?.price ?? 'n/a'} | ${pct(m?.change1moPct)} | ` +
        `${r.sources.length} | ${m?.trend ?? 'n/a'} |`,
    );
  }
  lines.push(`|  | Cash |  |  |  |  | ${advice.cash_allocation_pct}% |  |  |  |  |`);
  lines.push('');

  for (const r of advice.recommendations) {
    lines.push(`### ${r.rank}. ${r.symbol} — ${r.name}`);
    lines.push('');
    lines.push(`**${ACTION_LABEL[r.action]}** · ${r.conviction} conviction · ${HORIZON_LABEL[r.time_horizon]} · ${r.suggested_allocation_pct}% allocation`);
    lines.push('');
    lines.push(r.thesis);
    lines.push('');
    lines.push(`- **News consensus:** ${r.news_consensus}`);
    lines.push(`- **Market confirmation:** ${r.market_confirmation}`);
    if (r.catalysts?.length) lines.push(`- **Catalysts:** ${r.catalysts.join('; ')}`);
    if (r.key_risks?.length) lines.push(`- **Risks:** ${r.key_risks.join('; ')}`);
    lines.push(`- **Entry:** ${r.entry_note}`);
    const links = r.evidence.filter((e) => e.link).slice(0, 4);
    if (links.length) {
      lines.push('- **Sources:**');
      for (const e of links) lines.push(`  - [${e.source}: ${cell(e.title)}](${e.link})`);
    }
    lines.push('');
  }

  if (advice.avoid?.length) {
    lines.push('## Avoid / reduce');
    lines.push('');
    for (const a of advice.avoid) lines.push(`- **${a.symbol}** ${a.name} — ${a.reason}`);
    lines.push('');
  }

  lines.push('## Portfolio notes');
  lines.push('');
  lines.push(advice.portfolio_notes);
  lines.push('');

  lines.push('## Source coverage');
  lines.push('');
  lines.push('| Outlet | Articles | Note |');
  lines.push('|---|---:|---|');
  for (const c of meta.coverage) {
    const note = c.usedFallback ? 'via Google News fallback' : c.errors.length ? `${c.errors.length} feed error(s)` : '';
    lines.push(`| ${c.source} | ${c.articles} | ${note} |`);
  }
  lines.push('');

  if (advice.warnings?.length) {
    lines.push('## Pipeline warnings');
    lines.push('');
    for (const w of advice.warnings) lines.push(`- ${w}`);
    lines.push('');
  }
  return lines.join('\n');
}
