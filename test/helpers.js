import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { createLinks } from '../src/links.js';
import { createPipeline } from '../src/pipeline.js';
import { createStore } from '../src/store.js';

export const agent = {
  id: 'testco',
  company: 'Test Realty',
  agentName: 'Kevin Hood',
  agentTitle: 'Broker',
  approver: { name: 'Kevin', email: 'kevin@example.com' },
  reviewer: { name: 'Marketing', email: 'marketing@example.com' },
  complianceFooter: 'Kevin Hood | DRE #123',
  market: 'Coastal',
  ctas: {
    valuation: { label: 'Request a private valuation', url: 'https://example.com/valuation' },
    consultation: { label: 'Book a consultation', url: 'https://calendly.com/kevin' },
  },
  mix: { instagram: 1, linkedin: 1 },
  publishers: {},
};

export const draft = (overrides = {}) => ({
  channel: 'linkedin',
  title: 'Trusts and coastal homes',
  subject: null,
  body: 'Holding a second home in a trust is worth discussing with your attorney.',
  hashtags: ['luxuryrealestate', 'estateplanning'],
  cta: 'consultation',
  visual: 'Ocean view terrace at dusk',
  why: 'Speaks to estate planning questions clients ask.',
  ...overrides,
});

export function setup({ publish } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-test-'));
  const store = createStore(path.join(dir, 'store.json'));
  const links = createLinks({ secret: 'x'.repeat(40), ttlDays: 14, baseUrl: 'http://test.local' });
  const sent = [];
  const published = [];
  const generator = {
    generate: async () => ({ theme: 'Test theme', items: [draft({ channel: 'instagram', cta: 'valuation', title: 'IG post' }), draft()] }),
    revise: async ({ draft: d, note }) => ({ ...d, body: `Revised for: ${note}` }),
  };
  const publisher = {
    publish: publish ?? (async (a, pkg, item) => {
      published.push(item);
      return { mode: 'webhook', status: 200 };
    }),
  };
  const mailer = { send: async (email) => sent.push(email) };
  const quiet = { info() {}, warn() {}, error() {} };
  const pipeline = createPipeline({ agents: new Map([[agent.id, agent]]), store, generator, publisher, mailer, links, log: quiet });
  const app = createApp({ pipeline, store, links, adminKey: 'admin-secret', log: quiet });
  return { dir, store, links, pipeline, app, sent, published };
}

export async function listen(app) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}
