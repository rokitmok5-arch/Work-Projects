import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finalizeItem } from '../src/content/finalize.js';
import { createLinks } from '../src/links.js';
import { agent, draft, setup } from './helpers.js';

test('links verify, reject tampering and expire', () => {
  const links = createLinks({ secret: 's'.repeat(40), ttlDays: 1, baseUrl: 'http://x' });
  const token = links.create({ packageId: 'p1', role: 'approver' });
  assert.deepEqual(links.verify(token), { packageId: 'p1', role: 'approver' });

  const [data, mac] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ p: 'p1', r: 'reviewer', e: Date.now() + 1e9 })).toString('base64url');
  assert.equal(links.verify(`${forged}.${mac}`), null);
  assert.equal(links.verify(`${data}.x${mac.slice(1)}`), null);

  const expired = createLinks({ secret: 's'.repeat(40), ttlDays: -1, baseUrl: 'http://x' });
  assert.equal(expired.verify(expired.create({ packageId: 'p1', role: 'approver' })), null);
  assert.throws(() => createLinks({ secret: 'short', ttlDays: 1, baseUrl: 'http://x' }));
});

test('finalized text includes CTA with UTM tags, hashtags and compliance footer', () => {
  const item = finalizeItem(agent, 'pkg1', draft());
  assert.match(item.text, /Book a consultation: https:\/\/calendly\.com\/kevin\?utm_source=linkedin&utm_medium=social&utm_campaign=testco-pkg1/);
  assert.match(item.text, /#luxuryrealestate #estateplanning/);
  assert.ok(item.text.endsWith('Kevin Hood | DRE #123'));

  const ig = finalizeItem(agent, 'pkg1', draft({ channel: 'instagram', cta: 'valuation' }));
  assert.match(ig.text, /Request a private valuation: link in bio\./);
  assert.doesNotMatch(ig.text, /https?:/);
  assert.match(ig.ctaUrl, /utm_source=instagram/);
});

test('createPackage stores pending items and emails the approver', async () => {
  const { pipeline, sent } = setup();
  const pkg = await pipeline.createPackage('testco');
  assert.equal(pkg.items.length, 2);
  assert.ok(pkg.items.every((i) => i.status === 'pending'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'kevin@example.com');
  assert.match(sent[0].html, /http:\/\/test\.local\/r\//);
});

test('approve publishes once; a second approve is rejected', async () => {
  const { pipeline, published } = setup();
  const pkg = await pipeline.createPackage('testco');
  const item = await pipeline.approve(pkg, pkg.items[0].id);
  assert.equal(item.status, 'published');
  assert.equal(published.length, 1);
  await assert.rejects(pipeline.approve(pkg, pkg.items[0].id), /already published/);
  assert.equal(published.length, 1);
});

test('send back notifies the reviewer, who can resend a revision to the approver', async () => {
  const { pipeline, sent, store } = setup();
  const pkg = await pipeline.createPackage('testco');
  const returned = await pipeline.sendBack(pkg, pkg.items[1].id, 'Less formal please');
  assert.equal(returned.status, 'returned');
  assert.equal(sent.at(-1).to, 'marketing@example.com');
  assert.match(sent.at(-1).html, /Less formal please/);

  const revised = await pipeline.resend(pkg, returned.id, { rewrite: true });
  assert.equal(revised.status, 'revised');
  const next = store.getPackage(revised.revisedInto);
  assert.equal(next.revisionOf, pkg.id);
  assert.match(next.items[0].text, /Revised for: Less formal please/);
  assert.equal(sent.at(-1).to, 'kevin@example.com');
});

test('a failed publish is recorded and the reviewer is told', async () => {
  const { pipeline, sent } = setup({ publish: async () => { throw new Error('HTTP 500'); } });
  const pkg = await pipeline.createPackage('testco');
  const item = await pipeline.approve(pkg, pkg.items[0].id);
  assert.equal(item.status, 'publish_failed');
  assert.equal(item.publishError, 'HTTP 500');
  assert.match(sent.at(-1).subject, /publishing failed/);
});
