import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline, saveReport, loadProfile, REPORTS_DIR } from './pipeline.js';
import { describeApiError } from './llm.js';

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

// Optional: refresh automatically every N hours (e.g. ADVISOR_REFRESH_HOURS=24).
const refreshHours = Number(process.env.ADVISOR_REFRESH_HOURS);
if (refreshHours > 0) {
  setInterval(() => startRun(), refreshHours * 3600 * 1000);
}

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`Investment advisor agent listening on http://localhost:${PORT}`);
});
