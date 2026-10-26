import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { app } from 'electron';
import { store } from './store';

function getExampleRepoPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'example-skill-repo')
    : join(__dirname, '../../resources/example-skill-repo');
}

/** Gives the marketplace real content on first launch, without requiring network access. */
export async function seedExampleRepositoryIfEmpty(): Promise<void> {
  const repos = await store.getRepositories();
  if (repos.length > 0) return;

  const now = new Date().toISOString();
  repos.push({
    id: randomUUID(),
    name: 'Runova Examples',
    sourceType: 'local-folder',
    source: getExampleRepoPath(),
    addedAt: now,
    lastRefreshedAt: now,
  });
  await store.setRepositories(repos);
}
