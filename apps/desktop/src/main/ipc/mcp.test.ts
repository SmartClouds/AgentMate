import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpRepository, McpRepositoryIndex } from '@runova/core';
import { bundledMcpRepository } from '@runova/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledMcpServerRecord } from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { queueDialog } from '../../test/main/electronMock';
import { json, type LocalServer, startHttpServer, tempDir } from '../../test/main/fixtures';
import {
  expectChannelsCovered,
  invoke,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';

/**
 * The MCP marketplace: where a repository index comes from, and what installing a server writes
 * into a project's own `.mcp.json`. Local folders and URL repositories are real (a temp folder and
 * a local HTTP server); only `git clone` is stubbed, since that is a process boundary.
 */

const gitCalls = vi.hoisted(() => ({
  /** Every argv git was called with, plus what the clone should leave in the cache folder. */
  calls: [] as string[][],
  cloneIndex: null as unknown,
  fail: false,
}));

vi.mock('node:child_process', async () => {
  const { mkdirSync: makeDir, writeFileSync: write } = await import('node:fs');
  return {
    execFile: (file: string, args: string[], ...rest: unknown[]) => {
      const callback = rest.at(-1) as (error: Error | null, out: unknown) => void;
      gitCalls.calls.push([file, ...args]);
      if (gitCalls.fail) {
        callback(new Error('git clone failed'), { stdout: '', stderr: '' });
        return;
      }
      // A clone writes the index into the cache folder, which is what the handler reads next.
      if (args[0] === 'clone' && gitCalls.cloneIndex) {
        const target = args[args.length - 1];
        makeDir(target, { recursive: true });
        write(join(target, 'repository.json'), JSON.stringify(gitCalls.cloneIndex), 'utf-8');
      }
      callback(null, { stdout: '', stderr: '' });
    },
  };
});

const userData = useTempUserData();
const project = { dir: '' };
let server: LocalServer | null = null;
const PROJECT_ID = 'p1';

expectChannelsCovered(IPC.mcp);

function indexWith(serverId = 'weather'): McpRepositoryIndex {
  return {
    name: 'Test directory',
    description: 'For tests',
    servers: [
      {
        id: serverId,
        name: 'Weather',
        description: 'Weather tools',
        category: 'data',
        tags: [],
        author: 'Runova',
        version: '1.2.0',
        official: false,
        popularity: 0,
        requiredEnv: ['WEATHER_API_KEY'],
        config: {
          transport: 'stdio',
          command: 'npx',
          args: ['-y', 'weather-mcp'],
          env: { WEATHER_REGION: 'eu' },
        },
      },
    ],
  };
}

/** A folder holding a repository.json, the shape a local-folder repository has. */
function localRepoFolder(index: McpRepositoryIndex = indexWith()): string {
  const dir = tempDir('runova-mcp-repo-');
  writeFileSync(join(dir, 'repository.json'), JSON.stringify(index), 'utf-8');
  return dir;
}

async function addLocalRepository(source = localRepoFolder()): Promise<McpRepository> {
  return invoke<McpRepository>(IPC.mcp.addRepository, {
    name: 'Local',
    sourceType: 'local-folder',
    source,
  });
}

function mcpJson(): { mcpServers?: Record<string, Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(project.dir, '.mcp.json'), 'utf-8')) as {
    mcpServers?: Record<string, Record<string, unknown>>;
  };
}

beforeEach(async () => {
  gitCalls.calls = [];
  gitCalls.cloneIndex = null;
  gitCalls.fail = false;
  project.dir = tempDir('runova-mcp-project-');
  userData.writeData('projects.json', [
    { id: PROJECT_ID, name: 'Demo', folderPath: project.dir, createdAt: '2026-01-01T00:00:00Z' },
  ]);
  await loadIpc(
    () => import('./mcp'),
    (module) => module.registerMcpHandlers(),
  );
});

afterEach(async () => {
  await server?.close();
  server = null;
});

describe('mcp repositories', () => {
  it('always lists the built-in directory first', async () => {
    const before = await invoke<McpRepository[]>(IPC.mcp.listRepositories);
    expect(before).toEqual([bundledMcpRepository]);

    const added = await addLocalRepository();
    const after = await invoke<McpRepository[]>(IPC.mcp.listRepositories);
    expect(after.map((repo) => repo.id)).toEqual([bundledMcpRepository.id, added.id]);
  });

  it('checks a local folder really holds an index before saving it', async () => {
    const empty = tempDir('runova-mcp-empty-');
    await expect(
      invoke(IPC.mcp.addRepository, { name: 'Broken', sourceType: 'local-folder', source: empty }),
    ).rejects.toThrow();
    // Nothing was written, so the list is unchanged.
    expect(await invoke<McpRepository[]>(IPC.mcp.listRepositories)).toEqual([bundledMcpRepository]);

    writeFileSync(join(empty, 'repository.json'), JSON.stringify({ name: 'no servers key' }));
    await expect(
      invoke(IPC.mcp.addRepository, { name: 'Broken', sourceType: 'local-folder', source: empty }),
    ).rejects.toThrow();
  });

  it('downloads a url repository index over http', async () => {
    server = await startHttpServer((_request, response) => json(response, indexWith('remote')));
    const added = await invoke<McpRepository>(IPC.mcp.addRepository, {
      name: 'Remote',
      sourceType: 'url',
      source: `${server.url}/index.json`,
    });
    const index = await invoke<McpRepositoryIndex>(IPC.mcp.getRepositoryIndex, added.id);
    expect(index.servers.map((one) => one.id)).toEqual(['remote']);
  });

  it('reports a url repository that answers with an error status', async () => {
    server = await startHttpServer((_request, response) => json(response, { error: 'no' }, 503));
    await expect(
      invoke(IPC.mcp.addRepository, {
        name: 'Down',
        sourceType: 'url',
        source: `${server.url}/index.json`,
      }),
    ).rejects.toThrow('HTTP 503');
  });

  it('clones a git repository into the cache under userData, and pulls on the next read', async () => {
    gitCalls.cloneIndex = indexWith('from-git');
    const added = await invoke<McpRepository>(IPC.mcp.addRepository, {
      name: 'Git',
      sourceType: 'git',
      source: 'https://example.test/mcp-directory.git',
    });

    const cacheDir = join(userData.dir, 'mcp-repo-cache', added.id);
    expect(existsSync(join(cacheDir, 'repository.json'))).toBe(true);
    expect(gitCalls.calls[0]).toEqual([
      'git',
      'clone',
      '--depth=1',
      'https://example.test/mcp-directory.git',
      cacheDir,
    ]);

    // Already cloned: the next read updates in place rather than cloning again.
    const index = await invoke<McpRepositoryIndex>(IPC.mcp.getRepositoryIndex, added.id);
    expect(index.servers[0].id).toBe('from-git');
    expect(gitCalls.calls[1]).toEqual(['git', '-C', cacheDir, 'pull', '--ff-only']);
  });

  it('throws away the cache when a git repository is refreshed', async () => {
    gitCalls.cloneIndex = indexWith('v1');
    const added = await invoke<McpRepository>(IPC.mcp.addRepository, {
      name: 'Git',
      sourceType: 'git',
      source: 'https://example.test/mcp.git',
    });

    gitCalls.cloneIndex = indexWith('v2');
    const refreshed = await invoke<McpRepositoryIndex>(IPC.mcp.refreshRepository, added.id);
    expect(refreshed.servers[0].id).toBe('v2');
    expect(gitCalls.calls.filter((call) => call[1] === 'clone')).toHaveLength(2);

    const stored = await invoke<McpRepository[]>(IPC.mcp.listRepositories);
    expect(stored[1].lastRefreshedAt).not.toBeNull();
  });

  it('serves the built-in directory without touching the network', async () => {
    const index = await invoke<McpRepositoryIndex>(
      IPC.mcp.getRepositoryIndex,
      bundledMcpRepository.id,
    );
    expect(index.servers.length).toBeGreaterThan(0);
    expect(
      await invoke<McpRepositoryIndex>(IPC.mcp.refreshRepository, bundledMcpRepository.id),
    ).toEqual(index);
    expect(gitCalls.calls).toEqual([]);
  });

  it('removes a repository and its cache folder, but never the built-in one', async () => {
    const added = await addLocalRepository();
    const cacheDir = join(userData.dir, 'mcp-repo-cache', added.id);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'repository.json'), '{}', 'utf-8');

    await invoke(IPC.mcp.removeRepository, added.id);
    expect(existsSync(cacheDir)).toBe(false);
    expect(await invoke<McpRepository[]>(IPC.mcp.listRepositories)).toEqual([bundledMcpRepository]);

    await expect(invoke(IPC.mcp.removeRepository, bundledMcpRepository.id)).rejects.toThrow(
      "can't be removed",
    );
  });

  it('refuses to read or refresh a repository id it does not know', async () => {
    await expect(invoke(IPC.mcp.getRepositoryIndex, 'nope')).rejects.toThrow('not found');
    await expect(invoke(IPC.mcp.refreshRepository, 'nope')).rejects.toThrow('not found');
  });

  it('returns the folder the picker chose, or null when it was cancelled', async () => {
    const folder = tempDir('runova-mcp-pick-');
    queueDialog('showOpenDialog', { canceled: false, filePaths: [folder] });
    expect(await invoke<string | null>(IPC.mcp.pickLocalRepository)).toBe(folder);

    queueDialog('showOpenDialog', { canceled: true, filePaths: [] });
    expect(await invoke<string | null>(IPC.mcp.pickLocalRepository)).toBeNull();
  });
});

describe('installing a server into a project', () => {
  it('writes the entry into .mcp.json and records the install', async () => {
    const repo = await addLocalRepository();
    await invoke(IPC.mcp.install, {
      projectId: PROJECT_ID,
      repositoryId: repo.id,
      serverId: 'weather',
      env: { WEATHER_API_KEY: 'k-123' },
    });

    expect(mcpJson().mcpServers?.weather).toEqual({
      command: 'npx',
      args: ['-y', 'weather-mcp'],
      // The value the user typed is merged over the defaults the directory ships.
      env: { WEATHER_REGION: 'eu', WEATHER_API_KEY: 'k-123' },
    });

    const installed = await invoke<InstalledMcpServerRecord[]>(IPC.mcp.listInstalled, PROJECT_ID);
    expect(installed).toEqual([
      expect.objectContaining({ serverId: 'weather', repositoryId: repo.id, version: '1.2.0' }),
    ]);
    // The record lives in the project folder, beside the config it describes.
    expect(existsSync(join(project.dir, '.runova', 'installed-mcp-servers.json'))).toBe(true);
  });

  it('keeps other servers and other keys in an existing .mcp.json', async () => {
    writeFileSync(
      join(project.dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { existing: { command: 'node' } }, somethingElse: true }),
      'utf-8',
    );
    const repo = await addLocalRepository();
    await invoke(IPC.mcp.install, {
      projectId: PROJECT_ID,
      repositoryId: repo.id,
      serverId: 'weather',
    });

    const config = mcpJson() as { somethingElse?: boolean; mcpServers?: Record<string, unknown> };
    expect(Object.keys(config.mcpServers ?? {}).sort()).toEqual(['existing', 'weather']);
    expect(config.somethingElse).toBe(true);
  });

  it('replaces the record rather than listing the same server twice', async () => {
    const repo = await addLocalRepository();
    const install = () =>
      invoke(IPC.mcp.install, {
        projectId: PROJECT_ID,
        repositoryId: repo.id,
        serverId: 'weather',
      });
    await install();
    await install();
    expect(
      await invoke<InstalledMcpServerRecord[]>(IPC.mcp.listInstalled, PROJECT_ID),
    ).toHaveLength(1);
  });

  it('writes a url entry for a server that is not stdio', async () => {
    const source = localRepoFolder({
      name: 'Remote servers',
      servers: [
        {
          id: 'hosted',
          name: 'Hosted',
          description: '',
          category: 'data',
          tags: [],
          author: 'Runova',
          version: '2.0.0',
          official: true,
          popularity: 1,
          requiredEnv: [],
          config: { transport: 'http', url: 'https://mcp.example.test/v1', args: [], env: {} },
        },
      ],
    });
    const repo = await addLocalRepository(source);
    await invoke(IPC.mcp.install, {
      projectId: PROJECT_ID,
      repositoryId: repo.id,
      serverId: 'hosted',
    });
    expect(mcpJson().mcpServers?.hosted).toEqual({
      type: 'http',
      url: 'https://mcp.example.test/v1',
    });
  });

  it('refuses an unknown project, repository or server', async () => {
    const repo = await addLocalRepository();
    await expect(
      invoke(IPC.mcp.install, { projectId: 'gone', repositoryId: repo.id, serverId: 'weather' }),
    ).rejects.toThrow('Project gone not found');
    await expect(
      invoke(IPC.mcp.install, {
        projectId: PROJECT_ID,
        repositoryId: 'gone',
        serverId: 'weather',
      }),
    ).rejects.toThrow('Repository gone not found');
    await expect(
      invoke(IPC.mcp.install, { projectId: PROJECT_ID, repositoryId: repo.id, serverId: 'gone' }),
    ).rejects.toThrow('MCP server gone not found');
    await expect(invoke(IPC.mcp.listInstalled, 'gone')).rejects.toThrow('Project gone not found');
    await expect(
      invoke(IPC.mcp.remove, { projectId: 'gone', serverId: 'weather' }),
    ).rejects.toThrow('Project gone not found');
  });

  it('removes the server from the config and the record', async () => {
    const repo = await addLocalRepository();
    await invoke(IPC.mcp.install, {
      projectId: PROJECT_ID,
      repositoryId: repo.id,
      serverId: 'weather',
    });
    await invoke(IPC.mcp.remove, { projectId: PROJECT_ID, serverId: 'weather' });

    expect(mcpJson().mcpServers).toEqual({});
    expect(await invoke<InstalledMcpServerRecord[]>(IPC.mcp.listInstalled, PROJECT_ID)).toEqual([]);
  });

  it('is a no-op when the project has nothing installed yet', async () => {
    await invoke(IPC.mcp.remove, { projectId: PROJECT_ID, serverId: 'weather' });
    expect(existsSync(join(project.dir, '.mcp.json'))).toBe(false);
    expect(await invoke<InstalledMcpServerRecord[]>(IPC.mcp.listInstalled, PROJECT_ID)).toEqual([]);
  });
});
