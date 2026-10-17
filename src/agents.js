import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const AGENTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'agents');
const REQUIRED = ['id', 'company', 'agentName', 'approver', 'reviewer', 'ctas', 'mix', 'complianceFooter'];

export function validateAgent(agent, source = agent?.id) {
  const missing = REQUIRED.filter((key) => agent?.[key] == null);
  if (missing.length) throw new Error(`Agent ${source} is missing: ${missing.join(', ')}`);
  if (!/^[a-z0-9-]+$/.test(agent.id)) throw new Error(`Agent id "${agent.id}" must be lowercase letters, digits or dashes`);
  for (const key of ['valuation', 'consultation']) {
    if (!agent.ctas[key]?.url) throw new Error(`Agent ${agent.id} needs ctas.${key}.url`);
  }
  return agent;
}

// Loads every agents/*.js file except those starting with "_".
export async function loadAgents(dir = AGENTS_DIR) {
  const agents = new Map();
  const files = (await readdir(dir)).filter((f) => f.endsWith('.js') && !f.startsWith('_'));
  for (const file of files) {
    const { default: agent } = await import(pathToFileURL(path.join(dir, file)).href);
    validateAgent(agent, file);
    if (agents.has(agent.id)) throw new Error(`Duplicate agent id: ${agent.id}`);
    agents.set(agent.id, agent);
  }
  return agents;
}
