import { randomUUID } from 'node:crypto';

const MEDIUM = { instagram: 'social', facebook: 'social', linkedin: 'social', newsletter: 'email' };

export function trackedUrl(url, { agentId, channel, packageId }) {
  const u = new URL(url);
  u.searchParams.set('utm_source', channel);
  u.searchParams.set('utm_medium', MEDIUM[channel] ?? 'social');
  u.searchParams.set('utm_campaign', `${agentId}-${packageId}`);
  return u.toString();
}

// Turns a model draft into the exact text that will be published, so the
// approver sees precisely what goes out.
export function finalizeItem(agent, packageId, draft) {
  const cta = agent.ctas[draft.cta];
  const ctaUrl = trackedUrl(cta.url, { agentId: agent.id, channel: draft.channel, packageId });
  const tags = draft.hashtags.map((t) => `#${t.replace(/^#/, '').replace(/\s+/g, '')}`).join(' ');

  // Instagram captions can't hold clickable links, so point to the bio link.
  const ctaLine = draft.channel === 'instagram' ? `${cta.label}: link in bio.` : `${cta.label}: ${ctaUrl}`;

  const parts = [draft.body.trim(), ctaLine];
  if (tags && draft.channel !== 'newsletter') parts.push(tags);
  parts.push(agent.complianceFooter);

  return {
    id: randomUUID().slice(0, 8),
    status: 'pending',
    draft,
    channel: draft.channel,
    subject: draft.channel === 'newsletter' ? draft.subject : null,
    text: parts.join('\n\n'),
    ctaUrl,
    createdAt: new Date().toISOString(),
  };
}
