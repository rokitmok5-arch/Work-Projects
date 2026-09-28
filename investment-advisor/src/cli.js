#!/usr/bin/env node
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { runPipeline, saveReport, loadProfile } from './pipeline.js';
import { describeApiError } from './llm.js';

const { values } = parseArgs({
  options: {
    profile: { type: 'string', short: 'p' },
    hours: { type: 'string', default: '72' },
    'per-source': { type: 'string', default: '60' },
    'min-sources': { type: 'string', default: '2' },
    picks: { type: 'string', default: '10-20' },
    quiet: { type: 'boolean', short: 'q', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(`Usage: npm run advise -- [options]

  -p, --profile <file>     Investor profile JSON (default: profile.json, then profile.example.json)
      --hours <n>          Only use articles from the last n hours (default 72)
      --per-source <n>     Max articles per outlet, balanced across its feeds (default 60)
      --min-sources <n>    Outlets that must agree before an asset is a candidate (default 2)
      --picks <min-max>    Number of recommendations (default 10-20)
  -q, --quiet              Only print the final report`);
  process.exit(0);
}

if (values.quiet) process.env.ADVISOR_QUIET = '1';
const [minPicks, maxPicks] = values.picks.split('-').map(Number);

try {
  const report = await runPipeline({
    profile: await loadProfile(values.profile),
    lookbackHours: Number(values.hours),
    maxPerSource: Number(values['per-source']),
    minSources: Number(values['min-sources']),
    minPicks,
    maxPicks: maxPicks || minPicks,
    onStage: (stage) => !values.quiet && console.error(`[advisor] == ${stage} ==`),
  });
  const files = await saveReport(report);
  console.log(report.markdown);
  console.error(`\nSaved ${files.markdown}\n      ${files.json}`);
} catch (err) {
  console.error(`Advisor run failed: ${describeApiError(err)}`);
  process.exit(1);
}
