import { createHmac, timingSafeEqual } from 'node:crypto';

// Signed, expiring review links. The token says which package and which role
// (approver or reviewer) it grants, so emails need no login.
export function createLinks({ secret, ttlDays, baseUrl }) {
  if (!secret || secret.length < 32) {
    throw new Error('LINK_SIGNING_SECRET must be set to a random string of at least 32 characters.');
  }

  const sign = (data) => createHmac('sha256', secret).update(data).digest('base64url');

  function create({ packageId, role }) {
    const payload = { p: packageId, r: role, e: Date.now() + ttlDays * 86_400_000 };
    const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${data}.${sign(data)}`;
  }

  function verify(token) {
    const [data, mac] = String(token).split('.');
    if (!data || !mac) return null;
    const expected = Buffer.from(sign(data));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    try {
      const payload = JSON.parse(Buffer.from(data, 'base64url').toString());
      if (payload.e < Date.now()) return null;
      return { packageId: payload.p, role: payload.r };
    } catch {
      return null;
    }
  }

  const url = (args) => `${baseUrl}/r/${create(args)}`;

  return { create, verify, url };
}
