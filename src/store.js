import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Small JSON-file store. Fine for a single server; swap for a database when
// several agents run on more than one machine.
export function createStore(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  let state = { packages: {} };
  try {
    state = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  function persist() {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, file);
  }

  return {
    savePackage(pkg) {
      state.packages[pkg.id] = pkg;
      persist();
      return pkg;
    },
    getPackage(id) {
      return state.packages[id] ?? null;
    },
    listPackages(agentId) {
      return Object.values(state.packages)
        .filter((p) => !agentId || p.agentId === agentId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    updateItem(packageId, itemId, changes) {
      const item = state.packages[packageId]?.items.find((i) => i.id === itemId);
      if (!item) return null;
      Object.assign(item, changes);
      persist();
      return item;
    },
    // Titles of recent pieces, so new packages don't repeat them.
    recentTitles(agentId, limit = 30) {
      return this.listPackages(agentId)
        .flatMap((p) => p.items)
        .filter((i) => i.status !== 'discarded')
        .slice(0, limit)
        .map((i) => i.draft.title);
    },
  };
}
