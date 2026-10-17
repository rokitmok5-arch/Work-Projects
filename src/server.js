import path from 'node:path';
import { pathToFileURL } from 'node:url';
import cron from 'node-cron';
import { config } from './config.js';
import { loadAgents } from './agents.js';
import { createApp } from './app.js';
import { createGenerator } from './content/generator.js';
import { createLinks } from './links.js';
import { createMailer } from './mailer.js';
import { createPipeline } from './pipeline.js';
import { createPublisher } from './publisher.js';
import { createStore } from './store.js';

export async function buildServices() {
  const agents = await loadAgents();
  const store = createStore(path.join(config.dataDir, 'store.json'));
  const links = createLinks({ secret: config.linkSecret, ttlDays: config.linkTtlDays, baseUrl: config.publicBaseUrl });
  const pipeline = createPipeline({
    agents,
    store,
    links,
    generator: createGenerator({ model: config.model }),
    publisher: createPublisher(),
    mailer: createMailer({ smtp: config.smtp, dataDir: config.dataDir }),
  });
  return { agents, store, links, pipeline };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { agents, store, links, pipeline } = await buildServices();
  const app = createApp({ pipeline, store, links, adminKey: config.adminKey });

  if (config.enableScheduler) {
    for (const agent of agents.values()) {
      if (!agent.schedule?.cron) continue;
      cron.schedule(
        agent.schedule.cron,
        () => pipeline.createPackage(agent.id).catch((error) => console.error(`Scheduled package for ${agent.id} failed:`, error)),
        { timezone: agent.schedule.timezone },
      );
      console.log(`Scheduled ${agent.id}: "${agent.schedule.cron}" (${agent.schedule.timezone ?? 'server time'})`);
    }
  }

  app.listen(config.port, () => {
    console.log(`Content agent server listening on ${config.publicBaseUrl} (agents: ${[...agents.keys()].join(', ')})`);
  });
}
