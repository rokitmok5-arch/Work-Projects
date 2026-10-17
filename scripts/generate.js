// Generate a content package now and email it for approval.
// Usage: npm run generate -- <agentId> ["optional brief for this week"]
import { buildServices } from '../src/server.js';

const [agentId, brief] = process.argv.slice(2);
if (!agentId) {
  console.error('Usage: npm run generate -- <agentId> ["optional brief"]');
  process.exit(1);
}

const { pipeline, links } = await buildServices();
const pkg = await pipeline.createPackage(agentId, { brief });
console.log(`Package ${pkg.id}: ${pkg.theme} (${pkg.items.length} pieces)`);
console.log(`Approver link: ${links.url({ packageId: pkg.id, role: 'approver' })}`);
