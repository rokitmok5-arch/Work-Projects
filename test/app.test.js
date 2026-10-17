import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listen, setup } from './helpers.js';

const form = (data) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
  body: new URLSearchParams(data),
});

test('approver page shows both buttons and GET never changes anything', async () => {
  const { app, pipeline, links, store } = setup();
  const pkg = await pipeline.createPackage('testco');
  const token = links.create({ packageId: pkg.id, role: 'approver' });
  const srv = await listen(app);
  try {
    const res = await fetch(`${srv.base}/r/${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    const html = await res.text();
    assert.match(html, /✓ Approve/);
    assert.match(html, /✕ Send back/);
    assert.ok(store.getPackage(pkg.id).items.every((i) => i.status === 'pending'));
  } finally {
    srv.close();
  }
});

test('one tap approves and returns the updated card', async () => {
  const { app, pipeline, links, published } = setup();
  const pkg = await pipeline.createPackage('testco');
  const token = links.create({ packageId: pkg.id, role: 'approver' });
  const srv = await listen(app);
  try {
    const res = await fetch(`${srv.base}/r/${token}/items/${pkg.items[0].id}`, form({ decision: 'approve' }));
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.item.status, 'published');
    assert.match(data.html, /Approved and published/);
    assert.equal(published.length, 1);

    const again = await fetch(`${srv.base}/r/${token}/items/${pkg.items[0].id}`, form({ decision: 'approve' }));
    assert.equal(again.status, 409);
  } finally {
    srv.close();
  }
});

test('approver links cannot use reviewer actions, and vice versa', async () => {
  const { app, pipeline, links } = setup();
  const pkg = await pipeline.createPackage('testco');
  const approver = links.create({ packageId: pkg.id, role: 'approver' });
  const reviewer = links.create({ packageId: pkg.id, role: 'reviewer' });
  const srv = await listen(app);
  try {
    let res = await fetch(`${srv.base}/r/${approver}/items/${pkg.items[0].id}`, form({ decision: 'discard' }));
    assert.equal(res.status, 403);
    res = await fetch(`${srv.base}/r/${reviewer}/items/${pkg.items[0].id}`, form({ decision: 'approve' }));
    assert.equal(res.status, 403);
  } finally {
    srv.close();
  }
});

test('approve all, form fallback redirects, and bad tokens are refused', async () => {
  const { app, pipeline, links, store } = setup();
  const pkg = await pipeline.createPackage('testco');
  const token = links.create({ packageId: pkg.id, role: 'approver' });
  const srv = await listen(app);
  try {
    const res = await fetch(`${srv.base}/r/${token}/approve-all`, { method: 'POST', redirect: 'manual' });
    assert.equal(res.status, 303);
    assert.ok(store.getPackage(pkg.id).items.every((i) => i.status === 'published'));

    const bad = await fetch(`${srv.base}/r/not-a-token`);
    assert.equal(bad.status, 410);
  } finally {
    srv.close();
  }
});

test('admin endpoints require the admin key', async () => {
  const { app } = setup();
  const srv = await listen(app);
  try {
    let res = await fetch(`${srv.base}/admin/agents/testco/packages`, { method: 'POST' });
    assert.equal(res.status, 401);
    res = await fetch(`${srv.base}/admin/agents/testco/packages`, {
      method: 'POST',
      headers: { 'x-admin-key': 'admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ brief: 'Focus on Del Mar' }),
    });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).items, 2);
  } finally {
    srv.close();
  }
});
