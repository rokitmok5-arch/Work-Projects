export const DISCLAIMER =
  'This report is generated automatically by an AI system from news headlines and public market data. ' +
  'It is research to inform your own decisions, not personalized financial, legal or tax advice. ' +
  'News-driven signals can be wrong or already priced in, and every investment can lose value. ' +
  'Verify the facts, consider your full financial situation, and consult a licensed financial advisor before investing.';

const ACTION_LABEL = { strong_buy: 'Strong buy', buy: 'Buy', accumulate: 'Accumulate', watch: 'Watch' };
const STATUS_LABEL = {
  'ahead of the move': 'ahead of the move',
  underway: 'underway',
  'priced in': 'priced in',
  diverging: 'moving the other way',
  'not reacting': 'not reacting',
  resolved: 'event resolved',
  'no market data': 'no market data',
};
const LAG_LABEL = { immediate: 'days', weeks: 'weeks', months: 'months', long_term: '6+ months' };
const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 };

function date(iso) {
  return iso ? iso.slice(0, 10) : 'n/a';
}
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
      `mapped **${meta.eventCount ?? 0} global events** (${meta.trackedEventCount ?? 0} carried over from earlier runs), extracted **${meta.signalCount} signals** on **${meta.entityCount} assets**, ` +
      `priced **${meta.pricedCount} candidates**.`,
  );
  lines.push('');
  lines.push(`> ${DISCLAIMER}`);
  lines.push('');

  lines.push('## Market overview');
  lines.push('');
  lines.push(advice.market_overview);
  lines.push('');

  if (advice.event_analysis?.length) {
    lines.push('## Global events and the market');
    lines.push('');
    for (const e of advice.event_analysis) {
      lines.push(`- **${e.event}** — ${e.implication}`);
      lines.push(`  - *Market read:* ${e.market_read}`);
      if (e.timeline) lines.push(`  - *Timeline:* ${e.timeline}`);
    }
    lines.push('');
  }

  const ahead = (report.events ?? [])
    .flatMap((e) => e.channels.map((c) => ({ ...c, event: e.name, eventStatus: e.status })))
    .filter((c) => c.status === 'ahead of the move' || c.status === 'underway')
    .sort((a, b) => CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence] || (b.remainingPct ?? 0) - (a.remainingPct ?? 0));
  if (ahead.length) {
    lines.push('## Forecast: moves still ahead');
    lines.push('');
    lines.push(
      'Effects of reported events that have not fully reached prices yet. "Expected" is the total forecast move and ' +
        '"so far" is the move in that direction since the event broke. These are estimates, not certainties.',
    );
    lines.push('');
    lines.push('| Asset | Direction | Driven by | Lands in | Expected | So far | Window closes | Confidence | Watch for |');
    lines.push('|---|---|---|---|---:|---:|---|---|---|');
    for (const c of ahead.slice(0, 20)) {
      lines.push(
        `| **${cell(c.symbol)}** ${cell(c.name)} | ${c.direction === 'up' ? '▲ up' : '▼ down'} | ${cell(c.event)} | ${LAG_LABEL[c.lag]} | ` +
          `${c.expectedMovePct.toFixed(1)}% | ${pct(c.movedPct)} | ${date(c.windowEnds)} | ${c.confidence} | ${cell((c.leadingIndicators ?? []).slice(0, 2).join('; '))} |`,
      );
    }
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
    if (r.causal_chain && r.causal_chain !== 'company-specific') lines.push(`- **Causal chain:** ${r.causal_chain}`);
    if (r.expected_timing) {
      const move = r.expected_move_pct ? ` · expected move ${pct(r.expected_move_pct)}` : '';
      lines.push(`- **Timing:** ${r.expected_timing}${move}`);
    }
    for (const ev of r.events ?? []) {
      const progress = ev.movedPct != null ? ` — ${pct(ev.movedPct)} of a forecast ${ev.expectedMovePct.toFixed(1)}% so far` : '';
      lines.push(
        `- **Event: ${ev.event}**${ev.ongoing ? ' (ongoing)' : ''} — ${ev.direction} over ${LAG_LABEL[ev.lag]}, ` +
          `${STATUS_LABEL[ev.status] ?? ev.status}${progress}`,
      );
    }
    if (r.watch_signals?.length) lines.push(`- **Watch:** ${r.watch_signals.join('; ')}`);
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

  if (report.events?.length) {
    lines.push('## Event transmission map');
    lines.push('');
    lines.push('How each event should move markets, how long the effect should take, and how far each asset has moved since the event first broke.');
    lines.push('');
    for (const e of report.events) {
      lines.push(`### ${e.name}`);
      lines.push('');
      lines.push(
        `Severity ${e.severity}/5 · ${e.category.replace(/_/g, ' ')} · ${e.status.replace(/_/g, ' ')}` +
          `${e.effectiveDate ? ` (effective ${e.effectiveDate})` : ''} · ${e.regions.join(', ') || 'global'} · ` +
          `${e.independentReports} independent reports across ${e.outlets.length} outlets (${e.outlets.join(', ')}) · ` +
          `first reported ${date(e.firstReported)}${e.ongoing ? ' · ongoing, no new coverage this run' : ''}`,
      );
      lines.push('');
      lines.push(e.summary);
      lines.push('');
      if (e.channels.length) {
        lines.push('| Asset | Direction | Order | Mechanism | Lands in | Expected | So far | Status |');
        lines.push('|---|---|---|---|---|---:|---:|---|');
        for (const c of e.channels) {
          lines.push(
            `| **${cell(c.symbol)}** ${cell(c.name)} | ${c.direction === 'up' ? '▲ up' : '▼ down'} | ${c.order} | ${cell(c.mechanism)} | ` +
              `${LAG_LABEL[c.lag]} | ${c.expectedMovePct.toFixed(1)}% | ${pct(c.movedPct)} | ${STATUS_LABEL[c.status] ?? c.status} |`,
          );
        }
        lines.push('');
      }
      lines.push(`*Outlook:* ${e.outlook}`);
      lines.push('');
    }
  }

  if (report.marketMap?.rows?.length) {
    lines.push('## Market flux');
    lines.push('');
    const anomalies = report.marketMap.anomalies;
    if (anomalies.length) {
      lines.push('Unusually large moves (1.5+ standard deviations for that instrument):');
      lines.push('');
      lines.push('| Instrument | Group | 1d | 5d | Size of move |');
      lines.push('|---|---|---:|---:|---:|');
      for (const r of anomalies) {
        const z = Math.abs(r.move1dZ ?? 0) >= Math.abs(r.move5dZ ?? 0) ? `${r.move1dZ}σ (1d)` : `${r.move5dZ}σ (5d)`;
        lines.push(`| ${cell(r.label)} (${r.symbol}) | ${r.group} | ${pct(r.change1dPct)} | ${pct(r.change5dPct)} | ${z} |`);
      }
      lines.push('');
    } else {
      lines.push('No unusually large moves across the market map.');
      lines.push('');
    }
    lines.push('<details><summary>Full market map</summary>');
    lines.push('');
    lines.push('| Group | Instrument | Price | 1d | 5d | 1mo | Trend |');
    lines.push('|---|---|---:|---:|---:|---:|---|');
    for (const r of report.marketMap.rows) {
      lines.push(`| ${r.group} | ${cell(r.label)} (${r.symbol}) | ${r.price ?? 'n/a'} | ${pct(r.change1dPct)} | ${pct(r.change5dPct)} | ${pct(r.change1moPct)} | ${r.trend} |`);
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  const sc = report.scorecard;
  if (sc) {
    lines.push('## Forecast track record');
    lines.push('');
    if (sc.graded === 0) {
      lines.push('No forecasts have reached the end of their window yet. Forecasts are graded automatically as their windows close.');
    } else {
      lines.push(
        `${sc.graded} forecasts graded: **${sc.hits} hits**, ${sc.partial} partial, ${sc.misses} misses ` +
          `(hit rate ${Math.round(sc.hitRate * 100)}%). A hit means the asset moved at least half the forecast in the predicted direction.`,
      );
      lines.push('');
      lines.push('| Lands in | Graded | Hits | Partial | Misses |');
      lines.push('|---|---:|---:|---:|---:|');
      for (const [lag, t] of Object.entries(sc.byLag)) lines.push(`| ${LAG_LABEL[lag]} | ${t.graded} | ${t.hits} | ${t.partial} | ${t.misses} |`);
      if (sc.recent.length) {
        lines.push('');
        lines.push('Most recently graded:');
        lines.push('');
        for (const r of sc.recent) {
          lines.push(`- ${r.outcome.toUpperCase()}: ${r.symbol} ${r.direction} on "${r.event}", forecast ${r.expectedMovePct.toFixed(1)}%, moved ${pct(r.movedPct)}`);
        }
      }
    }
    lines.push('');
  }

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
