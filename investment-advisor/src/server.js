import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline, saveReport, loadProfile, REPORTS_DIR } from './pipeline.js';
import { describeApiError } from './llm.js';
import { runCheck, planForNewBuy } from './check.js';
import { loadPortfolio, savePortfolio, applyTrade } from './portfolio.js';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')));

// A full run takes several minutes, so runs happen in the background and the
// client polls /api/status. Only one run at a time.
const job = { running: false, stage: null, startedAt: null, finishedAt: null, error: null };

async function startRun(options = {}) {
  if (job.running) return false;
  Object.assign(job, { running: true, stage: 'starting', startedAt: new Date().toISOString(), finishedAt: null, error: null });
  (async () => {
    try {
      const report = await runPipeline({
        profile: options.profile ?? (await loadProfile()),
        lookbackHours: options.lookbackHours ?? 72,
        onStage: (stage) => (job.stage = stage),
      });
      await saveReport(report);
    } catch (err) {
      console.error('Advisor run failed:', err);
      job.error = describeApiError(err);
    } finally {
      Object.assign(job, { running: false, finishedAt: new Date().toISOString() });
    }
  })();
  return true;
}

app.post('/api/run', async (req, res) => {
  const { profile, lookbackHours } = req.body ?? {};
  if (profile !== undefined && (typeof profile !== 'object' || Array.isArray(profile))) {
    return res.status(400).json({ error: 'profile must be an object.' });
  }
  if (lookbackHours !== undefined && !(Number(lookbackHours) > 0)) {
    return res.status(400).json({ error: 'lookbackHours must be a positive number.' });
  }
  const started = await startRun({ profile, lookbackHours: lookbackHours && Number(lookbackHours) });
  if (!started) return res.status(409).json({ error: 'A run is already in progress.', job });
  res.status(202).json({ job });
});

app.get('/api/status', (req, res) => res.json({ job }));

app.get('/api/report/latest', async (req, res) => {
  try {
    const json = JSON.parse(await fs.readFile(path.join(REPORTS_DIR, 'latest.json'), 'utf8'));
    res.json(json);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'No report yet. POST /api/run to generate one.' });
    res.status(500).json({ error: 'Could not read the latest report.' });
  }
});

app.get('/api/report/latest.md', async (req, res) => {
  try {
    res.type('text/markdown').send(await fs.readFile(path.join(REPORTS_DIR, 'latest.md'), 'utf8'));
  } catch {
    res.status(404).json({ error: 'No report yet.' });
  }
});

// Positions and rule signals. Checks only fetch prices (no AI call), so they are cheap to run often.
app.get('/api/portfolio', async (req, res) => {
  const portfolio = await loadPortfolio();
  if (!portfolio) return res.status(404).json({ error: 'No portfolio yet. Run `npm run portfolio -- init <cash>`.' });
  let signals = null;
  try {
    signals = JSON.parse(await fs.readFile(path.join(REPORTS_DIR, 'signals-latest.json'), 'utf8'));
  } catch {}
  res.json({ portfolio, signals });
});

let checking = null;
app.post('/api/check', async (req, res) => {
  try {
    checking ??= runCheck().finally(() => (checking = null));
    res.json(await checking);
  } catch (err) {
    res.status(err.message.startsWith('No portfolio') ? 404 : 502).json({ error: err.message });
  }
});

app.post('/api/trades', async (req, res) => {
  const { side, symbol, quantity, price, fees, stop, target } = req.body ?? {};
  if (!['buy', 'sell'].includes(side) || typeof symbol !== 'string' || !symbol || quantity == null || price == null) {
    return res.status(400).json({ error: 'side ("buy"|"sell"), symbol, quantity and price are required.' });
  }
  try {
    const portfolio = await loadPortfolio();
    if (!portfolio) return res.status(404).json({ error: 'No portfolio yet.' });
    const sym = symbol.toUpperCase();
    const isNew = side === 'buy' && !portfolio.positions.some((p) => p.symbol === sym);
    const { plan, assetClass } = isNew ? await planForNewBuy({ symbol: sym, price: String(price), stop, target }) : {};
    const next = applyTrade(portfolio, { side, symbol: sym, quantity: String(quantity), price: String(price), fees: String(fees ?? 0), plan, assetClass });
    await savePortfolio(next);
    res.status(201).json({ portfolio: next });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Optional: re-check rules every N minutes against fresh prices (e.g. ADVISOR_CHECK_MINUTES=15).
const checkMinutes = Number(process.env.ADVISOR_CHECK_MINUTES);
if (checkMinutes > 0) {
  setInterval(() => {
    checking ??= runCheck()
      .catch((err) => console.error('Rule check failed:', err.message))
      .finally(() => (checking = null));
  }, checkMinutes * 60 * 1000);
}

// Optional: refresh automatically every N hours (e.g. ADVISOR_REFRESH_HOURS=24).
const refreshHours = Number(process.env.ADVISOR_REFRESH_HOURS);
if (refreshHours > 0) {
  setInterval(() => startRun(), refreshHours * 3600 * 1000);
}

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`Investment advisor agent listening on http://localhost:${PORT}`);
});
