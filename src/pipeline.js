import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { finalizeItem } from './content/finalize.js';
import { approvalEmail, returnedEmail, publishFailedEmail } from './render/emails.js';

export class ActionError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}

async function readMarketNotes(agent) {
  if (!agent.marketNotesFile) return null;
  try {
    return (await readFile(agent.marketNotesFile, 'utf8')).trim() || null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// The approval workflow shared by every sales agent:
// generate -> email approver -> approve (publish) or send back -> reviewer revises -> resend.
export function createPipeline({ agents, store, generator, publisher, mailer, links, log = console }) {
  function getAgent(agentId) {
    const agent = agents.get(agentId);
    if (!agent) throw new ActionError(`Unknown agent: ${agentId}`, 404);
    return agent;
  }

  async function notify(to, email) {
    if (!to) {
      log.warn?.(`No recipient configured for "${email.subject}"; not sent.`);
      return;
    }
    try {
      await mailer.send({ to, ...email });
    } catch (error) {
      log.error?.(`Email "${email.subject}" to ${to} failed:`, error.message);
    }
  }

  async function createPackage(agentId, { brief, drafts, revisionOf = null } = {}) {
    const agent = getAgent(agentId);
    let theme = 'Revised for your approval';
    if (!drafts) {
      const generated = await generator.generate({
        agent,
        brief,
        marketNotes: await readMarketNotes(agent),
        recentTitles: store.recentTitles(agentId),
      });
      theme = generated.theme;
      drafts = generated.items;
    }
    if (!drafts.length) throw new ActionError('No content was produced.', 502);

    const id = `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 6)}`;
    const pkg = store.savePackage({
      id,
      agentId,
      theme,
      revisionOf,
      createdAt: new Date().toISOString(),
      items: drafts.map((draft) => finalizeItem(agent, id, draft)),
    });

    await notify(agent.approver.email, approvalEmail({ agent, pkg, url: links.url({ packageId: id, role: 'approver' }) }));
    return pkg;
  }

  function requireItem(pkg, itemId, ...statuses) {
    const item = pkg.items.find((i) => i.id === itemId);
    if (!item) throw new ActionError('Item not found.', 404);
    if (!statuses.includes(item.status)) throw new ActionError(`This piece is already ${item.status.replace('_', ' ')}.`);
    return item;
  }

  const reviewerUrl = (pkg) => links.url({ packageId: pkg.id, role: 'reviewer' });

  async function approve(pkg, itemId) {
    const agent = getAgent(pkg.agentId);
    const item = requireItem(pkg, itemId, 'pending');
    store.updateItem(pkg.id, itemId, { status: 'approved', decidedAt: new Date().toISOString() });
    try {
      const result = await publisher.publish(agent, pkg, item);
      return store.updateItem(pkg.id, itemId, { status: 'published', publishedAt: new Date().toISOString(), publishResult: result });
    } catch (error) {
      log.error?.(`Publishing ${pkg.id}/${itemId} failed:`, error.message);
      const failed = store.updateItem(pkg.id, itemId, { status: 'publish_failed', publishError: error.message });
      await notify(agent.reviewer.email, publishFailedEmail({ agent, pkg, item: failed, url: reviewerUrl(pkg) }));
      return failed;
    }
  }

  async function sendBack(pkg, itemId, note) {
    const agent = getAgent(pkg.agentId);
    requireItem(pkg, itemId, 'pending');
    const item = store.updateItem(pkg.id, itemId, {
      status: 'returned',
      decidedAt: new Date().toISOString(),
      note: note?.trim() || null,
    });
    await notify(agent.reviewer.email, returnedEmail({ agent, pkg, item, url: reviewerUrl(pkg) }));
    return item;
  }

  async function approveAll(pkg) {
    const results = [];
    for (const item of pkg.items.filter((i) => i.status === 'pending')) {
      results.push(await approve(pkg, item.id));
    }
    return results;
  }

  // Reviewer: send an edited (or AI-rewritten) version back to the approver.
  async function resend(pkg, itemId, { body, rewrite }) {
    const agent = getAgent(pkg.agentId);
    const item = requireItem(pkg, itemId, 'returned', 'publish_failed');
    let draft;
    if (rewrite) {
      draft = await generator.revise({ agent, draft: item.draft, note: item.note, marketNotes: await readMarketNotes(agent) });
    } else {
      if (!body?.trim()) throw new ActionError('The revised text is empty.', 400);
      draft = { ...item.draft, body: body.trim() };
    }
    const next = await createPackage(pkg.agentId, { drafts: [draft], revisionOf: pkg.id });
    return store.updateItem(pkg.id, itemId, { status: 'revised', revisedInto: next.id });
  }

  // Reviewer: retry a piece whose publishing failed, as approved.
  async function retryPublish(pkg, itemId) {
    requireItem(pkg, itemId, 'publish_failed');
    store.updateItem(pkg.id, itemId, { status: 'pending' });
    return approve(pkg, itemId);
  }

  function discard(pkg, itemId) {
    requireItem(pkg, itemId, 'returned', 'publish_failed');
    return store.updateItem(pkg.id, itemId, { status: 'discarded' });
  }

  return { createPackage, approve, sendBack, approveAll, resend, retryPublish, discard, getAgent };
}
