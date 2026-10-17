import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import { ActionError } from './pipeline.js';
import { renderCard, renderMessagePage, renderReviewPage } from './render/reviewPage.js';

const APPROVER_ACTIONS = new Set(['approve', 'return']);
const REVIEWER_ACTIONS = new Set(['resend', 'rewrite', 'discard', 'retry']);

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createApp({ pipeline, store, links, adminKey, log = console }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(express.json({ limit: '100kb' }));

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // --- Review links (from emails). Viewing is GET; every action is POST, so
  // email link scanners that open URLs can never approve anything.
  const review = express.Router({ mergeParams: true });
  review.use((req, res, next) => {
    res.set({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex' });
    const claims = links.verify(req.params.token);
    if (!claims) {
      return res.status(410).send(renderMessagePage('Link expired', 'This review link has expired or is invalid. Ask for a fresh one.'));
    }
    const pkg = store.getPackage(claims.packageId);
    if (!pkg) return res.status(404).send(renderMessagePage('Not found', 'This content package no longer exists.'));
    req.role = claims.role;
    req.pkg = pkg;
    req.agent = pipeline.getAgent(pkg.agentId);
    next();
  });

  review.get('/', (req, res) => {
    res.send(renderReviewPage({ agent: req.agent, pkg: req.pkg, role: req.role, token: req.params.token }));
  });

  review.post('/items/:itemId', async (req, res) => {
    const { decision, note, body } = req.body ?? {};
    const { pkg, role } = req;
    const wantsJson = req.accepts(['html', 'json']) === 'json';
    try {
      const allowed = role === 'approver' ? APPROVER_ACTIONS : REVIEWER_ACTIONS;
      if (!allowed.has(decision)) throw new ActionError('That action is not available on this link.', 403);

      const { itemId } = req.params;
      let item;
      if (decision === 'approve') item = await pipeline.approve(pkg, itemId);
      else if (decision === 'return') item = await pipeline.sendBack(pkg, itemId, note);
      else if (decision === 'resend') item = await pipeline.resend(pkg, itemId, { body });
      else if (decision === 'rewrite') item = await pipeline.resend(pkg, itemId, { rewrite: true });
      else if (decision === 'retry') item = await pipeline.retryPublish(pkg, itemId);
      else item = await pipeline.discard(pkg, itemId);

      if (wantsJson) {
        return res.json({ item, html: renderCard(item, { agent: req.agent, role, token: req.params.token }) });
      }
      res.redirect(303, `/r/${req.params.token}#item-${itemId}`);
    } catch (error) {
      const status = error instanceof ActionError ? error.status : 500;
      if (status === 500) log.error?.('Review action failed:', error);
      const message = status === 500 ? 'Something went wrong. Please try again.' : error.message;
      if (wantsJson) return res.status(status).json({ error: message });
      res.status(status).send(renderMessagePage('Could not do that', message));
    }
  });

  review.post('/approve-all', async (req, res) => {
    if (req.role !== 'approver') return res.status(403).send(renderMessagePage('Not allowed', 'This link cannot approve content.'));
    try {
      await pipeline.approveAll(req.pkg);
    } catch (error) {
      log.error?.('Approve all failed:', error);
    }
    res.redirect(303, `/r/${req.params.token}`);
  });

  app.use('/r/:token', review);

  // --- Admin API (x-admin-key header).
  const admin = express.Router();
  admin.use((req, res, next) => {
    if (!adminKey || !safeEqual(req.get('x-admin-key') ?? '', adminKey)) return res.status(401).json({ error: 'Unauthorized' });
    next();
  });

  // Generate a package now and email it for approval. Body: { "brief": "optional focus" }
  admin.post('/agents/:agentId/packages', async (req, res) => {
    try {
      const pkg = await pipeline.createPackage(req.params.agentId, { brief: req.body?.brief });
      res.status(201).json({ id: pkg.id, theme: pkg.theme, items: pkg.items.length });
    } catch (error) {
      const status = error instanceof ActionError ? error.status : 502;
      log.error?.('Package generation failed:', error);
      res.status(status).json({ error: error.message });
    }
  });

  admin.get('/packages', (req, res) => {
    const summary = store.listPackages(req.query.agentId).map((p) => ({
      id: p.id,
      agentId: p.agentId,
      theme: p.theme,
      createdAt: p.createdAt,
      items: p.items.map((i) => ({ id: i.id, channel: i.channel, title: i.draft.title, status: i.status })),
    }));
    res.json(summary);
  });

  app.use('/admin', admin);

  return app;
}
