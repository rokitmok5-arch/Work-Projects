import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function sampleFeedXml() {
  return fs
    .readFileSync(path.join(here, 'fixtures', 'sample-feed.xml'), 'utf8')
    .replaceAll('PUBDATE_RECENT', new Date(Date.now() - 3600 * 1000).toUTCString());
}

/** A Yahoo chart payload with a steady trend of `dailyDrift` per day. */
export function chartPayload(symbol, { start = 100, dailyDrift = 0.004, days = 260, instrumentType = 'EQUITY' } = {}) {
  const close = [];
  const volume = [];
  let p = start;
  for (let i = 0; i < days; i++) {
    p *= 1 + dailyDrift + (i % 2 ? 0.003 : -0.003);
    close.push(p);
    volume.push(1_000_000 + (i % 5) * 10_000);
  }
  return {
    chart: {
      result: [
        {
          meta: { symbol, shortName: `${symbol} Inc`, instrumentType, currency: 'USD', regularMarketPrice: p },
          timestamp: close.map((_, i) => 1_700_000_000 + i * 86400),
          indicators: { quote: [{ close, volume }] },
        },
      ],
      error: null,
    },
  };
}

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** An RSS feed whose items were all published an hour ago. */
export function feedXml(items) {
  const pubDate = new Date(Date.now() - 3600 * 1000).toUTCString();
  const body = items
    .map((it, i) => `<item><title>${it.title}</title><link>https://example.com/${encodeURIComponent(it.title)}</link><pubDate>${pubDate}</pubDate><description>${it.description ?? ''}</description></item>`)
    .join('\n');
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${body}</channel></rss>`;
}
