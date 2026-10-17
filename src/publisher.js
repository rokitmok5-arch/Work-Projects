// Sends approved content to its channel. A "webhook" publisher posts JSON to
// Zapier, Make, Buffer or a similar service that does the actual posting.
// Without a URL it runs as a dry run and only logs.
export function createPublisher({ fetchImpl = fetch, log = console } = {}) {
  async function publish(agent, pkg, item) {
    const target = agent.publishers?.[item.channel];
    const payload = {
      agentId: agent.id,
      packageId: pkg.id,
      itemId: item.id,
      channel: item.channel,
      subject: item.subject,
      text: item.text,
      ctaUrl: item.ctaUrl,
      visual: item.draft.visual,
      title: item.draft.title,
    };

    if (target?.type !== 'webhook' || !target.url) {
      log.info?.(`[dry-run] ${agent.id}/${item.channel}: "${item.draft.title}"`);
      return { mode: 'dry-run' };
    }

    const response = await fetchImpl(target.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Publish webhook returned HTTP ${response.status}`);
    return { mode: 'webhook', status: response.status };
  }

  return { publish };
}
