import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type {
  McpRepository,
  McpRepositoryIndex,
  McpRepositorySourceType,
  McpServer,
} from '@runova/core';
import { bundledMcpDirectory, bundledMcpRepository, parseMcpRepositoryIndex } from '@runova/core';
import { app, dialog, ipcMain } from 'electron';
import type { InstalledMcpServerRecord } from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { store } from '../store';

const execFileAsync = promisify(execFile);

function repoCacheDir(repositoryId: string): string {
  return join(app.getPath('userData'), 'mcp-repo-cache', repositoryId);
}

function installedServersFilePath(projectFolderPath: string): string {
  return join(projectFolderPath, '.runova', 'installed-mcp-servers.json');
}

function mcpConfigFilePath(projectFolderPath: string): string {
  return join(projectFolderPath, '.mcp.json');
}

async function readInstalledServers(
  projectFolderPath: string,
): Promise<InstalledMcpServerRecord[]> {
  try {
    const raw = await readFile(installedServersFilePath(projectFolderPath), 'utf-8');
    return JSON.parse(raw) as InstalledMcpServerRecord[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function writeInstalledServers(
  projectFolderPath: string,
  records: InstalledMcpServerRecord[],
): Promise<void> {
  const filePath = installedServersFilePath(projectFolderPath);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(records, null, 2), 'utf-8');
}

interface McpJsonConfig {
  mcpServers?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

async function readMcpConfig(projectFolderPath: string): Promise<McpJsonConfig> {
  try {
    return JSON.parse(
      await readFile(mcpConfigFilePath(projectFolderPath), 'utf-8'),
    ) as McpJsonConfig;
  } catch {
    return {};
  }
}

async function writeMcpConfig(projectFolderPath: string, config: McpJsonConfig): Promise<void> {
  await writeFile(mcpConfigFilePath(projectFolderPath), JSON.stringify(config, null, 2), 'utf-8');
}

/** Builds the `.mcp.json` server entry for a marketplace server, merging in user-supplied env values. */
function buildServerEntry(
  server: McpServer,
  envOverrides: Record<string, string>,
): Record<string, unknown> {
  const env = { ...server.config.env, ...envOverrides };
  if (server.config.transport === 'stdio') {
    const entry: Record<string, unknown> = {
      command: server.config.command,
      args: server.config.args,
    };
    if (Object.keys(env).length > 0) entry.env = env;
    return entry;
  }
  const entry: Record<string, unknown> = { type: server.config.transport, url: server.config.url };
  if (Object.keys(env).length > 0) entry.env = env;
  return entry;
}

/** Resolves a repository's index and the base directory/URL its skill file paths are relative to. */
async function loadRepositoryIndex(repo: McpRepository): Promise<{ index: McpRepositoryIndex }> {
  if (repo.sourceType === 'bundled') {
    return { index: bundledMcpDirectory };
  }

  if (repo.sourceType === 'local-folder') {
    const raw = await readFile(join(repo.source, 'repository.json'), 'utf-8');
    return { index: parseMcpRepositoryIndex(JSON.parse(raw)) };
  }

  if (repo.sourceType === 'git') {
    const cacheDir = repoCacheDir(repo.id);
    const alreadyCloned = await readFile(join(cacheDir, 'repository.json'), 'utf-8')
      .then(() => true)
      .catch(() => false);
    if (!alreadyCloned) {
      await mkdir(dirname(cacheDir), { recursive: true });
      await execFileAsync('git', ['clone', '--depth=1', repo.source, cacheDir]);
    } else {
      await execFileAsync('git', ['-C', cacheDir, 'pull', '--ff-only']).catch(() => undefined);
    }
    const raw = await readFile(join(cacheDir, 'repository.json'), 'utf-8');
    return { index: parseMcpRepositoryIndex(JSON.parse(raw)) };
  }

  // 'url'
  const response = await fetch(repo.source);
  if (!response.ok) throw new Error(`Failed to fetch repository index: HTTP ${response.status}`);
  const json = await response.json();
  return { index: parseMcpRepositoryIndex(json) };
}

/** The bundled repo is shipped with the app, not persisted in `mcp-repositories.json`. */
function findRepository(repositoryId: string, repos: McpRepository[]): McpRepository | undefined {
  if (repositoryId === bundledMcpRepository.id) return bundledMcpRepository;
  return repos.find((r) => r.id === repositoryId);
}

export function registerMcpHandlers(): void {
  ipcMain.handle(
    IPC.mcp.listRepositories,
    async (): Promise<McpRepository[]> => [
      bundledMcpRepository,
      ...(await store.getMcpRepositories()),
    ],
  );

  ipcMain.handle(
    IPC.mcp.addRepository,
    async (
      _event,
      input: { name: string; sourceType: McpRepositorySourceType; source: string },
    ): Promise<McpRepository> => {
      const repo: McpRepository = {
        id: randomUUID(),
        name: input.name,
        sourceType: input.sourceType,
        source: input.source,
        addedAt: new Date().toISOString(),
        lastRefreshedAt: null,
      };
      await loadRepositoryIndex(repo);
      const repos = await store.getMcpRepositories();
      repos.unshift({ ...repo, lastRefreshedAt: new Date().toISOString() });
      await store.setMcpRepositories(repos);
      return repo;
    },
  );

  ipcMain.handle(IPC.mcp.removeRepository, async (_event, repositoryId: string): Promise<void> => {
    if (repositoryId === bundledMcpRepository.id) {
      throw new Error("The built-in Bowora MCP directory can't be removed.");
    }
    const repos = await store.getMcpRepositories();
    await store.setMcpRepositories(repos.filter((r) => r.id !== repositoryId));
    await rm(repoCacheDir(repositoryId), { recursive: true, force: true });
  });

  ipcMain.handle(
    IPC.mcp.refreshRepository,
    async (_event, repositoryId: string): Promise<McpRepositoryIndex> => {
      if (repositoryId === bundledMcpRepository.id) return bundledMcpDirectory;
      const repos = await store.getMcpRepositories();
      const repo = repos.find((r) => r.id === repositoryId);
      if (!repo) throw new Error(`Repository ${repositoryId} not found`);
      if (repo.sourceType === 'git') {
        await rm(repoCacheDir(repositoryId), { recursive: true, force: true });
      }
      const { index } = await loadRepositoryIndex(repo);
      repo.lastRefreshedAt = new Date().toISOString();
      await store.setMcpRepositories(repos);
      return index;
    },
  );

  ipcMain.handle(
    IPC.mcp.getRepositoryIndex,
    async (_event, repositoryId: string): Promise<McpRepositoryIndex> => {
      const repos = await store.getMcpRepositories();
      const repo = findRepository(repositoryId, repos);
      if (!repo) throw new Error(`Repository ${repositoryId} not found`);
      const { index } = await loadRepositoryIndex(repo);
      return index;
    },
  );

  ipcMain.handle(IPC.mcp.pickLocalRepository, async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle(
    IPC.mcp.install,
    async (
      _event,
      params: {
        projectId: string;
        repositoryId: string;
        serverId: string;
        env?: Record<string, string>;
      },
    ): Promise<void> => {
      const [projects, repos] = await Promise.all([
        store.getProjects(),
        store.getMcpRepositories(),
      ]);
      const project = projects.find((p) => p.id === params.projectId);
      if (!project) throw new Error(`Project ${params.projectId} not found`);
      const repo = findRepository(params.repositoryId, repos);
      if (!repo) throw new Error(`Repository ${params.repositoryId} not found`);

      const { index } = await loadRepositoryIndex(repo);
      const server = index.servers.find((s) => s.id === params.serverId);
      if (!server)
        throw new Error(`MCP server ${params.serverId} not found in repository ${repo.name}`);

      const config = await readMcpConfig(project.folderPath);
      config.mcpServers = { ...(config.mcpServers ?? {}) };
      config.mcpServers[server.id] = buildServerEntry(server, params.env ?? {});
      await writeMcpConfig(project.folderPath, config);

      const installed = await readInstalledServers(project.folderPath);
      const withoutExisting = installed.filter((s) => s.serverId !== server.id);
      withoutExisting.push({
        serverId: server.id,
        repositoryId: repo.id,
        version: server.version,
        installedAt: new Date().toISOString(),
      });
      await writeInstalledServers(project.folderPath, withoutExisting);
    },
  );

  ipcMain.handle(
    IPC.mcp.remove,
    async (_event, params: { projectId: string; serverId: string }): Promise<void> => {
      const projects = await store.getProjects();
      const project = projects.find((p) => p.id === params.projectId);
      if (!project) throw new Error(`Project ${params.projectId} not found`);

      const config = await readMcpConfig(project.folderPath);
      if (config.mcpServers) {
        delete config.mcpServers[params.serverId];
        await writeMcpConfig(project.folderPath, config);
      }

      const installed = await readInstalledServers(project.folderPath);
      await writeInstalledServers(
        project.folderPath,
        installed.filter((s) => s.serverId !== params.serverId),
      );
    },
  );

  ipcMain.handle(
    IPC.mcp.listInstalled,
    async (_event, projectId: string): Promise<InstalledMcpServerRecord[]> => {
      const projects = await store.getProjects();
      const project = projects.find((p) => p.id === projectId);
      if (!project) throw new Error(`Project ${projectId} not found`);
      return readInstalledServers(project.folderPath);
    },
  );
}
